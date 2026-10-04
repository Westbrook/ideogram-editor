#!/usr/bin/env python3
"""Real observer/Scan controls with injected time and metadata, never wall sleeps."""
import errno
import hashlib
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
        self.assertEqual(first['errors'], [{'code': 'EVIDENCE_MUTATION', 'path': '/capsule/payload', 'errno': None, 'mutation': {'category': 'child-after-walk-stat', 'statChanges': [{'field': 'st_size', 'before': '1', 'after': '2'}]}}])
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


    def test_stat_failure_categories_use_existing_reads_and_close_handles(self):
        for category in ('directory-entry-stat','directory-final-stat','root-final-stat'):
            with self.subTest(category=category):
                clock=Clock()
                class Changed(Filesystem):
                    directory_reads=0
                    root_reads=0
                    def stat_directory(self, descriptor):
                        self.directory_reads+=1
                        value=stamp(11,directory=True)
                        if (category=='directory-entry-stat' and self.directory_reads==1) or (category=='directory-final-stat' and self.directory_reads==2):value.st_ctime_ns=2
                        return value
                    def root_stat(self):
                        self.root_reads+=1
                        value=stamp(11,directory=True)
                        if category=='root-final-stat' and self.root_reads%2==0:value.st_mtime_ns=-2
                        return value
                fs=Changed(clock);request=self.request()
                scan=observer.Scan(request,fs,clock,observer.MAX_WINDOW_US)
                with self.assertRaises(observer.ObservationError) as caught:scan.run()
                error=caught.exception.record
                field='st_mtime_ns' if category=='root-final-stat' else 'st_ctime_ns'
                self.assertEqual(error['mutation'],{'category':category,'statChanges':[{'field':field,'before':'1','after':'-2' if category=='root-final-stat' else '2'}]})
                self.assertEqual((fs.handles,fs.iterators,fs.opened,fs.closed),(0,0,1,1))
                self.assertEqual(fs.directory_reads,1 if category=='directory-entry-stat' else 2)
                self.assertEqual(fs.root_reads,2 if category=='root-final-stat' else 1)

    def test_inode_revisit_difference_is_distinct_from_child_recheck(self):
        clock=Clock()
        class Alias(Filesystem):
            def names(self, descriptor):
                yield 'first'
                yield 'second'
            def child_stat(self, descriptor, name):return stamp(12,size=1 if name=='first' else 2)
        fs=Alias(clock);value=self.observe(clock,fs)
        self.assertEqual(value['status'],'unknown')
        self.assertTrue(all(a['errors'][0]['mutation']=={'category':'inode-revisit-stat','statChanges':[{'field':'st_size','before':'1','after':'2'}]} for a in value['attempts']))
        self.assertEqual((fs.opened,fs.closed),(3,3));self.chain(value)

    def test_membership_and_digest_failures_do_not_invent_stat_differences_or_reread(self):
        for category in ('duplicate-directory-name','directory-membership','directory-children-digest'):
            with self.subTest(category=category):
                clock=Clock()
                class Changed(Filesystem):
                    enumerations=0
                    directory_reads=0
                    def names(self, descriptor):
                        self.enumerations+=1
                        yield 'payload'
                        if category=='duplicate-directory-name' or (category=='directory-membership' and self.enumerations==2):yield 'payload' if category=='duplicate-directory-name' else 'new'
                    def child_stat(self, descriptor, name):
                        self.child_reads+=1
                        return stamp(12,size=2 if category=='directory-children-digest' and self.child_reads==3 else 1)
                    def stat_directory(self, descriptor):
                        self.directory_reads+=1
                        return self.root
                fs=Changed(clock);scan=observer.Scan(self.request(),fs,clock,observer.MAX_WINDOW_US)
                with self.assertRaises(observer.ObservationError) as caught:scan.run()
                self.assertEqual(caught.exception.record['mutation'],{'category':category,'statChanges':None})
                self.assertEqual(fs.directory_reads,1)
                self.assertEqual(fs.child_reads,{'duplicate-directory-name':0,'directory-membership':2,'directory-children-digest':3}[category])
                self.assertEqual((fs.handles,fs.opened,fs.closed),(0,1,1))

    def test_mutating_io_records_only_category_and_original_errno(self):
        for enumeration in (False,True):
            with self.subTest(enumeration=enumeration):
                clock=Clock()
                class Missing(Filesystem):
                    def names(self, descriptor):
                        if enumeration:raise OSError(errno.ESTALE,'secret-error-text')
                        yield 'payload'
                fs=Missing(clock,child_error=errno.ENOENT);value=self.observe(clock,fs)
                error=value['attempts'][0]['errors'][0]
                self.assertEqual(error['errno'],errno.ESTALE if enumeration else errno.ENOENT)
                self.assertEqual(error['mutation'],{'category':'directory-enumeration' if enumeration else 'filesystem-operation','statChanges':None})
                self.assertNotIn('secret-error-text',json.dumps(value));self.assertEqual((fs.handles,fs.opened,fs.closed),(0,3,3));self.chain(value)

    def test_stat_detail_is_bounded_to_ten_actual_numeric_fields(self):
        clock=Clock()
        class AllFields(Filesystem):
            def child_stat(self, descriptor, name):
                self.child_reads+=1
                value=stamp(12)
                if self.child_reads%2==0:
                    for field in observer.STAT_FIELDS:setattr(value,field,getattr(value,field)+1)
                    value.st_mtime_ns=-(2**63);value.st_ctime_ns=2**63-1
                return value
        fs=AllFields(clock);value=self.observe(clock,fs)
        self.assertEqual((len(value['attempts']),value['selectedAttempt'],value['status']),(3,None,'unknown'))
        for attempt in value['attempts']:
            detail=attempt['errors'][0]['mutation'];self.assertEqual(detail['category'],'child-after-walk-stat')
            self.assertEqual([row['field'] for row in detail['statChanges']],list(observer.STAT_FIELDS))
            self.assertTrue(all(type(row['before']) is str and type(row['after']) is str and len(row['after'])<=20 for row in detail['statChanges']))
        self.assertLess(len(observer.canonical(value)),observer.MAX_OUTPUT_BYTES);self.chain(value)

    def test_diagnostic_construction_failure_preserves_original_refusal_and_drain(self):
        clock,fs=self.fixture(persistent=True)
        original=observer.mutation_error
        def unavailable(path,category,before=None,after=None,number=None):
            with patch.object(observer,'STAT_FIELDS',None):return original(path,category,before,after,number)
        with patch.object(observer,'mutation_error',side_effect=unavailable):value=self.observe(clock,fs)
        self.assertTrue(all(a['errors']==[{'code':'EVIDENCE_MUTATION','path':'/capsule/payload','errno':None}] for a in value['attempts']))
        self.assertEqual((value['status'],len(value['attempts']),fs.handles,fs.closed),('unknown',3,0,3));self.chain(value)

    def test_diagnostic_cost_remains_inside_original_window(self):
        clock,fs=self.fixture(persistent=True);original=observer.mutation_error
        def slow(*args,**kwargs):
            error=original(*args,**kwargs);clock.now+=1_000_000;return error
        with patch.object(observer,'mutation_error',side_effect=slow):value=self.observe(clock,fs)
        self.assertEqual((value['status'],value['selectedAttempt'],len(value['attempts']),clock.sleeps),('unknown',None,1,[]))
        self.assertEqual(value['windowEndMonotonicUs'],1_030_000)
        self.assertEqual((fs.handles,fs.closed),(0,1));self.chain(value)




    def test_valid_stat_tuple_canonical_bytes_and_digest_match_list_for_actual_names(self):
        names = ['payload', 'snow-雪', 'quote"-slash\\-line\n', 'x' * 255,
                 b'raw-\xff-name'.decode('utf-8', 'surrogateescape')]
        shapes = [stamp(12), stamp(13, directory=True), stamp(14)]
        shapes[2].st_mode = stat.S_IFLNK | 0o777
        low = stamp(1)
        low.st_dev = low.st_uid = low.st_gid = low.st_size = low.st_blocks = 0
        low.st_mtime_ns, low.st_ctime_ns = -(2 ** 63), 2 ** 63 - 1
        high = stamp(observer.MAX_INTEGER)
        for field in ('st_dev', 'st_uid', 'st_gid', 'st_nlink', 'st_size'):
            setattr(high, field, observer.MAX_INTEGER)
        high.st_blocks = observer.MAX_INTEGER // 512
        high.st_mtime_ns, high.st_ctime_ns = 2 ** 63 - 1, -(2 ** 63)
        for name in names:
            for shape in [*shapes, low, high]:
                with self.subTest(name=ascii(name), mode=shape.st_mode):
                    value = observer.stat_value(shape, '/capsule/parity')
                    self.assertIs(type(value), tuple)
                    self.assertEqual(len(value), 10)
                    prior = [name, list(value)]
                    current = [name, value]
                    expected = json.dumps(prior, sort_keys=True, separators=(',', ':'),
                                          ensure_ascii=True, allow_nan=False).encode('ascii')
                    self.assertEqual(observer.canonical(current), expected)
                    self.assertEqual(observer.canonical(current), observer.canonical(prior))
                    self.assertEqual(observer.digest(current), observer.digest(prior))
                    self.assertEqual(observer.digest(current), 'sha256:' + hashlib.sha256(expected).hexdigest())
        self.assertIn(b'\\udcff', observer.canonical([names[-1], observer.stat_value(low, '/capsule/parity')]))

    def test_real_scan_keeps_tuple_inputs_and_all_filesystem_observations(self):
        clock = Clock()
        trace = []
        class Traced(Filesystem):
            def root_stat(self): trace.append('root_stat'); return super().root_stat()
            def open_root(self): trace.append('open_root'); return super().open_root()
            def stat_directory(self, descriptor): trace.append('stat_directory'); return super().stat_directory(descriptor)
            def names(self, descriptor): trace.append('names'); return super().names(descriptor)
            def child_stat(self, descriptor, name): trace.append('child_stat'); return super().child_stat(descriptor, name)
            def close_directory(self, descriptor): trace.append('close_directory'); return super().close_directory(descriptor)
        fs = Traced(clock)
        inputs = []
        original = observer.canonical
        def capture(value):
            inputs.append(value)
            return original(value)
        with patch.object(observer, 'canonical', side_effect=capture):
            counts = observer.Scan(self.request(), fs, clock, observer.MAX_WINDOW_US).run()
        self.assertEqual(trace, ['root_stat', 'open_root', 'stat_directory', 'names',
                                 'child_stat', 'child_stat', 'names', 'child_stat',
                                 'stat_directory', 'root_stat', 'close_directory'])
        self.assertEqual(len(inputs), 2)
        self.assertTrue(all(value[0] == 'payload' and type(value[1]) is tuple for value in inputs))
        self.assertEqual(inputs[0], inputs[1])
        self.assertEqual(counts['allocatedBytes'], 4608)
        self.assertEqual((fs.child_reads, fs.handles, fs.iterators, fs.opened, fs.closed), (3, 0, 0, 1, 1))
        self.assertEqual(clock.sleeps, [])

    def test_tuple_membership_digest_preserves_each_changed_stat_field_refusal(self):
        for field in observer.STAT_FIELDS:
            with self.subTest(field=field):
                clock = Clock()
                class Changed(Filesystem):
                    def child_stat(self, descriptor, name):
                        value = super().child_stat(descriptor, name)
                        if self.child_reads == 3:
                            setattr(value, field, getattr(value, field) + 1)
                        return value
                fs = Changed(clock)
                with self.assertRaises(observer.ObservationError) as caught:
                    observer.Scan(self.request(), fs, clock, observer.MAX_WINDOW_US).run()
                self.assertEqual(caught.exception.record['code'], 'EVIDENCE_MUTATION')
                self.assertEqual(caught.exception.record['mutation'],
                                 {'category': 'directory-children-digest', 'statChanges': None})
                self.assertEqual((fs.child_reads, fs.handles, fs.iterators, fs.opened, fs.closed), (3, 0, 0, 1, 1))
                self.assertEqual(clock.sleeps, [])


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
