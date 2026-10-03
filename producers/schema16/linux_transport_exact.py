"""Linux-only, copy-only, exact POSIX metadata transport (source staged; unexecuted).

There is no fallback to Darwin metadata and no extraction through tarfile.extract.
Only this bounded USTAR/gzip profile is accepted. Source processes must already be
quiescent: two lsof observations and stable reads are not a hostile-writer snapshot.
"""
import base64
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import platform
import re
import selectors
import shutil
import stat
import struct
import subprocess
import sys
import time
import uuid
import zlib


POLICY = 'linux-posix-exact-1'
KIND = 'linux-closure-transport-1'
MAX_ENTRIES = 200000
MAX_BYTES = 8 * 1024 ** 3
MAX_JSON = 64 * 1024 ** 2
MAX_XATTR_BYTES = 1024 ** 2
MAX_ALL_XATTR_BYTES = 16 * 1024 ** 2
CHUNK = 1024 ** 2
FS_IOC_GETFLAGS = 0x80086601  # Linux LP64 _IOR('f', 1, long).
FS_INDEX_FL = 0x1000
FS_EXTENT_FL = 0x80000
archive = sys.modules[__name__]


class ArchiveError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise ArchiveError(message)


def keys(obj, required, optional=()):
    require(isinstance(obj, dict) and set(required) <= set(obj) <= set(required) | set(optional),
            'Missing or unsupported object fields')


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')


def content_id(value):
    return 'sha256:' + digest(canonical_json(value))


def decode_json(data):
    require(len(data) <= MAX_JSON, 'JSON exceeds bound')
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'Duplicate JSON key')
            result[key] = value
        return result
    def invalid(_):
        raise ArchiveError('Nonfinite JSON number')
    def finite(raw):
        value = float(raw)
        require(math.isfinite(value), 'Nonfinite JSON number')
        return value
    return json.loads(data, object_pairs_hook=pairs, parse_constant=invalid, parse_float=finite)


def below(name, prefix):
    return name == prefix or name.startswith(prefix + '/')


def relative(value):
    require(isinstance(value, str) and value and len(value.encode('utf-8')) <= 256 and
            '\\' not in value and not any(ord(c) < 32 or ord(c) == 127 for c in value), 'Invalid relative path')
    path = PurePosixPath(value)
    require(not path.is_absolute() and '..' not in path.parts and str(path) == value and
            value != '.' and len(path.parts) <= 64, 'Noncanonical relative path')
    _ustar_names(value)
    return value


def _absolute(path):
    raw = os.fspath(path)
    require(isinstance(raw, str) and raw.startswith('/') and not raw.startswith('//') and os.path.normpath(raw) == raw and
            '\\' not in raw and not any(ord(c) < 32 or ord(c) == 127 for c in raw), 'Noncanonical absolute path')
    return Path(raw)


def _parent_fd(path):
    """Never follow any parent link, even if a component changes after validation."""
    path = _absolute(path)
    descriptor = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for component in path.parts[1:-1]:
            following = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = following
        return descriptor, path.name
    except BaseException:
        os.close(descriptor)
        raise


def _stat(path):
    path = _absolute(path)
    if path == Path('/'):
        return os.stat('/', follow_symlinks=False)
    descriptor, name = _parent_fd(path)
    try:
        return os.stat(name, dir_fd=descriptor, follow_symlinks=False)
    finally:
        os.close(descriptor)


def _open(path, flags=os.O_RDONLY, mode=0o600):
    descriptor, name = _parent_fd(path)
    try:
        return os.open(name, flags | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, mode, dir_fd=descriptor)
    finally:
        os.close(descriptor)


def canonical(path, exists=True):
    path = _absolute(path)
    try:
        value = _stat(path)
    except FileNotFoundError:
        require(not exists, 'Required path is absent')
        # Only the final component may be absent.
        require(stat.S_ISDIR(_stat(path.parent).st_mode), 'Destination parent is absent')
        return path
    require(stat.S_ISREG(value.st_mode) or stat.S_ISDIR(value.st_mode), 'Link/special path is unsupported')
    return path


def identity(value):
    return [value.st_dev, value.st_ino, value.st_mode, value.st_nlink, value.st_size,
            value.st_mtime_ns, value.st_ctime_ns, value.st_uid, value.st_gid]


def _linux():
    require(sys.platform == 'linux' and platform.machine() in ('x86_64', 'aarch64') and
            struct.calcsize('L') == 8, 'Requires Linux x86_64/aarch64 LP64; no metadata fallback')
    require(all(hasattr(os, name) for name in ('listxattr', 'getxattr', 'setxattr', 'removexattr', 'O_NOFOLLOW')),
            'Linux no-follow/xattr APIs unavailable')


def _metadata_privileges():
    _linux()
    # trusted.* enumeration otherwise silently omits inaccessible attributes.
    # These bits must be held in the controlled builder's initial user namespace;
    # same host PID/mount visibility is an explicit execution prerequisite.
    status = read_bytes(Path('/proc') / str(os.getpid()) / 'status', 65536).decode('ascii')
    values = re.findall(r'^CapEff:\s*([0-9a-fA-F]+)$', status, re.MULTILINE)
    require(len(values) == 1, 'Cannot establish Linux effective capabilities')
    effective = int(values[0], 16)
    required = sum(1 << bit for bit in (0, 1, 3, 4, 19, 21))  # Also SYS_PTRACE for complete lsof /proc visibility.
    require(os.geteuid() == 0 and effective & required == required,
            'Exact Linux transport requires root with CHOWN/DAC_OVERRIDE/FOWNER/FSETID/SYS_PTRACE/SYS_ADMIN capabilities')
    maps = {}
    for kind in ('uid_map', 'gid_map'):
        lines = read_bytes(Path('/proc') / str(os.getpid()) / kind, 65536).decode('ascii').splitlines()
        require(len(lines) == 1 and lines[0].split() == ['0', '0', '4294967295'],
                'Remapped user namespaces are unsupported for exact metadata')
        maps[kind] = lines[0].split()
    return {'effectiveCapabilities': values[0].lower(), 'uid': 0, **maps,
            'requiredVisibility': 'Controlled builder in initial user namespace with full same-host PID/mount visibility'}


def _flags(descriptor, directory):
    _linux()
    value = bytearray(8)
    try:
        fcntl.ioctl(descriptor, FS_IOC_GETFLAGS, value, True)
    except OSError as error:
        raise ArchiveError('Filesystem does not expose required inode flags') from error
    flags = struct.unpack('=I', value[:4])[0]
    allowed = FS_EXTENT_FL | (FS_INDEX_FL if directory else 0)
    require(flags & ~allowed == 0, 'Unsupported semantic/unknown Linux inode flags')
    return flags


def _xattrs(descriptor):
    names = sorted(os.listxattr(descriptor))
    require(len(names) <= 256, 'Too many xattrs')
    values = {}
    total = 0
    for name in names:
        require(isinstance(name, str) and 0 < len(name.encode('utf-8')) <= 255 and '\0' not in name,
                'Unsupported xattr name encoding')
        value = os.getxattr(descriptor, name)
        total += len(value)
        require(total <= MAX_XATTR_BYTES, 'Xattr bytes exceed per-entry bound')
        values[name] = base64.b64encode(value).decode('ascii')
    require(sorted(os.listxattr(descriptor)) == names, 'Xattr names changed while reading')
    return values


def _acl(values):
    # Linux stores both POSIX ACL kinds as kernel-validated binary xattrs. Keep
    # exact bytes; never round-trip through display text or infer an empty ACL.
    return {name: value for name, value in values.items()
            if name in ('system.posix_acl_access', 'system.posix_acl_default')}


def _read_fd(descriptor, maximum, sink=None):
    count = 0
    hashed = hashlib.sha256()
    while True:
        block = os.read(descriptor, min(CHUNK, maximum - count + 1))
        if not block:
            break
        count += len(block)
        require(count <= maximum, 'File exceeds read bound')
        hashed.update(block)
        if sink is not None:
            sink(block)
    return count, hashed.hexdigest()


def read_bytes(path, maximum=MAX_JSON):
    descriptor = _open(canonical(str(path)))
    try:
        before = os.fstat(descriptor)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= maximum,
                'Expected bounded single-link file')
        blocks = []
        _read_fd(descriptor, maximum, blocks.append)
        require(identity(before) == identity(os.fstat(descriptor)) == identity(_stat(path)), 'File changed while reading')
        return b''.join(blocks)
    finally:
        os.close(descriptor)


def entry(path, *, _privileged=False):
    _linux()
    privilege = None if _privileged else _metadata_privileges()
    path = canonical(str(path))
    descriptor = _open(path)
    try:
        before = os.fstat(descriptor)
        directory = stat.S_ISDIR(before.st_mode)
        require(directory or stat.S_ISREG(before.st_mode) and before.st_nlink == 1,
                'Only directories and single-link regular files are supported')
        values = _xattrs(descriptor)
        flags = _flags(descriptor, directory)
        row = {'type': 'directory' if directory else 'file', 'mode': stat.S_IMODE(before.st_mode),
               'mtimeNs': before.st_mtime_ns, 'uid': before.st_uid, 'gid': before.st_gid,
               'flags': flags, 'xattrs': values, 'acl': _acl(values), 'originalIdentity': identity(before)}
        if not directory:
            count, hashed = _read_fd(descriptor, MAX_BYTES)
            require(count == before.st_size, 'File size changed')
            row.update(bytes=count, sha256=hashed, nlink=1)
        require(identity(before) == identity(os.fstat(descriptor)) == identity(_stat(path)) and
                _xattrs(descriptor) == values and _flags(descriptor, directory) == flags, 'Source changed while reading')
        _validate_row(row)
        if privilege is not None:
            require(_metadata_privileges() == privilege, 'Metadata privilege boundary changed')
        return row
    finally:
        os.close(descriptor)


def portable(row):
    return {key: value for key, value in row.items() if key != 'originalIdentity'}


def _includes(includes):
    require(isinstance(includes, list) and 0 < len(includes) <= 100000 and
            all(isinstance(name, str) for name in includes), 'Invalid closure selection')
    require(includes == sorted(set(includes)), 'Selection must be sorted and unique')
    for name in includes:
        relative(name)
    selected = set(includes)
    for name in includes:
        require(not any(str(parent) in selected for parent in PurePosixPath(name).parents), 'Overlapping selections')


def _children(descriptor, maximum):
    names = []
    with os.scandir(descriptor) as items:
        for item in items:
            require(len(names) < maximum, 'Directory exceeds entry bound')
            names.append(item.name)
    return sorted(names)


def snapshot(descriptor, root):
    privilege = _metadata_privileges()
    root = canonical(str(root))
    _includes(descriptor['include'])
    root_before = identity(_stat(root))
    require(stat.S_ISDIR(root_before[2]), 'Source root must be a directory')
    rows = {}
    total = attributes = record_bytes = 0
    def visit(name, recurse):
        nonlocal total, attributes, record_bytes
        relative(name)
        row = entry(root / name, _privileged=True)
        if name in rows:
            require(rows[name] == row, 'Repeated ancestor changed')
        else:
            rows[name] = row
            total += row.get('bytes', 0)
            attributes += sum(len(base64.b64decode(value)) for value in row['xattrs'].values())
            record_bytes += len(canonical_json(name)) + len(canonical_json(row)) + 2
            require(len(rows) <= MAX_ENTRIES and total <= MAX_BYTES and attributes <= MAX_ALL_XATTR_BYTES and
                    record_bytes + 2 <= MAX_JSON, 'Closure exceeds entry/byte/metadata limit')
        if recurse and row['type'] == 'directory':
            directory = _open(root / name, os.O_RDONLY | os.O_DIRECTORY)
            try:
                require(identity(os.fstat(directory)) == row['originalIdentity'], 'Directory changed before traversal')
                children = _children(directory, MAX_ENTRIES - len(rows))
                for child in children:
                    visit(name + '/' + child, True)
                require(children == _children(directory, len(children)) and
                        identity(os.fstat(directory)) == identity(_stat(root / name)) == row['originalIdentity'],
                        'Directory membership changed')
            finally:
                os.close(directory)
    for name in descriptor['include']:
        for parent in reversed(PurePosixPath(name).parents):
            if str(parent) != '.' and str(parent) not in rows:
                visit(str(parent), False)
        visit(name, True)
    require(root_before == identity(_stat(root)), 'Source root changed')
    require(_metadata_privileges() == privilege, 'Metadata privilege boundary changed')
    rows = dict(sorted(rows.items()))
    _validate_rows(rows)
    return rows


def inventory(root, includes):
    return snapshot({'include': includes}, root)


def _integer(value, lower, upper):
    return type(value) is int and lower <= value <= upper


def _validate_row(row):
    common = ['type', 'mode', 'mtimeNs', 'uid', 'gid', 'flags', 'xattrs', 'acl', 'originalIdentity']
    require(isinstance(row, dict) and row.get('type') in ('file', 'directory'), 'Invalid inventory entry')
    keys(row, common + (['bytes', 'sha256', 'nlink'] if row['type'] == 'file' else []))
    require(_integer(row['mode'], 0, 0o7777) and _integer(row['uid'], 0, 0o7777777) and
            _integer(row['gid'], 0, 0o7777777) and _integer(row['mtimeNs'], 0, 0o77777777777 * 10 ** 9 + 999999999),
            'Metadata is not representable by this USTAR/Linux profile')
    allowed = FS_EXTENT_FL | (FS_INDEX_FL if row['type'] == 'directory' else 0)
    require(_integer(row['flags'], 0, 2 ** 32 - 1) and row['flags'] & ~allowed == 0, 'Unsupported inode flags')
    require(isinstance(row['originalIdentity'], list) and len(row['originalIdentity']) == 9 and
            all(type(value) is int for value in row['originalIdentity']), 'Invalid original identity')
    require(isinstance(row['xattrs'], dict) and len(row['xattrs']) <= 256, 'Invalid xattrs')
    total = 0
    for name, encoded in row['xattrs'].items():
        require(isinstance(name, str) and 0 < len(name.encode('utf-8')) <= 255 and '\0' not in name and
                isinstance(encoded, str) and len(encoded) <= (MAX_XATTR_BYTES + 2) // 3 * 4, 'Invalid xattr encoding')
        try:
            value = base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError) as error:
            raise ArchiveError('Invalid base64 xattr') from error
        require(base64.b64encode(value).decode('ascii') == encoded, 'Noncanonical base64 xattr')
        total += len(value)
    require(total <= MAX_XATTR_BYTES and row['acl'] == _acl(row['xattrs']), 'ACL/xattr identity differs')
    require(row['type'] == 'directory' or 'system.posix_acl_default' not in row['xattrs'], 'Default ACL on a file')
    if row['type'] == 'file':
        require(_integer(row['bytes'], 0, min(MAX_BYTES, 0o77777777777)) and row['nlink'] == 1 and type(row['nlink']) is int and
                isinstance(row['sha256'], str) and re.fullmatch('[0-9a-f]{64}', row['sha256']), 'Invalid file identity')


def _validate_rows(rows):
    require(isinstance(rows, dict) and 0 < len(rows) <= MAX_ENTRIES, 'Invalid inventory size')
    total = attributes = 0
    for name, row in rows.items():
        relative(name)
        _validate_row(row)
        total += row.get('bytes', 0)
        attributes += sum(len(base64.b64decode(value)) for value in row['xattrs'].values())
        for parent in PurePosixPath(name).parents:
            if str(parent) != '.':
                require(str(parent) in rows and rows[str(parent)]['type'] == 'directory', 'Missing or non-directory ancestor')
    require(total <= MAX_BYTES and attributes <= MAX_ALL_XATTR_BYTES and len(canonical_json(rows)) <= MAX_JSON,
            'Inventory exceeds explicit byte/metadata bound')


def _run(argv, *, timeout=30, maximum=8 * CHUNK, input=None):
    require(input is None, 'This bounded subprocess profile does not accept stdin')
    process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               env={**os.environ, 'LC_ALL': 'C', 'GIT_OPTIONAL_LOCKS': '0'}, close_fds=True)
    streams = selectors.DefaultSelector()
    output = {'out': bytearray(), 'err': bytearray()}
    deadline = time.monotonic() + timeout
    try:
        for name, stream in [('out', process.stdout), ('err', process.stderr)]:
            os.set_blocking(stream.fileno(), False)
            streams.register(stream, selectors.EVENT_READ, name)
        while streams.get_map():
            remaining = deadline - time.monotonic()
            require(remaining > 0, 'Read-only subprocess timed out')
            for key, _ in streams.select(min(remaining, 0.25)):
                block = os.read(key.fd, 65536)
                if not block:
                    streams.unregister(key.fileobj)
                else:
                    output[key.data].extend(block)
                    require(sum(map(len, output.values())) <= maximum, 'Read-only subprocess output exceeds bound')
        remaining = deadline - time.monotonic()
        require(remaining > 0, 'Read-only subprocess timed out')
        process.wait(timeout=remaining)
        return process.returncode, bytes(output['out']), bytes(output['err'])
    finally:
        streams.close()
        if process.poll() is None:
            process.kill()  # Only the observation subprocess started here.
            process.wait(timeout=5)
        process.stdout.close()
        process.stderr.close()


def command(argv, **kwargs):
    code, out, error = _run(argv, **kwargs)
    require(code == 0, 'Read-only command failed: ' + error.decode('utf-8', 'replace')[:4096])
    return out.decode('utf-8')


def capabilities():
    privilege = _metadata_privileges()
    executable = next((Path(name) for name in ('/usr/bin/lsof', '/usr/sbin/lsof') if Path(name).is_file()), None)
    require(executable is not None, 'System lsof is required; activity cannot be assumed clear')
    executable = canonical(str(executable.resolve(strict=True)))
    details = _stat(executable)
    require(details.st_uid == 0 and stat.S_IMODE(details.st_mode) & 0o022 == 0 and details.st_mode & 0o111,
            'lsof must be a root-owned system executable without group/other write access')
    return {'backend': 'linux-manual-ustar-gzip-1', 'metadataPolicy': POLICY,
            'python': sys.version.split()[0], 'machine': platform.machine(), 'lsof': file_ref(executable),
            'privilege': privilege,
            'inodeFlags': 'full equality; only EXTENT and directory INDEX bits accepted; never SETFLAGS'}


def selected_activity(root, rows, lsof=None):
    """Bounded lsof visibility, never represented as a global exclusion lock."""
    tool = lsof or capabilities()['lsof']
    executable = verify_ref(tool)
    try:
        code, out, error = _run([str(executable), '-nP', '-F0pcfDitn'])
        require(code == 0 and out and not error, 'lsof failed or reported incomplete visibility')
        selected = {str(root / name) for name in rows}
        selected_inodes = {(row['originalIdentity'][0], row['originalIdentity'][1]) for row in rows.values()}
        found = []
        pid = command_name = None
        record = None
        def finish():
            if record is None:
                return
            require(record['fd'] != 'NOFD', 'lsof could not inspect process descriptors')
            require(record.get('type') in ('REG', 'DIR', 'CHR', 'BLK', 'FIFO', 'IPv4', 'IPv6', 'unix',
                                          'netlink', 'a_inode', 'sock', 'PSXSEM', 'PSXMQ'),
                    'lsof reported an unknown/unsupported file type')
            if record['type'] in ('REG', 'DIR'):
                require('device' in record and 'inode' in record, 'Incomplete lsof filesystem identity')
            name = record.get('path', '')
            require(not any(marker in name for marker in ('(opendir:', '(readlink:', '(stat:', '(lstat:')),
                    'lsof reported an incomplete process-file observation')
            same_inode = (record.get('device'), record.get('inode')) in selected_inodes
            same_path = name in selected or name.removesuffix(' (deleted)') in selected
            if same_inode or same_path:
                found.append({**record, 'pid': pid, 'command': command_name})
        for token in out.split(b'\0'):
            token = token.removeprefix(b'\n')
            if not token:
                continue
            require(b'\n' not in token and b'\r' not in token, 'Malformed lsof field')
            tag, value = token[:1], token[1:].decode('utf-8', 'strict')
            if tag == b'p':
                finish()
                require(re.fullmatch('[1-9][0-9]*', value), 'Malformed lsof process')
                pid, command_name, record = value, None, None
            elif tag == b'c':
                command_name = value
            elif tag == b'f':
                finish()
                require(pid is not None, 'Unbound lsof descriptor')
                record = {'fd': value}
            elif tag == b'n':
                require(record is not None and 'path' not in record, 'Unbound/repeated lsof name')
                record['path'] = value
            elif tag == b't':
                require(record is not None and 'type' not in record, 'Unbound/repeated lsof type')
                record['type'] = value
            elif tag in (b'D', b'i'):
                field = 'device' if tag == b'D' else 'inode'
                require(record is not None and field not in record and
                        re.fullmatch(r'(?:0x)?[0-9a-fA-F]{1,16}' if tag == b'D' else r'[0-9]{1,20}', value),
                        'Malformed lsof inode identity')
                record[field] = int(value, 16 if tag == b'D' else 10)
            else:
                raise ArchiveError('Unexpected lsof field')
        finish()
        verify_ref(tool)
        return {'status': 'in-use' if found else 'clear', 'selectedOpenFiles': found, 'tool': tool,
                'qualification': 'Point-in-time exact selected paths visible to lsof; not a global writer lock',
                'capturedAt': now()}
    except (OSError, UnicodeError, subprocess.SubprocessError, ArchiveError) as error:
        raise ArchiveError('Source activity is unknown: ' + str(error)) from error


def _ustar_names(name):
    encoded = name.encode('utf-8')
    require(b'\0' not in encoded, 'NUL in archive path')
    if len(encoded) <= 100:
        return encoded, b''
    for index in range(len(encoded) - 1, -1, -1):
        if encoded[index:index + 1] == b'/' and 0 < index <= 155 and 0 < len(encoded) - index - 1 <= 100:
            return encoded[index + 1:], encoded[:index]
    raise ArchiveError('Path cannot be represented by strict USTAR')


def _octal(value, length):
    raw = format(value, 'o').encode('ascii')
    require(len(raw) < length, 'USTAR number overflow')
    return b'0' * (length - 1 - len(raw)) + raw + b'\0'


def _header(name, row):
    leaf, prefix = _ustar_names(name)
    block = bytearray(512)
    block[:len(leaf)] = leaf
    for start, length, value in [(100, 8, row['mode']), (108, 8, row['uid']), (116, 8, row['gid']),
                                 (124, 12, row.get('bytes', 0)), (136, 12, row['mtimeNs'] // 10 ** 9)]:
        block[start:start + length] = _octal(value, length)
    block[148:156] = b'        '
    block[156:157] = b'5' if row['type'] == 'directory' else b'0'
    block[257:265] = b'ustar\x0000'
    block[345:345 + len(prefix)] = prefix
    block[148:156] = format(sum(block), '06o').encode('ascii') + b'\0 '
    return bytes(block)


class _GzipReader:
    """One gzip stream only; bound expansion before allocating each output block."""
    def __init__(self, descriptor, maximum):
        self.descriptor = descriptor
        self.decoder = zlib.decompressobj(31)
        self.pending = b''
        self.buffer = bytearray()
        self.maximum = maximum
        self.count = 0
        self.compressed = 0
        self.done = False

    def read(self, count):
        require(0 <= count <= CHUNK, 'Oversized stream read')
        while len(self.buffer) < count and not self.done:
            incoming = self.pending
            if not incoming:
                incoming = os.read(self.descriptor, 65536)
                self.compressed += len(incoming)
                require(self.compressed <= MAX_BYTES + MAX_ENTRIES * 1024 + CHUNK, 'Compressed archive exceeds bound')
                require(incoming, 'Truncated gzip stream')
            try:
                output = self.decoder.decompress(incoming, min(CHUNK, self.maximum - self.count + 1))
            except zlib.error as error:
                raise ArchiveError('Invalid gzip stream') from error
            self.pending = self.decoder.unconsumed_tail
            self.count += len(output)
            require(self.count <= self.maximum, 'Archive expansion exceeds exact inventory bound')
            self.buffer.extend(output)
            if self.decoder.eof:
                require(not self.decoder.unused_data and not self.pending and not os.read(self.descriptor, 1),
                        'Concatenated gzip or trailing compressed bytes')
                self.done = True
        result = bytes(self.buffer[:count])
        del self.buffer[:count]
        return result


def _exact(stream, count):
    value = stream.read(count)
    require(len(value) == count, 'Truncated archive member')
    return value


def _archive_size(rows):
    return 1024 + sum(512 + ((row.get('bytes', 0) + 511) // 512) * 512 for row in rows.values())


def _walk_archive(path, rows, begin=None, write=None, end=None):
    _validate_rows(rows)
    path = canonical(str(path))
    descriptor = _open(path)
    try:
        before = os.fstat(descriptor)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1, 'Archive must be a single-link file')
        stream = _GzipReader(descriptor, _archive_size(rows))
        # Requiring each exact canonical header makes aliases, duplicate paths,
        # link/PAX/GNU members, oversized lengths and metadata mismatches invalid.
        for name, row in sorted(rows.items()):
            require(_exact(stream, 512) == _header(name, row), 'Archive header/order/membership differs: ' + name)
            target = begin(name, row) if begin is not None else None
            hashed = hashlib.sha256()
            remaining = row.get('bytes', 0)
            try:
                while remaining:
                    block = _exact(stream, min(CHUNK, remaining))
                    hashed.update(block)
                    if write is not None:
                        write(target, block)
                    remaining -= len(block)
                padding = (-row.get('bytes', 0)) % 512
                require(_exact(stream, padding) == b'\0' * padding, 'Nonzero tar padding')
                if row['type'] == 'file':
                    require(hashed.hexdigest() == row['sha256'], 'Archive content hash differs: ' + name)
            finally:
                if end is not None:
                    end(target)
        require(_exact(stream, 1024) == b'\0' * 1024 and stream.read(1) == b'' and stream.done,
                'Archive has extra/missing members or trailer')
        require(identity(before) == identity(os.fstat(descriptor)) == identity(_stat(path)), 'Archive changed during validation')
    finally:
        os.close(descriptor)
    return {'logicalMembers': len(rows), 'metadataMembers': 0, 'exactPathSet': True}


def validate_archive(path, rows):
    return _walk_archive(path, rows)


def _write_all(descriptor, block):
    offset = 0
    while offset < len(block):
        count = os.write(descriptor, block[offset:])
        require(count > 0, 'Short archive/file write')
        offset += count


def _write_archive(path, root, rows):
    descriptor = _open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
    compressor = zlib.compressobj(level=6, wbits=31)
    def emit(block):
        _write_all(descriptor, compressor.compress(block))
    try:
        for name, row in sorted(rows.items()):
            emit(_header(name, row))
            if row['type'] == 'file':
                source = _open(root / name)
                try:
                    before = os.fstat(source)
                    require(identity(before) == row['originalIdentity'], 'Source identity changed before copying')
                    count, hashed = _read_fd(source, row['bytes'], emit)
                    require(count == row['bytes'] and hashed == row['sha256'] and
                            identity(before) == identity(os.fstat(source)) == identity(_stat(root / name)),
                            'Source changed while copying')
                finally:
                    os.close(source)
                emit(b'\0' * ((-row['bytes']) % 512))
        emit(b'\0' * 1024)
        _write_all(descriptor, compressor.flush())
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _ref_shape(ref):
    keys(ref, ['path', 'hash', 'byteLength'])
    _absolute(ref['path'])
    require(isinstance(ref['hash'], str) and re.fullmatch('sha256:[0-9a-f]{64}', ref['hash']) and
            isinstance(ref['byteLength'], str) and re.fullmatch('0|[1-9][0-9]*', ref['byteLength']) and
            int(ref['byteLength']) <= MAX_BYTES + MAX_ENTRIES * 1024 + CHUNK, 'Malformed sealed file identity')


def file_ref(path):
    path = canonical(str(path))
    descriptor = _open(path)
    try:
        before = os.fstat(descriptor)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1, 'Sealed reference requires a single-link file')
        count, hashed = _read_fd(descriptor, MAX_BYTES + MAX_ENTRIES * 1024 + CHUNK)
        require(count == before.st_size and identity(before) == identity(os.fstat(descriptor)) == identity(_stat(path)),
                'Sealed file changed')
        return {'path': str(path), 'hash': 'sha256:' + hashed, 'byteLength': str(count)}
    finally:
        os.close(descriptor)


def verify_ref(ref):
    _ref_shape(ref)
    require(file_ref(Path(ref['path'])) == ref, 'Sealed file identity changed')
    return Path(ref['path'])


def sealed_json(ref, maximum=MAX_JSON):
    _ref_shape(ref)
    require(int(ref['byteLength']) <= maximum, 'Sealed JSON exceeds bound')
    data = read_bytes(canonical(ref['path']), maximum)
    require(str(len(data)) == ref['byteLength'] and 'sha256:' + digest(data) == ref['hash'], 'JSON differs from sealed identity')
    return decode_json(data)


def save(path, value):
    data = value if isinstance(value, bytes) else canonical_json(value) + b'\n'
    require(len(data) <= MAX_JSON, 'Saved record exceeds bound')
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


def new_destination(path, protected):
    path = canonical(str(path), exists=False)
    require(stat.S_ISDIR(_stat(path.parent).st_mode), 'Destination parent must exist')
    for other in protected:
        other = _absolute(other)
        require(not (path == other or path in other.parents or other in path.parents), 'Destination overlaps protected input')
    try:
        _stat(path)
    except FileNotFoundError:
        return path
    raise ArchiveError('Destination already exists')


def _mkdir(path):
    descriptor, name = _parent_fd(path)
    try:
        os.mkdir(name, 0o700, dir_fd=descriptor)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    value = _stat(path)
    require(stat.S_ISDIR(value.st_mode) and stat.S_IMODE(value.st_mode) == 0o700 and value.st_uid == os.geteuid(),
            'Destination was not created private and owned')


def space(parent, required):
    require(type(required) is int and required >= 0, 'Invalid space estimate')
    free = shutil.disk_usage(parent).free
    require(free >= required, 'Insufficient destination space')
    return {'requiredBytes': required, 'availableBytes': free}


def failure(destination, error):
    # Preserve incomplete evidence. Never clean up by following possibly changed paths.
    save(Path(destination) / ('failure-' + uuid.uuid4().hex + '.json'),
         {'status': 'incomplete', 'at': now(), 'error': str(error)[:4096], 'originalChangesAuthorized': False})


def _storage(value):
    require(type(value) is int and value in (17, 18), 'Explicit storageVersion 17 or 18 is required')


def _manifest(manifest):
    keys(manifest, ['kind', 'metadataPolicy', 'storageVersion', 'role', 'sourceRoot', 'includes', 'entries',
                    'provenance', 'archive', 'backend', 'capabilities', 'createdAt', 'activity', 'originalsUnchanged',
                    'originalDeletionAuthorized', 'status', 'logicalMembers', 'metadataMembers', 'exactPathSet'])
    require(manifest['kind'] == KIND and manifest['metadataPolicy'] == POLICY and
            manifest['status'] == 'copied-restore-pending' and manifest['originalsUnchanged'] is True and
            manifest['originalDeletionAuthorized'] is False and manifest['exactPathSet'] is True and
            type(manifest['metadataMembers']) is int and manifest['metadataMembers'] == 0, 'Unsupported/incomplete Linux transport')
    _storage(manifest['storageVersion'])
    _absolute(manifest['sourceRoot'])  # Historical identity only: never open it.
    require(isinstance(manifest['role'], str) and re.fullmatch('[A-Za-z0-9_-]{1,128}', manifest['role']) and
            isinstance(manifest['provenance'], dict), 'Invalid role/provenance')
    _includes(manifest['includes'])
    _validate_rows(manifest['entries'])
    require(type(manifest['logicalMembers']) is int and manifest['logicalMembers'] == len(manifest['entries']), 'Member count differs')
    selected = set(manifest['includes'])
    ancestors = {str(parent) for chosen in selected for parent in PurePosixPath(chosen).parents}
    for name in manifest['entries']:
        require(any(str(parent) in selected for parent in [PurePosixPath(name), *PurePosixPath(name).parents]) or
                name in ancestors, 'Inventory contains unselected member')
    require(selected <= set(manifest['entries']), 'Selected member absent')
    _ref_shape(manifest['archive'])
    _ref_shape(manifest['backend'])
    keys(manifest['activity'], ['before', 'after'])
    require(all(manifest['activity'][stage].get('status') == 'clear' for stage in ('before', 'after')),
            'Source activity was not clear')


def create(root, includes, destination, *, role, provenance, storageVersion):
    _storage(storageVersion)
    require(isinstance(role, str) and re.fullmatch('[A-Za-z0-9_-]{1,128}', role) and isinstance(provenance, dict),
            'Explicit role and provenance object required')
    require(len(canonical_json(provenance)) <= CHUNK, 'Provenance exceeds bound')
    caps = capabilities()
    root = canonical(str(root))
    destination = new_destination(destination, [root])
    before = inventory(root, includes)
    activity_before = selected_activity(root, before, caps['lsof'])
    require(activity_before['status'] == 'clear', 'Selected source is active')
    space(destination.parent, sum(row.get('bytes', 0) for row in before.values()) * 3 + len(before) * 32768 + MAX_JSON)
    _mkdir(destination)
    try:
        payload = destination / 'payload.tar.gz'
        _write_archive(payload, root, before)
        validation = validate_archive(payload, before)
        require(inventory(root, includes) == before, 'Source changed during copying')
        activity_after = selected_activity(root, before, caps['lsof'])
        require(activity_after['status'] == 'clear', 'Selected source became active')
        manifest = {'kind': KIND, 'metadataPolicy': POLICY, 'storageVersion': storageVersion, 'role': role,
                    'sourceRoot': str(root), 'includes': includes, 'entries': before, 'provenance': provenance,
                    'archive': file_ref(payload), 'backend': file_ref(Path(__file__).resolve()), 'capabilities': caps,
                    'createdAt': now(), 'activity': {'before': activity_before, 'after': activity_after},
                    'originalsUnchanged': True, 'originalDeletionAuthorized': False,
                    'status': 'copied-restore-pending', **validation}
        _manifest(manifest)
        save(destination / 'manifest.json', manifest)
        return {'archive': file_ref(payload), 'manifest': file_ref(destination / 'manifest.json')}
    except BaseException as error:
        failure(destination, error)
        raise


def _install_metadata(path, row):
    descriptor = _open(path)
    try:
        current = os.fstat(descriptor)
        require((stat.S_ISDIR(current.st_mode) if row['type'] == 'directory' else
                 stat.S_ISREG(current.st_mode) and current.st_nlink == 1), 'Installed object changed type')
        os.fchown(descriptor, row['uid'], row['gid'])
        os.fchmod(descriptor, row['mode'])
        # Creation may inherit ACLs/security labels. Remove only on this new owned
        # destination, and fail if any cannot be removed or exactly replaced.
        for name in os.listxattr(descriptor):
            if name not in row['xattrs']:
                os.removexattr(descriptor, name)
        for name, value in sorted(row['xattrs'].items()):
            os.setxattr(descriptor, name, base64.b64decode(value, validate=True))
        os.utime(descriptor, ns=(current.st_atime_ns, row['mtimeNs']))
        os.fsync(descriptor)
        require(_flags(descriptor, row['type'] == 'directory') == row['flags'], 'Installed full inode flags differ')
        require(identity(os.fstat(descriptor)) == identity(_stat(path)), 'Installed metadata target was replaced')
    finally:
        os.close(descriptor)


def _same_ref(left, right):
    _ref_shape(left)
    _ref_shape(right)
    return all(left[key] == right[key] for key in ('hash', 'byteLength'))


def verify_restore_record(proof, original, installed, expected):
    """Replay retained metadata evidence; never open descriptive original paths."""
    _manifest(original)
    keys(expected, ['archive', 'manifest'], ['name'])
    keys(installed, ['kind', 'sourceArchiveHash', 'sourceManifestHash', 'entries'])
    require(installed['kind'] == 'linux-installed-metadata-1' and
            installed['sourceArchiveHash'] == expected['archive']['hash'] and
            installed['sourceManifestHash'] == expected['manifest']['hash'], 'Installed record binding differs')
    _validate_rows(installed['entries'])
    require({name: portable(row) for name, row in original['entries'].items()} ==
            {name: portable(row) for name, row in installed['entries'].items()}, 'Retained exact metadata differs')
    keys(proof, ['kind', 'metadataPolicy', 'storageVersion', 'result', 'archive', 'manifest', 'restoredRoot',
                 'contentVerified', 'metadataVerified', 'exactMetadata', 'entries', 'installedManifest',
                 'originalDeletionAuthorized', 'verifiedAt'])
    require(proof['kind'] == 'linux-closure-restore-1' and proof['metadataPolicy'] == POLICY and
            proof['storageVersion'] == original['storageVersion'] and type(proof['storageVersion']) is int and
            proof['result'] == 'verified' and proof['contentVerified'] is True and proof['metadataVerified'] is True and
            proof['exactMetadata'] is True and proof['originalDeletionAuthorized'] is False and
            type(proof['entries']) is int and proof['entries'] == len(original['entries']), 'Incomplete restore proof')
    require(_same_ref(proof['archive'], expected['archive']) and _same_ref(proof['manifest'], expected['manifest']) and
            _same_ref(original['archive'], expected['archive']), 'Restore closure identity differs')
    _absolute(proof['restoredRoot'])
    _ref_shape(proof['installedManifest'])
    for record, ref in [(original, expected['manifest']), (installed, proof['installedManifest'])]:
        data = canonical_json(record) + b'\n'
        require('sha256:' + digest(data) == ref['hash'] and str(len(data)) == ref['byteLength'],
                'Retained record bytes are not bound to their identity')
    return {'result': 'verified', 'exactMetadata': True, 'entries': len(original['entries'])}


def verify_restore_set(records, expected, read_record):
    roles = ['source', 'application', 'fixture']
    require(isinstance(records, list) and len(records) == 3 and
            all(isinstance(item, dict) for item in records) and [item.get('role') for item in records] == roles and
            isinstance(expected, dict) and set(expected) == set(roles), 'Incomplete/duplicated restore roles')
    for item in records:
        keys(item, ['role', 'record'])
        proof = read_record(item['record'])
        verify_restore_record(proof, read_record(proof['manifest']), read_record(proof['installedManifest']),
                              expected[item['role']])


def restore(closure, destination):
    privilege = _metadata_privileges()
    keys(closure, ['archive', 'manifest'], ['name'])
    payload = verify_ref(closure['archive'])
    manifest = sealed_json(closure['manifest'])
    _manifest(manifest)
    require(_same_ref(manifest['archive'], closure['archive']), 'Manifest/archive binding differs')
    rows = manifest['entries']
    validate_archive(payload, rows)  # No destination exists until all members validate.
    destination = new_destination(destination, [payload.parent, Path(closure['manifest']['path']).parent,
                                                Path(manifest['sourceRoot'])])
    space(destination.parent, sum(row.get('bytes', 0) for row in rows.values()) + len(rows) * 32768 + MAX_JSON)
    _mkdir(destination)
    try:
        root = destination / 'root'
        _mkdir(root)
        def begin(name, row):
            path = root / name
            if row['type'] == 'directory':
                _mkdir(path)
                return None
            return _open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
        def write(descriptor, block):
            require(descriptor is not None, 'Cannot write a directory')
            _write_all(descriptor, block)
        def end(descriptor):
            if descriptor is not None:
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
        _walk_archive(payload, rows, begin, write, end)
        # Children first: final directory mtimes and inherited ACLs are not later
        # changed by creating a descendant. No chmod/chown follows xattr install.
        for name in sorted(rows, key=lambda item: (len(PurePosixPath(item).parts), item), reverse=True):
            _install_metadata(root / name, rows[name])
        after = inventory(root, manifest['includes'])
        require({name: portable(row) for name, row in after.items()} ==
                {name: portable(row) for name, row in rows.items()}, 'Fresh restore differs in exact bytes or metadata')
        # Inventory selections include ancestor directories without recursively
        # selecting their siblings. Walk all actual members to forbid extras.
        actual = set()
        def walk(path, prefix=''):
            descriptor = _open(path, os.O_RDONLY | os.O_DIRECTORY)
            try:
                for child in _children(descriptor, len(rows) - len(actual)):
                    name = prefix + child
                    relative(name)
                    require(name in rows and name not in actual, 'Unexpected restored member')
                    actual.add(name)
                    if rows[name]['type'] == 'directory':
                        walk(path / child, name + '/')
            finally:
                os.close(descriptor)
        walk(root)
        require(actual == set(rows), 'Fresh restore membership differs')
        root_descriptor = _open(root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(root_descriptor)
        finally:
            os.close(root_descriptor)
        require(_metadata_privileges() == privilege, 'Metadata privilege boundary changed')
        verify_ref(closure['archive'])
        verify_ref(closure['manifest'])
        installed = {'kind': 'linux-installed-metadata-1', 'sourceArchiveHash': closure['archive']['hash'],
                     'sourceManifestHash': closure['manifest']['hash'], 'entries': after}
        save(destination / 'installed-manifest.json', installed)
        proof = {'kind': 'linux-closure-restore-1', 'metadataPolicy': POLICY, 'storageVersion': manifest['storageVersion'],
                 'result': 'verified', 'archive': closure['archive'], 'manifest': closure['manifest'],
                 'restoredRoot': str(root), 'contentVerified': True, 'metadataVerified': True, 'exactMetadata': True,
                 'entries': len(rows), 'installedManifest': file_ref(destination / 'installed-manifest.json'),
                 'originalDeletionAuthorized': False, 'verifiedAt': now()}
        verify_restore_record(proof, manifest, installed, closure)
        save(destination / 'restore.json', proof)
        return root, file_ref(destination / 'restore.json')
    except BaseException as error:
        failure(destination, error)
        raise
