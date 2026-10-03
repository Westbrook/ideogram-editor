#!/usr/bin/env python3
"""Read-only /capsule inode accounting. No content reads, writes, or sockets.

The caller authenticates the Docker volume/image/mount and owns process drainage.
This observer is a bounded observational scan, not an atomic filesystem snapshot.
"""
import errno
import hashlib
import json
import os
import stat
import sys
import time

ROOT = '/capsule'
POLICY_ID = 'capsule-allocated-inodes-1'
MAX_ENTRIES = 1_000_000
MAX_DEPTH = 128
MAX_ATTEMPTS = 3
MAX_WINDOW_US = 1_000_000
MAX_INTEGER = 9_007_199_254_740_991
MAX_REQUEST_BYTES = 16_384
MAX_OUTPUT_BYTES = 65_536
MAX_ERROR_PATH_CHARS = 64
INITIAL_DIRECTORIES = frozenset(('home', 'tmp', 'toolchain', 'toolchain/tooling', 'workspaces', 'outputs'))
STAT_FIELDS = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink', 'st_size', 'st_blocks', 'st_mtime_ns', 'st_ctime_ns')


def error_path(path):
    return str(path).encode('ascii', 'backslashreplace').decode('ascii')[:MAX_ERROR_PATH_CHARS]


class ObservationError(Exception):
    def __init__(self, code, path=ROOT, number=None):
        super().__init__(code)
        self.record = {'code': code, 'path': error_path(path), 'errno': number}



def mutation_error(path, category, before=None, after=None, number=None):
    # Failure-only detail from already-read, validated tuples. No filesystem
    # re-read, payload/name retention, extra inventory or deadline exclusion.
    error = ObservationError('EVIDENCE_MUTATION', path, number)
    try:
        changes = None if before is None or after is None else [
            {'field': field, 'before': str(left), 'after': str(right)}
            for field, left, right in zip(STAT_FIELDS, before, after) if left != right]
        error.record['mutation'] = {'category': category, 'statChanges': changes}
    except Exception:
        # Diagnostic construction must not replace the original refusal.
        pass
    return error


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True, allow_nan=False).encode('ascii')


def digest(value):
    return 'sha256:' + hashlib.sha256(canonical(value)).hexdigest()


def integer(value, minimum=0, maximum=MAX_INTEGER):
    return type(value) is int and minimum <= value <= maximum


def exact(value, keys):
    return type(value) is dict and set(value) == set(keys)


def validate_request(value):
    if not exact(value, ('kind', 'mode', 'ownerUid', 'ownerGid', 'rootIdentity', 'policyId')):
        raise ObservationError('REQUEST_SCHEMA')
    if value['kind'] != 'capsule-volume-request-1' or value['policyId'] != POLICY_ID or value['mode'] not in ('initial-empty', 'initialize', 'sample'):
        raise ObservationError('REQUEST_POLICY')
    if not integer(value['ownerUid'], 1, 4_294_967_294) or not integer(value['ownerGid'], 1, 4_294_967_294):
        raise ObservationError('REQUEST_OWNER')
    identity = value['rootIdentity']
    if value['mode'] == 'initial-empty':
        if identity is not None:
            raise ObservationError('REQUEST_ROOT')
    elif not exact(identity, ('dev', 'ino')) or not integer(identity['dev']) or not integer(identity['ino'], 1):
        raise ObservationError('REQUEST_ROOT')
    return value


def parse_request(raw):
    try:
        size = len(raw.encode('utf-8'))
    except UnicodeError as error:
        raise ObservationError('REQUEST_JSON') from error
    if size > MAX_REQUEST_BYTES:
        raise ObservationError('REQUEST_SIZE')
    def pairs(rows):
        result = {}
        for key, value in rows:
            if key in result:
                raise ObservationError('REQUEST_DUPLICATE')
            result[key] = value
        return result
    try:
        value = json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(ObservationError('REQUEST_NUMBER')))
    except (ValueError, RecursionError, UnicodeError) as error:
        raise ObservationError('REQUEST_JSON') from error
    return validate_request(value)


class Clock:
    def monotonic_us(self):
        return time.monotonic_ns() // 1000

    def wall_us(self):
        return time.time_ns() // 1000

    def sleep_us(self, duration_us):
        time.sleep(duration_us / 1_000_000)


class Filesystem:
    """Only directory FDs are opened; symlinks receive lstat only."""
    def root_stat(self):
        return os.stat(ROOT, follow_symlinks=False)

    def open_root(self):
        return os.open(ROOT, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)

    def open_directory(self, parent, name):
        return os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)

    def stat_directory(self, descriptor):
        return os.fstat(descriptor)

    def child_stat(self, descriptor, name):
        return os.stat(name, dir_fd=descriptor, follow_symlinks=False)

    def names(self, descriptor):
        # The generator's finally closes scandir even when a caller rejects a row.
        entries = os.scandir(descriptor)
        try:
            for entry in entries:
                yield entry.name
        finally:
            try:
                entries.close()
            except OSError as error:
                raise ObservationError('DRAIN_UNPROVEN', ROOT, error.errno) from error

    def close_directory(self, descriptor):
        os.close(descriptor)


def stat_value(value, path):
    result = []
    for field in STAT_FIELDS:
        item = getattr(value, field, None)
        # Timestamp nanoseconds are internal Python integers, encoded as decimal
        # strings if retained. Counts/identities must also be exactly safe in JS.
        if field in ('st_mtime_ns', 'st_ctime_ns'):
            valid = type(item) is int and -(2 ** 63) <= item < 2 ** 63
        else:
            valid = integer(item, 1 if field in ('st_ino', 'st_nlink') else 0)
        if not valid:
            raise ObservationError('STAT_INVALID', path)
        result.append(item)
    if result[7] > MAX_INTEGER // 512:
        raise ObservationError('COUNT_OVERFLOW', path)
    if stat.S_IFMT(result[2]) not in (stat.S_IFDIR, stat.S_IFREG, stat.S_IFLNK):
        raise ObservationError('SPECIAL_FILE', path)
    return tuple(result)


def root_record(stamp):
    return dict(zip(('dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'blocks', 'mtimeNs', 'ctimeNs'),
                    stamp[:8] + (str(stamp[8]), str(stamp[9]))))


def io_error(error, path, category='filesystem-operation'):
    mutation = error.errno in (errno.ENOENT, errno.ESTALE, errno.ENOTDIR, errno.ELOOP)
    return mutation_error(path, category, number=error.errno) if mutation else ObservationError('FILESYSTEM_ERROR', path, error.errno)


class Scan:
    def __init__(self, request, filesystem, clock, deadline_us):
        self.request, self.fs, self.clock, self.deadline = request, filesystem, clock, deadline_us
        self.root_before = self.root_after = None
        self.handles = 0
        self.close_errors = []
        self.inodes = {}
        self.enumerated_names = 0
        self.counts = {'entries': 0, 'uniqueInodes': 0, 'directories': 0, 'regularFiles': 0, 'symlinks': 0,
                       'allocatedBytes': 0, 'regularLogicalBytes': 0, 'symlinkAllocatedBytes': 0}

    def check(self):
        if self.close_errors:
            raise ObservationError('DRAIN_UNPROVEN')
        if self.clock.monotonic_us() > self.deadline:
            raise ObservationError('WINDOW_EXCEEDED')

    def call(self, method, path, *args):
        self.check()
        try:
            return method(*args)
        except OSError as error:
            raise io_error(error, path) from error

    def read_stat(self, method, path, *args):
        return stat_value(self.call(method, path, *args), path)

    def close(self, descriptor, path):
        try:
            self.fs.close_directory(descriptor)
            self.handles -= 1
        except OSError as error:
            # A failed close is never retried on the same numeric descriptor;
            # Linux may already have released it. The owner must drain the process.
            self.close_errors.append({'code': 'DRAIN_UNPROVEN', 'path': error_path(path), 'errno': error.errno})

    def root_policy(self, stamp):
        if not stat.S_ISDIR(stamp[2]):
            raise ObservationError('ROOT_TYPE')
        identity = self.request['rootIdentity']
        if identity is not None and (stamp[0], stamp[1]) != (identity['dev'], identity['ino']):
            raise ObservationError('ROOT_IDENTITY')
        owner = (stamp[3], stamp[4], stat.S_IMODE(stamp[2]))
        selected = (self.request['ownerUid'], self.request['ownerGid'])
        allowed = {'initial-empty': {(0, 0, 0o755)},
                   'initialize': {(0, 0, 0o755), (*selected, 0o755), (*selected, 0o700)},
                   'sample': {(*selected, 0o700)}}[self.request['mode']]
        if owner not in allowed:
            raise ObservationError('ROOT_OWNER_MODE')

    def account(self, stamp, path):
        self.counts['entries'] += 1
        if self.counts['entries'] > MAX_ENTRIES:
            raise ObservationError('ENTRY_BUDGET', path)
        if stamp[0] != self.root_before['dev']:
            raise ObservationError('DEVICE_BOUNDARY', path)
        key = stamp[:2]
        previous = self.inodes.get(key)
        if previous is not None:
            if previous != stamp:
                raise mutation_error(path, 'inode-revisit-stat', previous, stamp)
            if stat.S_ISDIR(stamp[2]):
                raise ObservationError('DIRECTORY_CYCLE', path)
            return
        self.inodes[key] = stamp
        self.counts['uniqueInodes'] += 1
        kind = 'directories' if stat.S_ISDIR(stamp[2]) else 'regularFiles' if stat.S_ISREG(stamp[2]) else 'symlinks'
        self.counts[kind] += 1
        self.counts['allocatedBytes'] += stamp[7] * 512
        if kind == 'regularFiles':
            self.counts['regularLogicalBytes'] += stamp[6]
        if kind == 'symlinks':
            self.counts['symlinkAllocatedBytes'] += stamp[7] * 512
        if any(value > MAX_INTEGER for value in self.counts.values()):
            raise ObservationError('COUNT_OVERFLOW', path)

    def names(self, descriptor, path):
        result = []
        iterator = self.fs.names(descriptor)
        try:
            for name in iterator:
                self.check()
                if type(name) is not str or not name or name in ('.', '..') or '/' in name or '\x00' in name:
                    raise ObservationError('ENTRY_NAME', path)
                if len(os.fsencode(name)) > 255:
                    raise ObservationError('ENTRY_NAME', path)
                # A global two-pass budget includes names discovered but not yet
                # visited. Ancestor lists therefore cannot each reserve a fresh
                # MAX_ENTRIES buffer before the global entry counter catches up.
                self.enumerated_names += 1
                if self.enumerated_names > 2 * (MAX_ENTRIES - 1):
                    raise ObservationError('ENTRY_BUDGET', path)
                result.append(name)
                if len(result) > MAX_ENTRIES:
                    raise ObservationError('ENTRY_BUDGET', path)
        except OSError as error:
            raise io_error(error, path, 'directory-enumeration') from error
        finally:
            iterator.close()
        result.sort()
        if len(result) != len(set(result)):
            raise mutation_error(path, 'duplicate-directory-name')
        return result

    def walk(self, descriptor, stamp, relative, depth):
        path = ROOT + ('/' + relative if relative else '')
        if depth > MAX_DEPTH:
            raise ObservationError('DEPTH_BUDGET', path)
        entered = self.read_stat(self.fs.stat_directory, path, descriptor)
        if entered != stamp:
            raise mutation_error(path, 'directory-entry-stat', stamp, entered)
        del entered
        before = self.names(descriptor, path)
        if self.request['mode'] == 'initial-empty' and before:
            raise ObservationError('INITIAL_NOT_EMPTY', path)
        membership = hashlib.sha256()
        for name in before:
            child_relative = relative + '/' + name if relative else name
            child_path = ROOT + '/' + child_relative
            child = self.read_stat(self.fs.child_stat, child_path, descriptor, name)
            if self.request['mode'] == 'initialize':
                if child_relative not in INITIAL_DIRECTORIES or not stat.S_ISDIR(child[2]):
                    raise ObservationError('INITIALIZATION_INVENTORY', child_path)
                if (child[3], child[4], stat.S_IMODE(child[2])) != (self.request['ownerUid'], self.request['ownerGid'], 0o700):
                    raise ObservationError('INITIALIZATION_OWNER_MODE', child_path)
            self.account(child, child_path)
            if stat.S_ISDIR(child[2]):
                if depth + 1 > MAX_DEPTH:
                    raise ObservationError('DEPTH_BUDGET', child_path)
                fd = self.call(self.fs.open_directory, child_path, descriptor, name)
                self.handles += 1
                try:
                    self.walk(fd, child, child_relative, depth + 1)
                finally:
                    self.close(fd, child_path)
            revisited = self.read_stat(self.fs.child_stat, child_path, descriptor, name)
            if revisited != child:
                raise mutation_error(child_path, 'child-after-walk-stat', child, revisited)
            del revisited
            membership.update(canonical([name, list(child)]))
        # The second full directory enumeration checks membership and all direct
        # identities again; no file content or link target is read at either pass.
        after = self.names(descriptor, path)
        if before != after:
            raise mutation_error(path, 'directory-membership')
        repeated = hashlib.sha256()
        for name in after:
            child_path = path + '/' + name
            repeated.update(canonical([name, list(self.read_stat(self.fs.child_stat, child_path, descriptor, name))]))
        if repeated.digest() != membership.digest():
            # Preserve the original short circuit: there is no final fstat here.
            # Aggregate identities cannot supply a particular changed field.
            raise mutation_error(path, 'directory-children-digest')
        final_directory = self.read_stat(self.fs.stat_directory, path, descriptor)
        if final_directory != stamp:
            raise mutation_error(path, 'directory-final-stat', stamp, final_directory)

    def run(self):
        initial = self.read_stat(self.fs.root_stat, ROOT)
        self.root_before = root_record(initial)
        self.root_policy(initial)
        self.account(initial, ROOT)
        fd = self.call(self.fs.open_root, ROOT)
        self.handles += 1
        try:
            self.walk(fd, initial, '', 0)
            final = self.read_stat(self.fs.root_stat, ROOT)
            self.root_after = root_record(final)
            self.root_policy(final)
            if final != initial:
                raise mutation_error(ROOT, 'root-final-stat', initial, final)
        finally:
            self.close(fd, ROOT)
        self.check()
        return dict(self.counts)


def observe(request, filesystem=None, clock=None):
    validate_request(request)
    filesystem, clock = filesystem or Filesystem(), clock or Clock()
    window_start, wall_start = clock.monotonic_us(), clock.wall_us()
    attempts, selected, previous = [], None, None
    for sequence in range(MAX_ATTEMPTS):
        if sequence:
            # Only a fully drained mutation reaches another attempt. Separate
            # scans inside the original window; the producer keeps running.
            retry_at = min(attempts[-1]['endMonotonicUs'] + 100_000,
                           window_start + MAX_WINDOW_US)
            while True:
                remaining = retry_at - clock.monotonic_us()
                if remaining <= 0:
                    break
                clock.sleep_us(remaining)
        start, start_wall = clock.monotonic_us(), clock.wall_us()
        if sequence and start >= window_start + MAX_WINDOW_US:
            break
        scan = Scan(request, filesystem, clock, window_start + MAX_WINDOW_US)
        counts, errors = None, []
        try:
            counts = scan.run()
        except ObservationError as error:
            errors.append(error.record)
        except Exception as error:
            # No unbounded exception repr or path leakage; preserve failure class.
            errors.append({'code': 'OBSERVER_INTERNAL', 'path': ROOT, 'errno': None})
        errors.extend(scan.close_errors)
        end, end_wall = clock.monotonic_us(), clock.wall_us()
        drained = scan.handles == 0 and not scan.close_errors and not any(row['code'] == 'DRAIN_UNPROVEN' for row in errors)
        if not drained and not any(row['code'] == 'DRAIN_UNPROVEN' for row in errors):
            errors.append({'code': 'DRAIN_UNPROVEN', 'path': ROOT, 'errno': None})
        complete = not errors and counts is not None and drained
        attempt = {'sequence': sequence, 'previous': previous, 'startMonotonicUs': start, 'endMonotonicUs': end,
                   'startWallUs': start_wall, 'endWallUs': end_wall, 'rootBefore': scan.root_before, 'rootAfter': scan.root_after,
                   'status': 'complete' if complete else 'unknown', 'drained': drained, 'counts': counts if complete else None, 'errors': errors}
        attempt['hash'] = digest(attempt)
        attempts.append(attempt)
        previous = attempt['hash']
        if complete:
            if end <= window_start + MAX_WINDOW_US:
                selected = sequence
            break
        if not drained or len(errors) != 1 or errors[0]['code'] != 'EVIDENCE_MUTATION' or end >= window_start + MAX_WINDOW_US:
            break
    end, wall_end = clock.monotonic_us(), clock.wall_us()
    # Final record construction time is included in the acceptance window too.
    if end > window_start + MAX_WINDOW_US:
        selected = None
    return {'kind': 'capsule-volume-observation-1', 'request': request, 'requestHash': digest(request), 'policyId': POLICY_ID,
            'bounds': {'maxEntries': MAX_ENTRIES, 'maxDepth': MAX_DEPTH, 'maxAttempts': MAX_ATTEMPTS, 'maxWindowUs': MAX_WINDOW_US},
            'windowStartMonotonicUs': window_start, 'windowEndMonotonicUs': end, 'windowStartWallUs': wall_start, 'windowEndWallUs': wall_end,
            'attempts': attempts, 'selectedAttempt': selected, 'status': 'complete' if selected is not None else 'unknown',
            'drained': all(row['drained'] for row in attempts)}


def main(argv):
    try:
        if len(argv) != 2 or argv[0] != '--request-json':
            raise ObservationError('REQUEST_ARGUMENTS')
        result = observe(parse_request(argv[1]))
    except ObservationError as error:
        result = {'kind': 'capsule-volume-refusal-1', 'status': 'refused', 'error': error.record}
    encoded = canonical(result) + b'\n'
    if len(encoded) > MAX_OUTPUT_BYTES:
        encoded = canonical({'kind': 'capsule-volume-refusal-1', 'status': 'refused', 'error': {'code': 'OUTPUT_BOUND', 'path': ROOT, 'errno': None}}) + b'\n'
        result = {'status': 'refused'}
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()
    return 0 if result['status'] == 'complete' else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
