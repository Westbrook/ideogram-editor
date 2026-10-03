"""Supervise one cooperative, producer-owned Linux build (source staged only).

This proves drainage of the supervised process lineage, not global inactivity or
isolation from same-UID writers. Delegation to pre-existing services and passing
writable descriptors outside the supervised tree are unsupported. The caller
permanently taints every lease on any failure or missing success receipt.
"""
import ctypes
from datetime import datetime, timezone
import errno
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import re
import selectors
import signal
import stat
import struct
import sys
import time
import uuid


CONTROL_KIND = 'linux-owned-command-control-1'
RESULT_KIND = 'linux-owned-command-result-1'
FILTER_POLICY = 'linux-owned-no-namespace-entry-1'
MAX_CONTROL = 4 * 1024 * 1024
MAX_LOG = 64 * 1024 * 1024
MAX_SETUP = 8192
CHUNK = 65536
CLEANUP_SECONDS = 3.0
WALL = 0x40000000
PR_SET_CHILD_SUBREAPER = 36
PR_GET_CHILD_SUBREAPER = 37
PR_SET_NO_NEW_PRIVS = 38
PR_GET_NO_NEW_PRIVS = 39
PR_SET_SECCOMP = 22
PR_GET_SECCOMP = 21
SECCOMP_MODE_FILTER = 2
SECCOMP_RET_KILL_PROCESS = 0x80000000
SECCOMP_RET_ERRNO = 0x00050000
SECCOMP_RET_ALLOW = 0x7fff0000
CLONE_NAMESPACE_MASK = 0x7e020000


class OwnedProcessError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise OwnedProcessError(message)


def _keys(value, expected):
    require(isinstance(value, dict) and set(value) == set(expected), 'Unexpected or missing object fields')


def _integer(value, lower, upper):
    return type(value) is int and lower <= value <= upper


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(',', ':'), allow_nan=False).encode('utf-8')


def _decode_json(data):
    require(isinstance(data, bytes) and len(data) <= MAX_CONTROL, 'Control JSON exceeds bound')
    def pairs(values):
        result = {}
        for key, value in values:
            require(key not in result, 'Duplicate JSON key')
            result[key] = value
        return result
    def invalid(_):
        raise OwnedProcessError('Nonfinite JSON number')
    def finite(raw):
        value = float(raw)
        require(math.isfinite(value), 'Nonfinite JSON number')
        return value
    try:
        return json.loads(data, object_pairs_hook=pairs, parse_constant=invalid, parse_float=finite)
    except (ValueError, UnicodeError, RecursionError) as error:
        raise OwnedProcessError('Malformed control JSON') from error


def _text(value, maximum):
    require(isinstance(value, str) and '\0' not in value, 'Expected NUL-free text')
    try:
        require(len(value.encode('utf-8')) <= maximum, 'Text exceeds bound')
    except UnicodeError as error:
        raise OwnedProcessError('Unsupported text encoding') from error
    return value


def _absolute(value):
    _text(value, 4096)
    require(value.startswith('/') and not value.startswith('//') and
            os.path.normpath(value) == value and '\\' not in value and
            not any(ord(char) < 32 or ord(char) == 127 for char in value),
            'Canonical absolute path required')
    return Path(value)


def _uuid(value):
    require(isinstance(value, str), 'Expected canonical UUID')
    try:
        require(str(uuid.UUID(value)) == value, 'Expected canonical UUID')
    except (ValueError, AttributeError) as error:
        raise OwnedProcessError('Expected canonical UUID') from error


def _ref_shape(value):
    _keys(value, ('path', 'hash', 'byteLength'))
    _absolute(value['path'])
    require(isinstance(value['hash'], str) and re.fullmatch(r'sha256:[0-9a-f]{64}', value['hash']),
            'Invalid helper hash')
    require(isinstance(value['byteLength'], str) and
            len(value['byteLength']) <= len(str(MAX_CONTROL)) and
            re.fullmatch(r'0|[1-9][0-9]*', value['byteLength']) and
            int(value['byteLength']) <= MAX_CONTROL, 'Invalid helper byte length')


def _inside(path, root):
    return path == root or root in path.parents


def validate_control(value):
    """Validate data only. Filesystem acquisition occurs separately in run()."""
    _keys(value, ('kind', 'argv', 'cwd', 'env', 'timeoutSeconds', 'log', 'receipt',
                  'leases', 'nonce', 'helper'))
    require(value['kind'] == CONTROL_KIND, 'Unsupported command control')
    uid = os.geteuid()
    require(uid != 0 and os.getuid() == uid, 'A nonroot, non-setuid producer is required')
    _uuid(value['nonce'])
    require(isinstance(value['argv'], list) and 0 < len(value['argv']) <= 4096,
            'Invalid command argument count')
    for arg in value['argv']:
        _text(arg, 65536)
    require(sum(len(arg.encode('utf-8')) + 1 for arg in value['argv']) <= 1024 * 1024,
            'Command arguments exceed bound')
    _absolute(value['argv'][0])
    cwd = _absolute(value['cwd'])
    log = _absolute(value['log'])
    receipt = _absolute(value['receipt'])
    require(log != receipt and log.parent == receipt.parent, 'Log and receipt must be distinct siblings')
    require(isinstance(value['env'], dict) and len(value['env']) <= 4096, 'Invalid command environment')
    for key, item in value['env'].items():
        _text(key, 65536)
        _text(item, 65536)
        require(key and '=' not in key, 'Invalid environment variable name')
    require(sum(len(key.encode('utf-8')) + len(item.encode('utf-8')) + 2
                for key, item in value['env'].items()) <= 1024 * 1024, 'Environment exceeds bound')
    timeout = value['timeoutSeconds']
    require(type(timeout) in (int, float) and 0 < timeout <= 86400 and math.isfinite(timeout),
            'Invalid command timeout')
    leases = value['leases']
    require(isinstance(leases, list) and 0 < len(leases) <= 16, 'Invalid lease count')
    roots, ids = [], set()
    for lease in leases:
        _keys(lease, ('id', 'root', 'device', 'inode', 'uid'))
        _uuid(lease['id'])
        root = _absolute(lease['root'])
        require(root != Path('/') and lease['id'] not in ids and
                all(not _inside(root, other) and not _inside(other, root) for other in roots),
                'Duplicate or overlapping leases')
        require(_integer(lease['device'], 0, 2 ** 64 - 1) and
                _integer(lease['inode'], 1, 2 ** 64 - 1) and
                type(lease['uid']) is int and lease['uid'] == uid, 'Invalid lease identity')
        roots.append(root)
        ids.add(lease['id'])
    require(any(_inside(cwd, root) for root in roots), 'Command cwd must be inside a lease')
    require(all(not _inside(log.parent, root) and not _inside(root, log.parent) for root in roots),
            'Command evidence parent overlaps a lease')
    _ref_shape(value['helper'])
    require(len(_json(value)) <= MAX_CONTROL, 'Control record exceeds bound')
    return value


def filter_program(machine):
    """Classic BPF instructions: (code, true-skip, false-skip, constant)."""
    require(machine in ('x86_64', 'aarch64'), 'Unsupported syscall architecture')
    arch, clone, unshare, setns = ((0xc000003e, 56, 272, 308) if machine == 'x86_64'
                                  else (0xc00000b7, 220, 97, 268))
    return [
        (0x20, 0, 0, 4),                         # LD W ABS: audit architecture.
        (0x15, 1, 0, arch),                      # Known ABI skips the kill.
        (0x06, 0, 0, SECCOMP_RET_KILL_PROCESS),
        (0x20, 0, 0, 0),                         # LD syscall number.
        (0x45, 0, 1, 0x40000000),                # x32/unsupported syscall ABI.
        (0x06, 0, 0, SECCOMP_RET_KILL_PROCESS),
        (0x15, 0, 1, setns),
        (0x06, 0, 0, SECCOMP_RET_ERRNO | errno.EPERM),
        (0x15, 0, 1, unshare),
        (0x06, 0, 0, SECCOMP_RET_ERRNO | errno.EPERM),
        (0x15, 0, 1, 435),                       # clone3's pointed-to flags are opaque.
        (0x06, 0, 0, SECCOMP_RET_ERRNO | errno.ENOSYS),
        (0x15, 0, 3, clone),                     # Non-clone syscalls go to ALLOW.
        (0x20, 0, 0, 16),                        # Low 32 bits of args[0], little endian.
        (0x45, 0, 1, CLONE_NAMESPACE_MASK),
        (0x06, 0, 0, SECCOMP_RET_ERRNO | errno.EPERM),
        (0x06, 0, 0, SECCOMP_RET_ALLOW),
    ]


def filter_description(machine):
    encoded = b''.join(struct.pack('<HBBI', *row) for row in filter_program(machine))
    return {'policy': FILTER_POLICY, 'sha256': hashlib.sha256(encoded).hexdigest(),
            'architecture': machine}


def _linux():
    require(sys.platform == 'linux' and platform.machine() in ('x86_64', 'aarch64') and
            sys.byteorder == 'little' and struct.calcsize('P') == 8,
            'Requires little-endian Linux x86_64/aarch64 LP64')
    # Avoid old x86/x32 seccomp ABI corner cases and bind the supported floor.
    release = re.match(r'([0-9]+)\.([0-9]+)', platform.release())
    require(release is not None and tuple(map(int, release.groups())) >= (5, 4),
            'Requires Linux kernel 5.4 or newer')
    require(hasattr(os, 'fork') and hasattr(os, 'O_NOFOLLOW'), 'Required Linux APIs are unavailable')


def _parent_fd(path):
    path = _absolute(os.fspath(path))
    require(path != Path('/'), 'A leaf path is required')
    descriptor = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for part in path.parts[1:-1]:
            following = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                                dir_fd=descriptor)
            os.close(descriptor)
            descriptor = following
        return descriptor, path.name
    except BaseException:
        os.close(descriptor)
        raise


def _open(path, flags=os.O_RDONLY, mode=0o600):
    parent, name = _parent_fd(path)
    try:
        return os.open(name, flags | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, mode, dir_fd=parent)
    finally:
        os.close(parent)


def _stat(path):
    parent, name = _parent_fd(path)
    try:
        return os.stat(name, dir_fd=parent, follow_symlinks=False)
    finally:
        os.close(parent)


def _identity(value):
    return (value.st_dev, value.st_ino, value.st_mode, value.st_nlink, value.st_uid,
            value.st_gid, value.st_size, value.st_mtime_ns, value.st_ctime_ns)


def _read(path, maximum, *, private=False):
    descriptor = _open(path)
    try:
        before = os.fstat(descriptor)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= maximum,
                'Expected bounded single-link regular file')
        if private:
            require(before.st_uid == os.geteuid() and stat.S_IMODE(before.st_mode) & 0o077 == 0,
                    'Control must be private and producer-owned')
        data = bytearray()
        while True:
            block = os.read(descriptor, min(CHUNK, maximum - len(data) + 1))
            if not block:
                break
            data.extend(block)
            require(len(data) <= maximum, 'File grew beyond bound')
        require(len(data) == before.st_size and
                _identity(before) == _identity(os.fstat(descriptor)) == _identity(_stat(path)),
                'Pinned file changed while reading')
        return bytes(data)
    finally:
        os.close(descriptor)


def _file_ref(path, maximum):
    descriptor = _open(path)
    try:
        before = os.fstat(descriptor)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= maximum,
                'Expected bounded single-link reference')
        size = 0
        hashed = hashlib.sha256()
        while True:
            data = os.read(descriptor, min(CHUNK, maximum - size + 1))
            if not data:
                break
            size += len(data)
            require(size <= maximum, 'Reference grew beyond bound')
            hashed.update(data)
        require(size == before.st_size and
                _identity(before) == _identity(os.fstat(descriptor)) == _identity(_stat(path)),
                'Reference changed while hashing')
        return {'path': str(path), 'hash': 'sha256:' + hashed.hexdigest(), 'byteLength': str(size)}
    finally:
        os.close(descriptor)


def _private_directory(path):
    descriptor = _open(path, os.O_RDONLY | os.O_DIRECTORY)
    value = os.fstat(descriptor)
    try:
        visible = _stat(path)
        require(stat.S_ISDIR(value.st_mode) and value.st_uid == os.geteuid() and
                stat.S_IMODE(value.st_mode) == 0o700 and
                (value.st_dev, value.st_ino) == (visible.st_dev, visible.st_ino),
                'Directory must be private, owned, and stable')
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def _lease_check(lease, descriptor):
    held, visible = os.fstat(descriptor), _stat(lease['root'])
    for value in (held, visible):
        require(stat.S_ISDIR(value.st_mode) and stat.S_IMODE(value.st_mode) == 0o700 and
                value.st_uid == lease['uid'] == os.geteuid() and
                value.st_dev == lease['device'] and value.st_ino == lease['inode'],
                'Owned lease identity or privacy changed')


def _write_all(descriptor, data):
    view = memoryview(data)
    while view:
        count = os.write(descriptor, view)
        require(count > 0, 'Short evidence write')
        view = view[count:]


def _save(path, value):
    data = _json(value) + b'\n'
    require(len(data) <= MAX_CONTROL, 'Result record exceeds bound')
    descriptor = _open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
    try:
        _write_all(descriptor, data)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    parent, _ = _parent_fd(path)
    try:
        os.fsync(parent)
    finally:
        os.close(parent)


def _proc_bytes(name):
    # Proc reports zero st_size for generated content. Bound bytes actually read;
    # the sealed-file reader's exact size rule is inapplicable to these records.
    require(name in ('stat', 'status'), 'Unsupported supervisor proc record')
    descriptor = _open(Path('/proc') / str(os.getpid()) / name)
    try:
        require(stat.S_ISREG(os.fstat(descriptor).st_mode), 'Invalid supervisor proc record')
        data = bytearray()
        while True:
            block = os.read(descriptor, 65537 - len(data))
            if not block:
                break
            data.extend(block)
            require(len(data) <= 65536, 'Oversized supervisor proc record')
        return bytes(data)
    finally:
        os.close(descriptor)


def _unprivileged():
    try:
        status = _proc_bytes('status').decode('ascii')
    except UnicodeError as error:
        raise OwnedProcessError('Malformed supervisor process identity') from error
    def fields(name):
        rows = re.findall(r'^' + name + r':[^\S\n]*([^\n]*)$', status, re.MULTILINE)
        require(len(rows) == 1, 'Missing or duplicate supervisor identity: ' + name)
        return rows[0].split()
    uid, gid = os.geteuid(), os.getegid()
    require(uid != 0 and os.getuid() == uid and os.getgid() == gid and
            fields('Uid') == [str(uid)] * 4 and fields('Gid') == [str(gid)] * 4,
            'Supervisor requires equal nonroot real/effective/saved/filesystem identities')
    for name in ('CapInh', 'CapPrm', 'CapEff', 'CapAmb'):
        values = fields(name)
        require(len(values) == 1 and re.fullmatch('[0-9a-fA-F]{1,16}', values[0]) and
                int(values[0], 16) == 0, 'Supervisor requires zero inherited/permitted/effective/ambient capabilities')
    return {'uid': uid, 'gid': gid}


def _start_ticks():
    # Only this supervisor's proc record is read; no global process inventory.
    try:
        data = _proc_bytes('stat')
        fields = data.rsplit(b')', 1)[1].split()
        require(len(fields) > 19 and fields[19].isdigit(), 'Malformed supervisor identity')
        return fields[19].decode('ascii')
    except (IndexError, UnicodeError) as error:
        raise OwnedProcessError('Cannot read supervisor start identity') from error


def _single_thread():
    descriptor = _open(Path('/proc') / str(os.getpid()) / 'task', os.O_RDONLY | os.O_DIRECTORY)
    try:
        names = []
        with os.scandir(descriptor) as entries:
            for entry in entries:
                require(not names, 'Supervisor must have exactly one thread')
                names.append(entry.name)
        require(names == [str(os.getpid())], 'Supervisor thread identity differs')
    finally:
        os.close(descriptor)


def _pid_namespace():
    # A pre-existing pid_for_children selection would take effect at fork before
    # the worker installs seccomp. It could cross the subreaper adoption boundary.
    own = Path('/proc') / str(os.getpid()) / 'ns'
    current = os.readlink(own / 'pid')
    children = os.readlink(own / 'pid_for_children')
    require(isinstance(current, str) and re.fullmatch(r'pid:\[[1-9][0-9]{0,19}\]', current) and children == current,
            'Supervisor and future children must share one PID namespace')
    return current


def _prctl(option, arg2=0, arg3=0, arg4=0, arg5=0):
    libc = ctypes.CDLL(None, use_errno=True)
    call = libc.prctl
    call.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
    call.restype = ctypes.c_int
    result = call(option, arg2, arg3, arg4, arg5)
    if result < 0:
        number = ctypes.get_errno()
        raise OwnedProcessError('Required prctl failed: ' + os.strerror(number))
    return result


def _no_new_privileges():
    require(_prctl(PR_SET_NO_NEW_PRIVS, 1) == 0 and _prctl(PR_GET_NO_NEW_PRIVS) == 1,
            'no_new_privs could not be established')


def _subreaper():
    require(_prctl(PR_SET_CHILD_SUBREAPER, 1) == 0, 'Subreaper setup failed')
    value = ctypes.c_int()
    require(_prctl(PR_GET_CHILD_SUBREAPER, ctypes.addressof(value)) == 0 and value.value == 1,
            'Subreaper readback failed')


def _install_filter(machine):
    class SockFilter(ctypes.Structure):
        _fields_ = [('code', ctypes.c_ushort), ('jt', ctypes.c_ubyte),
                    ('jf', ctypes.c_ubyte), ('k', ctypes.c_uint32)]
    class SockFprog(ctypes.Structure):
        _fields_ = [('len', ctypes.c_ushort), ('filter', ctypes.POINTER(SockFilter))]
    instructions = filter_program(machine)
    code = (SockFilter * len(instructions))(*(SockFilter(*row) for row in instructions))
    program = SockFprog(len(instructions), code)
    _no_new_privileges()
    require(_prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, ctypes.addressof(program)) == 0 and
            _prctl(PR_GET_SECCOMP) == SECCOMP_MODE_FILTER, 'Namespace filter setup failed')


def _worker(control, cwd_descriptor, output, setup, machine):
    try:
        os.setsid()
        os.dup2(output, 1)
        os.dup2(output, 2)
        if output not in (1, 2):
            os.close(output)
        null = os.open('/dev/null', os.O_RDONLY | os.O_CLOEXEC)
        os.dup2(null, 0)
        if null != 0:
            os.close(null)
        signal.pthread_sigmask(signal.SIG_SETMASK, [])
        for signum in (signal.SIGCHLD, signal.SIGINT, signal.SIGTERM, signal.SIGPIPE):
            signal.signal(signum, signal.SIG_DFL)
        os.fchdir(cwd_descriptor)
        _install_filter(machine)
        acknowledgement = {'kind': 'linux-owned-worker-ready-1', 'nonce': control['nonce'],
                           'pid': os.getpid(), 'session': os.getsid(0),
                           'filter': filter_description(machine)}
        _write_all(setup, _json(acknowledgement) + b'\n')
        os.close(setup)  # The command cannot manufacture a setup acknowledgement.
        os.execve(control['argv'][0], control['argv'], control['env'])
    except BaseException as error:
        try:
            _write_all(2, ('owned command setup/exec failed: ' + str(error)[:2048] + '\n').encode('utf-8', 'replace'))
        except BaseException:
            pass
        os._exit(125)


def _group_absent(leader):
    try:
        os.killpg(leader, 0)
    except ProcessLookupError:
        return True
    except OSError:
        return False
    return False


def _supervise(control, cwd_descriptor, log_descriptor, machine):
    """Exactly one waiter owns every terminal status in this process."""
    output_read, output_write = os.pipe2(os.O_CLOEXEC)
    setup_read, setup_write = os.pipe2(os.O_CLOEXEC)
    started = time.monotonic()
    leader = None
    streams = selectors.DefaultSelector()
    open_descriptors = {output_read, output_write, setup_read, setup_write}
    failure = None
    cleanup_deadline = None
    exit_code = None
    leader_reaped = False
    drained = False
    installed = False
    setup_data = bytearray()
    log_bytes = 0

    def failed(message):
        nonlocal failure, cleanup_deadline
        if failure is not None:
            return
        failure = str(message)[:4096]
        cleanup_deadline = time.monotonic() + CLEANUP_SECONDS
        # An unreaped leader PID cannot be reused. Once reaped, never signal its
        # numeric PGID: detached descendants may remain, but the group can reuse.
        if leader is not None and not leader_reaped:
            for send in (lambda: os.killpg(leader, signal.SIGKILL),
                         lambda: os.kill(leader, signal.SIGKILL)):
                try:
                    send()
                except OSError:
                    pass

    try:
        leader = os.fork()
        if leader == 0:
            os.close(output_read)
            os.close(setup_read)
            _worker(control, cwd_descriptor, output_write, setup_write, machine)
            os._exit(125)
        for descriptor in (output_write, setup_write):
            os.close(descriptor)
            open_descriptors.remove(descriptor)
        for descriptor, kind in ((output_read, 'output'), (setup_read, 'setup')):
            os.set_blocking(descriptor, False)
            streams.register(descriptor, selectors.EVENT_READ, kind)
        deadline = started + control['timeoutSeconds']
        while True:
            if failure is None and time.monotonic() >= deadline:
                failed('Command or owned-descendant drainage exceeded deadline')
            # A bounded batch prevents endless child churn from bypassing the
            # deadline. Never use Popen.wait(), another waiter, or a reaping handler.
            for _ in range(256):
                try:
                    pid, status = os.waitpid(-1, os.WNOHANG | WALL)
                except InterruptedError:
                    continue
                except ChildProcessError:
                    drained = True
                    break
                if pid == 0:
                    break
                if os.WIFEXITED(status) or os.WIFSIGNALED(status):
                    if pid == leader:
                        leader_reaped = True
                        exit_code = os.waitstatus_to_exitcode(status)
                        if exit_code != 0:
                            failed('Command leader exited unsuccessfully: ' + str(exit_code))
                # Traced stop events are not termination and cannot prove drainage.
            for key, _ in streams.select(0 if drained else 0.05):
                try:
                    block = os.read(key.fd, CHUNK)
                except BlockingIOError:
                    continue
                if not block:
                    streams.unregister(key.fd)
                    os.close(key.fd)
                    open_descriptors.remove(key.fd)
                    if key.data == 'setup':
                        try:
                            ready = _decode_json(bytes(setup_data))
                            expected = {'kind': 'linux-owned-worker-ready-1', 'nonce': control['nonce'],
                                        'pid': leader, 'session': leader, 'filter': filter_description(machine)}
                            require(ready == expected and bytes(setup_data) == _json(expected) + b'\n',
                                    'Worker setup handshake differs')
                            installed = True
                        except BaseException as error:
                            failed('Worker filter setup was not verified: ' + str(error))
                elif key.data == 'setup':
                    if len(setup_data) + len(block) > MAX_SETUP:
                        failed('Worker setup output exceeds bound')
                    else:
                        setup_data.extend(block)
                else:
                    if log_bytes + len(block) > MAX_LOG:
                        failed('Command log exceeds 64 MiB bound')
                    retained = block[:MAX_LOG - log_bytes]
                    if retained:
                        _write_all(log_descriptor, retained)
                        log_bytes += len(retained)
            if drained and not streams.get_map():
                break
            if failure is not None and time.monotonic() >= cleanup_deadline:
                break
            if drained and streams.get_map():
                # External holders of inherited output descriptors are unsupported;
                # do not spin or interpret process ECHILD as pipe closure.
                time.sleep(0.01)
        if not leader_reaped:
            failed('Command leader terminal status was not observed')
        if not drained:
            failed('Owned descendant drainage was not established')
        if not installed:
            failed('Worker namespace filter was not verified')
        group_drained = _group_absent(leader)
        if not group_drained:
            failed('Command process-group absence was not established')
        return {'exitCode': exit_code, 'processGroupDrained': group_drained,
                'ownedDescendantsDrained': drained, 'filterInstalled': installed,
                'elapsedMs': max(0, int((time.monotonic() - started) * 1000)), 'failure': failure}
    except BaseException as error:
        failed('Supervisor observation failed: ' + str(error))
        # Retain a bounded opportunity to reap after signaling. This path never
        # turns an observation error into success or assumes detached tasks died.
        while leader is not None and time.monotonic() < cleanup_deadline:
            try:
                pid, status = os.waitpid(-1, os.WNOHANG | WALL)
                if pid == leader and (os.WIFEXITED(status) or os.WIFSIGNALED(status)):
                    leader_reaped = True
                    exit_code = os.waitstatus_to_exitcode(status)
                if pid == 0:
                    time.sleep(0.01)
            except InterruptedError:
                continue
            except (ChildProcessError, OSError):
                break
        return {'exitCode': exit_code, 'processGroupDrained': False,
                'ownedDescendantsDrained': False, 'filterInstalled': installed,
                'elapsedMs': max(0, int((time.monotonic() - started) * 1000)), 'failure': failure}
    finally:
        streams.close()
        for descriptor in open_descriptors:
            try:
                os.close(descriptor)
            except OSError:
                pass


def run(control_path):
    _linux()
    require(sys.flags.isolated == 1 and sys.flags.no_site == 1, 'Launch the supervisor with Python -I -S')
    _single_thread()
    _pid_namespace()
    initial_authority = _unprivileged()
    for descriptor in (0, 1, 2):
        os.fstat(descriptor)  # Keep newly allocated control pipes away from stdio.
    os.umask(0o077)
    control_path = _absolute(control_path)
    handles = []
    log_descriptor = None
    try:
        control_parent = _private_directory(control_path.parent)
        handles.append(control_parent)
        raw_control = _read(control_path, MAX_CONTROL, private=True)
        control = validate_control(_decode_json(raw_control))
        require(control_path not in (Path(control['log']), Path(control['receipt'])) and
                control_path.parent == Path(control['log']).parent, 'Control and evidence must be distinct siblings')
        require(control['helper']['path'] == str(_absolute(os.path.abspath(__file__))) and
                _file_ref(control['helper']['path'], MAX_CONTROL) == control['helper'],
                'Helper source differs from its pinned identity')
        for path in (control['log'], control['receipt']):
            try:
                _stat(path)
            except FileNotFoundError:
                pass
            else:
                raise OwnedProcessError('Command evidence destination already exists')
        leases = []
        for lease in control['leases']:
            descriptor = _private_directory(lease['root'])
            handles.append(descriptor)
            _lease_check(lease, descriptor)
            leases.append((lease, descriptor))
        cwd_descriptor = _open(control['cwd'], os.O_RDONLY | os.O_DIRECTORY)
        handles.append(cwd_descriptor)
        executable = _stat(control['argv'][0])
        require(stat.S_ISREG(executable.st_mode) and executable.st_nlink == 1 and
                stat.S_IMODE(executable.st_mode) & 0o111, 'Command must name a regular executable')
        # The CLI starts a dedicated interpreter. Refuse inherited children and
        # use one single-threaded wait owner. Normal Python imports do not start
        # workers; site and environment imports are disabled by required -I -S.
        try:
            os.waitpid(-1, os.WNOHANG | WALL)
        except ChildProcessError:
            pass
        else:
            raise OwnedProcessError('Supervisor unexpectedly already has children')
        signal.signal(signal.SIGCHLD, signal.SIG_DFL)
        _subreaper()
        _no_new_privileges()
        supervisor = {'pid': os.getpid(), 'startTicks': _start_ticks()}
        log_descriptor = _open(control['log'], os.O_RDWR | os.O_CREAT | os.O_EXCL)
        log_identity = os.fstat(log_descriptor)
        observation = _supervise(control, cwd_descriptor, log_descriptor, platform.machine())
        try:
            require(_unprivileged() == initial_authority, 'Supervisor authority changed')
            for lease, descriptor in leases:
                _lease_check(lease, descriptor)
            require(_read(control_path, MAX_CONTROL, private=True) == raw_control,
                    'Command control changed during execution')
            require(_file_ref(control['helper']['path'], MAX_CONTROL) == control['helper'],
                    'Helper source changed during execution')
            current = os.fstat(control_parent)
            visible = _stat(control_path.parent)
            require(current.st_dev == visible.st_dev and current.st_ino == visible.st_ino and
                    visible.st_uid == os.geteuid() and stat.S_IMODE(visible.st_mode) == 0o700,
                    'Command evidence directory changed')
        except BaseException as error:
            observation['failure'] = observation['failure'] or ('Post-command identity check failed: ' + str(error))
        os.fsync(log_descriptor)
        after = _stat(control['log'])
        require((log_identity.st_dev, log_identity.st_ino) == (after.st_dev, after.st_ino) and
                after.st_uid == os.geteuid() and stat.S_IMODE(after.st_mode) == 0o600 and after.st_nlink == 1,
                'Command log was replaced or exposed')
        log_ref = _file_ref(control['log'], MAX_LOG)
        result = {'kind': RESULT_KIND, 'nonce': control['nonce'], 'argv': control['argv'],
                  'cwd': control['cwd'], 'environment': control['env'],
                  'exitCode': observation['exitCode'], 'elapsedMs': observation['elapsedMs'],
                  'processGroupDrained': observation['processGroupDrained'],
                  'ownedDescendantsDrained': observation['ownedDescendantsDrained'],
                  'globalInactivityVerified': False,
                  'filter': {**filter_description(platform.machine()), 'installed': observation['filterInstalled']},
                  'leases': control['leases'], 'log': log_ref, 'supervisor': supervisor,
                  'finishedAt': datetime.now(timezone.utc).isoformat(), 'failure': observation['failure']}
        _save(control['receipt'], result)
        return 0 if result['failure'] is None else 1
    finally:
        if log_descriptor is not None:
            os.close(log_descriptor)
        for descriptor in reversed(handles):
            os.close(descriptor)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    try:
        require(isinstance(argv, list) and len(argv) == 1, 'Expected exactly one absolute control JSON path')
        return run(argv[0])
    except BaseException as error:
        sys.stderr.write('owned supervisor refused: ' + str(error)[:4096] + '\n')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
