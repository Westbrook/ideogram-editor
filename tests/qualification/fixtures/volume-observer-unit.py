#!/usr/bin/env python3
"""Real observer/Scan controls with injected time and metadata, never wall sleeps."""
import errno
import importlib.util
import json
from pathlib import Path
import stat
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch


class Clock:
    def __init__(self, advances=(), oversleep=0, wall_step=0, finalize_advance=0, sleep_error=None):
        self.now = 0
        self.sleeps = []
        self.advances = list(advances)
        self.oversleep = oversleep
        self.wall_step = wall_step
        self.finalize_advance = finalize_advance
        self.sleep_error = sleep_error
        self.wall_calls = 0
        self.before_sleep = lambda: None

    def monotonic_us(self):
        return self.now

    def wall_us(self):
        self.wall_calls += 1
        if self.wall_calls == 3:
            self.now += self.finalize_advance
        return 10_000_000 + self.now + self.wall_calls * self.wall_step

    def sleep_us(self, duration):
        assert type(duration) is int and duration > 0
        self.before_sleep()
        self.sleeps.append(duration)
        if self.sleep_error is not None:
            raise self.sleep_error
        self.now += self.advances.pop(0) if self.advances else duration + self.oversleep


def stamp(inode, directory=False, size=1, uid=1001):
    return SimpleNamespace(st_dev=7, st_ino=inode,
                           st_mode=(stat.S_IFDIR | 0o700) if directory else (stat.S_IFREG | 0o600),
                           st_uid=uid, st_gid=1001, st_nlink=1, st_size=size,
                           st_blocks=8 if directory else 1, st_mtime_ns=1, st_ctime_ns=1)


class Filesystem:
    """One root and one file; real Scan detects changing metadata on repeated stat."""
    def __init__(self, clock, duration=30_000, settle_at=0, persistent=False,
                 child_error=None, close_error=False, wrong_owner=False):
        self.clock = clock
        self.duration = duration
        self.settle_at = settle_at
        self.persistent = persistent
        self.child_error = child_error
        self.close_error = close_error
        self.root = stamp(11, directory=True, uid=1002 if wrong_owner else 1001)
        self.opened = self.handles = self.iterators = self.closed = self.child_reads = 0
        self.close_times = []

    def root_stat(self):
        return self.root

    def open_root(self):
        self.opened += 1
        self.handles += 1
        self.child_reads = 0
        self.clock.now += self.duration
        return self.opened

    def stat_directory(self, descriptor):
        assert self.handles == 1 and descriptor == self.opened
        return self.root

    def names(self, descriptor):
        assert self.handles == 1 and descriptor == self.opened
        self.iterators += 1
        try:
            yield 'payload'
        finally:
            self.iterators -= 1

    def child_stat(self, descriptor, name):
        assert self.handles == 1 and descriptor == self.opened and name == 'payload'
        if self.child_error is not None:
            raise OSError(self.child_error, 'injected metadata failure')
        self.child_reads += 1
        mutating = self.persistent or self.clock.now < self.settle_at
        return stamp(12, size=(1 if self.child_reads % 2 else 2) if mutating else 1)

    def close_directory(self, descriptor):
        assert self.handles == 1 and descriptor == self.opened and self.iterators == 0
        if self.close_error:
            raise OSError(errno.EIO, 'injected close failure')
        self.handles -= 1
        self.closed += 1
        self.close_times.append(self.clock.now)


class Controls(unittest.TestCase):
    delayed_observation = None

    def request(self):
        return {'kind': 'capsule-volume-request-1', 'mode': 'sample', 'ownerUid': 1001,
                'ownerGid': 1001, 'rootIdentity': {'dev': 7, 'ino': 11},
                'policyId': observer.POLICY_ID}

    def fixture(self, clock=None, **options):
        clock = clock or Clock()
        fs = Filesystem(clock, **options)
        def drained():
            self.assertEqual((fs.handles, fs.iterators), (0, 0))
            self.assertEqual(fs.opened, fs.closed)
        clock.before_sleep = drained
        return clock, fs

    def observe(self, clock, fs):
        return observer.observe(self.request(), filesystem=fs, clock=clock)

    def chain(self, value):
        previous = None
        self.assertEqual(value['requestHash'], observer.digest(value['request']))
        self.assertEqual(value['bounds'], {'maxEntries': 1000000, 'maxDepth': 128,
                                         'maxAttempts': 3, 'maxWindowUs': 1000000})
        for index, attempt in enumerate(value['attempts']):
            body = {key: val for key, val in attempt.items() if key != 'hash'}
            self.assertEqual((attempt['sequence'], attempt['previous']), (index, previous))
            self.assertEqual(attempt['hash'], observer.digest(body))
            previous = attempt['hash']

    def test_stable_first_scan_has_no_sleep(self):
        clock, fs = self.fixture()
        value = self.observe(clock, fs)
        self.assertEqual((value['status'], value['selectedAttempt'], clock.sleeps), ('complete', 0, []))
        self.assertEqual(value['attempts'][0]['counts']['allocatedBytes'], 4608)
        self.assertEqual((fs.opened, fs.closed, fs.handles, fs.iterators), (1, 1, 0, 0))
        self.chain(value)

    def test_real_mutation_burst_settles_between_spaced_attempts(self):
        # Immediate attempts at 0/30/60ms all encounter this 120ms burst. The
        # bounded retry at130ms sees stable metadata through the real scanner.
        clock, fs = self.fixture(settle_at=120_000)
        value = self.observe(clock, fs)
        self.assertEqual(clock.sleeps, [100_000])
        self.assertEqual([a['startMonotonicUs'] for a in value['attempts']], [0, 130_000])
        self.assertEqual([a['endMonotonicUs'] for a in value['attempts']], [30_000, 160_000])
        first, second = value['attempts']
        self.assertEqual((first['status'], first['counts'], first['drained']), ('unknown', None, True))
        self.assertEqual(first['errors'], [{'code': 'EVIDENCE_MUTATION', 'path': '/capsule/payload', 'errno': None}])
        self.assertEqual((value['status'], value['selectedAttempt'], second['counts']['allocatedBytes']), ('complete', 1, 4608))
        self.assertEqual((value['windowStartMonotonicUs'], value['windowEndMonotonicUs']), (0, 160_000))
        self.assertEqual((fs.opened, fs.closed), (2, 2))
        self.chain(value)
        Controls.delayed_observation = value

    def test_persistent_mutation_still_refuses_after_three_attempts(self):
        clock, fs = self.fixture(persistent=True)
        value = self.observe(clock, fs)
        self.assertEqual(clock.sleeps, [100_000, 100_000])
        self.assertEqual([a['startMonotonicUs'] for a in value['attempts']], [0, 130_000, 260_000])
        self.assertEqual((value['status'], value['selectedAttempt'], value['drained']), ('unknown', None, True))
        self.assertEqual(value['windowEndMonotonicUs'], 290_000)
        self.assertTrue(all(a['counts'] is None and a['errors'][0]['code'] == 'EVIDENCE_MUTATION' for a in value['attempts']))
        self.assertEqual((fs.opened, fs.closed), (3, 3))
        self.chain(value)

    def test_early_wakeup_rechecks_actual_remaining_monotonic_time(self):
        clock, fs = self.fixture(Clock(advances=[40_000, 60_000]), settle_at=120_000)
        value = self.observe(clock, fs)
        self.assertEqual(clock.sleeps, [100_000, 60_000])
        self.assertEqual(value['attempts'][1]['startMonotonicUs'], 130_000)
        self.assertEqual(value['status'], 'complete')

    def test_zero_progress_wakeup_does_not_issue_an_early_scan(self):
        clock, fs = self.fixture(Clock(advances=[0, 100_000]), settle_at=120_000)
        value = self.observe(clock, fs)
        self.assertEqual(clock.sleeps, [100_000, 100_000])
        self.assertEqual([a['startMonotonicUs'] for a in value['attempts']], [0, 130_000])
        self.assertEqual(fs.opened, 2)

    def test_sleep_clips_to_original_window_and_admits_no_deadline_retry(self):
        clock, fs = self.fixture(duration=950_000, persistent=True)
        value = self.observe(clock, fs)
        self.assertEqual(clock.sleeps, [50_000])
        self.assertEqual((value['windowEndMonotonicUs'], len(value['attempts']), fs.opened), (1_000_000, 1, 1))
        self.assertEqual((value['status'], value['selectedAttempt']), ('unknown', None))

    def test_oversleep_cannot_extend_retry_admission_or_acceptance(self):
        clock, fs = self.fixture(Clock(oversleep=1_000_000), settle_at=120_000)
        value = self.observe(clock, fs)
        self.assertEqual(clock.sleeps, [100_000])
        self.assertEqual((value['windowEndMonotonicUs'], fs.opened), (1_130_000, 1))
        self.assertEqual((value['status'], value['selectedAttempt']), ('unknown', None))

    def test_mutation_at_deadline_does_not_sleep_or_retry(self):
        clock, fs = self.fixture(duration=1_000_000, persistent=True)
        value = self.observe(clock, fs)
        self.assertEqual((clock.sleeps, fs.opened), ([], 1))
        self.assertEqual((value['status'], value['selectedAttempt']), ('unknown', None))
        self.assertEqual(value['attempts'][0]['errors'][0]['code'], 'EVIDENCE_MUTATION')

    def test_nonmutation_filesystem_error_has_no_retry(self):
        clock, fs = self.fixture(child_error=errno.EACCES)
        value = self.observe(clock, fs)
        self.assertEqual((clock.sleeps, fs.opened, fs.closed), ([], 1, 1))
        self.assertEqual(value['attempts'][0]['errors'], [{'code': 'FILESYSTEM_ERROR', 'path': '/capsule/payload', 'errno': errno.EACCES}])
        self.assertEqual((value['status'], value['selectedAttempt']), ('unknown', None))

    def test_failed_drain_preserves_failure_and_never_sleeps_or_retries(self):
        clock, fs = self.fixture(persistent=True, close_error=True)
        value = self.observe(clock, fs)
        self.assertEqual((clock.sleeps, fs.opened, fs.closed), ([], 1, 0))
        self.assertEqual((value['status'], value['selectedAttempt'], value['drained']), ('unknown', None, False))
        self.assertEqual([e['code'] for e in value['attempts'][0]['errors']], ['EVIDENCE_MUTATION', 'DRAIN_UNPROVEN'])

    def test_complete_first_scan_exactly_at_deadline_remains_accepted(self):
        clock, fs = self.fixture(duration=1_000_000)
        value = self.observe(clock, fs)
        self.assertEqual((value['status'], value['selectedAttempt'], value['windowEndMonotonicUs']), ('complete', 0, 1_000_000))
        self.assertEqual(clock.sleeps, [])

    def test_late_record_finalization_still_withholds_selection(self):
        clock, fs = self.fixture(Clock(finalize_advance=1), duration=1_000_000)
        value = self.observe(clock, fs)
        self.assertEqual(value['attempts'][0]['status'], 'complete')
        self.assertEqual(value['attempts'][0]['counts']['allocatedBytes'], 4608)
        self.assertEqual((value['windowEndMonotonicUs'], value['status'], value['selectedAttempt']), (1_000_001, 'unknown', None))
        self.assertEqual(clock.sleeps, [])

    def test_wall_clock_changes_do_not_control_retry_budget(self):
        clock, fs = self.fixture(Clock(wall_step=-1_000_000), settle_at=120_000)
        value = self.observe(clock, fs)
        self.assertEqual(clock.sleeps, [100_000])
        self.assertLess(value['windowEndWallUs'], value['windowStartWallUs'])
        self.assertEqual((value['status'], value['windowEndMonotonicUs']), ('complete', 160_000))

    def test_sleep_failure_propagates_only_after_prior_scan_is_drained(self):
        clock, fs = self.fixture(Clock(sleep_error=OSError(errno.EIO, 'injected sleep failure')), persistent=True)
        with self.assertRaisesRegex(OSError, 'injected sleep failure'):
            self.observe(clock, fs)
        self.assertEqual((fs.opened, fs.closed, fs.handles, fs.iterators), (1, 1, 0, 0))
        self.assertEqual(clock.sleeps, [100_000])

    def test_invalid_request_never_starts_scan_or_sleep(self):
        clock, fs = self.fixture()
        request = self.request(); request['policyId'] = 'unissued'
        with self.assertRaises(observer.ObservationError) as error:
            observer.observe(request, filesystem=fs, clock=clock)
        self.assertEqual(error.exception.record['code'], 'REQUEST_POLICY')
        self.assertEqual((fs.opened, clock.sleeps), (0, []))

    def test_root_owner_refusal_is_not_retried(self):
        clock, fs = self.fixture(wrong_owner=True)
        value = self.observe(clock, fs)
        self.assertEqual(value['attempts'][0]['errors'][0]['code'], 'ROOT_OWNER_MODE')
        self.assertEqual((value['status'], value['selectedAttempt'], fs.opened, clock.sleeps), ('unknown', None, 0, []))

    def test_production_clock_sleep_uses_requested_microseconds(self):
        with patch.object(observer.time, 'sleep') as sleep:
            observer.Clock().sleep_us(1234)
        sleep.assert_called_once_with(0.001234)


if __name__ == '__main__':
    assert sys.flags.isolated and sys.flags.no_site and sys.dont_write_bytecode and not sys.flags.optimize
    assert len(sys.argv) == 2
    spec = importlib.util.spec_from_file_location('volume_observer_under_test', Path(sys.argv[1]))
    observer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(observer)
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(Controls)
    result = unittest.TextTestRunner(stream=sys.stderr, verbosity=1).run(suite)
    print(json.dumps({'tests': result.testsRun, 'failures': len(result.failures),
                      'errors': len(result.errors), 'delayedObservation': Controls.delayed_observation}))
    raise SystemExit(0 if result.wasSuccessful() else 1)
