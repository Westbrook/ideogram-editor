#!/usr/bin/env python3
"""Copy-only review archives. Never execute packet helpers or modify source evidence."""
import argparse
import base64
import ctypes
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import struct
import subprocess
import sys
import tarfile
import uuid


class ArchiveError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise ArchiveError(message)


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'Duplicate JSON key: ' + key)
        result[key] = value
    return result


def decode_json(data):
    return json.loads(data, object_pairs_hook=unique_object)


def relative(value):
    require(isinstance(value, str) and value and '\\' not in value
            and not any(ord(c) < 32 or ord(c) == 127 for c in value), 'Invalid relative path')
    p = PurePosixPath(value)
    require(not p.is_absolute() and '..' not in p.parts and '.' not in p.parts
            and str(p) == value and value != '.', 'Unsafe path: ' + value)
    require(not any(part.startswith('._') for part in p.parts),
            'AppleDouble-like source names are unsupported: ' + value)
    return value


def below(name, prefix):
    return name == prefix or name.startswith(prefix + '/')


def hash_string(value):
    require(isinstance(value, str) and re.fullmatch('[0-9a-f]{64}', value), 'Expected SHA-256')


def keys(obj, required, optional=()):
    require(isinstance(obj, dict), 'Expected an object')
    require(set(required) <= set(obj) and set(obj) <= set(required) | set(optional),
            'Missing or unsupported fields: ' + str(sorted(set(required) ^ set(obj))))


def canonical(path, exists=True):
    p = Path(path)
    require(p.is_absolute() and p == p.resolve(strict=exists),
            'Use a canonical absolute path without symlinks: ' + str(p))
    return p


def schema(d):
    keys(d, ['schemaVersion', 'packetId', 'sourceRoot', 'include', 'review', 'seals',
             'closingRecords', 'lineage', 'dependencies'])
    require(type(d['schemaVersion']) is int and d['schemaVersion'] == 1, 'Unsupported schema version')
    require(isinstance(d['packetId'], str) and re.fullmatch('[a-z0-9][a-z0-9-]{0,100}', d['packetId']),
            'Invalid packetId')
    canonical(d['sourceRoot'], exists=False)
    keys(d['review'], ['kind', 'target', 'verdict'])
    require(d['review']['kind'] in ['author', 'independent-review'], 'Unsupported review kind')
    require(isinstance(d['review']['target'], str) and re.fullmatch('[0-9a-f]{40}', d['review']['target']),
            'Expected full target commit')
    require(isinstance(d['review']['verdict'], str) and d['review']['verdict'], 'Historical verdict required')
    for field in ['include', 'seals', 'closingRecords', 'lineage', 'dependencies']:
        require(isinstance(d[field], list), field + ' must be an array')
    require(d['include'] and d['seals'], 'At least one selection and seal are required')
    names = [relative(n) for n in d['include']]
    require(all(not below(a, b) for i, a in enumerate(names) for j, b in enumerate(names) if i != j),
            'Duplicate or overlapping selections')
    roots = []
    for seal in d['seals']:
        keys(seal, ['reader', 'root', 'manifest', 'manifestSHA256', 'exclude', 'immutable'],
             ['seal', 'sealSHA256', 'target'])
        require(seal['reader'] in ['files-json-v1', 'sha256sums-v1'], 'Unsupported seal reader')
        relative(seal['root']); relative(seal['manifest']); hash_string(seal['manifestSHA256'])
        require(seal['root'] not in roots, 'Duplicate seal root'); roots.append(seal['root'])
        require(isinstance(seal['exclude'], list), 'exclude must be an array')
        for name in seal['exclude']:
            relative(name)
        require(len(set(seal['exclude'])) == len(seal['exclude']), 'Duplicate seal exclusion')
        require(seal['immutable'] in ['files', 'all'], 'Unsupported metadata/link policy')
        if seal['reader'] == 'files-json-v1':
            require('seal' in seal and 'sealSHA256' in seal, 'JSON reader needs seal and sealSHA256')
            relative(seal['seal']); hash_string(seal['sealSHA256'])
            require(seal['seal'] != seal['manifest'], 'Seal cannot be its own manifest')
        else:
            require('seal' not in seal and 'sealSHA256' not in seal and 'target' not in seal,
                    'Unexpected JSON seal fields')
        if 'target' in seal:
            require(seal['target'] == d['review']['target'], 'Seal target differs from review target')
    for record in d['closingRecords']:
        keys(record, ['path'], ['sha256'])
        relative(record['path'])
        if 'sha256' in record:
            hash_string(record['sha256'])
    for relation in d['lineage']:
        keys(relation, ['relationship', 'reference'])
        require(all(isinstance(v, str) and v for v in relation.values()), 'Invalid lineage')
    for dep in d['dependencies']:
        keys(dep, ['kind', 'location', 'description'], ['path', 'sha256', 'target'])
        require(dep['kind'] in ['git-bundle', 'source-snapshot', 'reference', 'runtime']
                and dep['location'] in ['included', 'external'] and isinstance(dep['description'], str),
                'Unsupported dependency')
        if dep['location'] == 'included':
            require('path' in dep, 'Included dependency needs a path'); relative(dep['path'])
        if 'sha256' in dep:
            hash_string(dep['sha256'])
        if 'target' in dep:
            require(dep['target'] == d['review']['target'], 'Bundle target differs from review target')
    return d


def command(argv, **kwargs):
    result = subprocess.run(argv, capture_output=True, text=True,
                            env={**os.environ, 'GIT_OPTIONAL_LOCKS': '0'}, **kwargs)
    require(result.returncode == 0, f'{argv[0]} failed: {result.stderr.strip()}')
    return result.stdout


def capabilities():
    require(sys.platform == 'darwin', 'This version requires macOS metadata support')
    require(hasattr(stat, 'UF_IMMUTABLE'), 'File flags are unavailable')
    version = command(['/usr/bin/tar', '--version']).strip()
    require('bsdtar' in version, 'The macOS bsdtar backend is required')
    return {'backend': 'macos-bsdtar-pax-gzip', 'tar': version, 'python': sys.version.split()[0]}


def xattrs(path):
    # The host Python may omit os.listxattr; Darwin's no-follow API remains available.
    lib = ctypes.CDLL(None, use_errno=True)
    lib.listxattr.argtypes = [ctypes.c_char_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int]
    lib.listxattr.restype = ctypes.c_ssize_t
    lib.getxattr.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_void_p,
                           ctypes.c_size_t, ctypes.c_uint32, ctypes.c_int]
    lib.getxattr.restype = ctypes.c_ssize_t
    size = lib.listxattr(os.fsencode(path), None, 0, 1)
    require(size >= 0, 'Cannot read xattrs: ' + str(path))
    buf = ctypes.create_string_buffer(size)
    require(lib.listxattr(os.fsencode(path), buf, size, 1) == size, 'Xattrs changed while reading')
    values = {}
    for name in sorted(n for n in buf.raw[:size].split(b'\0') if n):
        length = lib.getxattr(os.fsencode(path), name, None, 0, 0, 1)
        require(length >= 0, 'Cannot read xattr value')
        value = ctypes.create_string_buffer(length)
        require(lib.getxattr(os.fsencode(path), name, value, length, 0, 1) == length,
                'Xattr changed while reading')
        values[os.fsdecode(name)] = base64.b64encode(value.raw[:length]).decode()
    return values


def identity(s):
    return [s.st_dev, s.st_ino, s.st_mode, s.st_nlink, s.st_size, s.st_mtime_ns,
            s.st_ctime_ns, s.st_uid, s.st_gid, s.st_flags]


def read_bytes(path):
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as stream:
        before = os.fstat(stream.fileno())
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1, 'Expected single-link file: ' + str(path))
        data = stream.read()
        require(identity(before) == identity(os.fstat(stream.fileno())) == identity(path.lstat()),
                'File changed while reading: ' + str(path))
        return data


def file_hash(path):
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as stream:
        before = os.fstat(stream.fileno())
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1, 'Expected single-link file: ' + str(path))
        h = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
        require(identity(before) == identity(os.fstat(stream.fileno())) == identity(path.lstat()),
                'File changed while hashing: ' + str(path))
        return h.hexdigest()


def entry(path):
    s = path.lstat()
    require(stat.S_ISREG(s.st_mode) or stat.S_ISDIR(s.st_mode), 'Unsupported link/special file: ' + str(path))
    row = {'type': 'directory' if stat.S_ISDIR(s.st_mode) else 'file',
           'mode': stat.S_IMODE(s.st_mode), 'mtimeNs': s.st_mtime_ns, 'flags': s.st_flags,
           'uid': s.st_uid, 'gid': s.st_gid, 'xattrs': xattrs(path),
           'acl': command(['/bin/ls', '-lde', str(path)]).splitlines()[1:],
           'originalIdentity': identity(s)}
    if row['type'] == 'file':
        row.update(bytes=s.st_size, sha256=file_hash(path), nlink=s.st_nlink)
    require(identity(s) == identity(path.lstat()), 'Metadata changed while reading: ' + str(path))
    return row


def snapshot(d, root):
    canonical(str(root)); require(root.is_dir(), 'Source root is not a directory')
    rows = {}

    def visit(name, recurse):
        relative(name)
        path = root / name
        require(path == path.resolve(strict=True), 'Symlink in selected path: ' + name)
        row = entry(path)
        rows[name] = row
        if recurse and row['type'] == 'directory':
            for child in sorted(path.iterdir()):
                visit(name + '/' + child.name, True)
            require(identity(path.lstat()) == row['originalIdentity'], 'Directory changed while reading: ' + name)

    for name in d['include']:
        for parent in reversed(PurePosixPath(name).parents):
            if str(parent) != '.' and str(parent) not in rows:
                visit(str(parent), False)
        visit(name, True)
    return dict(sorted(rows.items()))


def validate_seals(d, root, rows):
    receipts, covered = [], set()
    for rule in d['seals']:
        prefix = rule['root'] + '/'
        require(any(below(rule['root'], name) for name in d['include']),
                'Select the entire seal root: ' + rule['root'])
        require(rule['root'] in rows and rows[rule['root']]['type'] == 'directory', 'Seal root not selected')
        local = {n[len(prefix):]: row for n, row in rows.items() if n.startswith(prefix)}
        controls = [rule['manifest']] + ([rule['seal']] if 'seal' in rule else [])
        for name, expected in zip(controls, [rule['manifestSHA256'], rule.get('sealSHA256')]):
            require(name in local and local[name].get('sha256') == expected, 'Seal identity mismatch: ' + prefix + name)
        excluded = rule['exclude']
        for name in excluded:
            require(name in local, 'Missing excluded path: ' + prefix + name)
        actual = {n for n, row in local.items() if row['type'] == 'file' and n not in controls
                  and not any(below(n, x) for x in excluded)}
        if rule['reader'] == 'files-json-v1':
            manifest = decode_json(read_bytes(root / prefix / rule['manifest']))
            seal = decode_json(read_bytes(root / prefix / rule['seal']))
            files = manifest['files']
            require(isinstance(files, dict), 'FILES.json needs a files object')
            require(seal['manifestSHA256'] == rule['manifestSHA256']
                    and seal['manifestBytes'] == local[rule['manifest']]['bytes'], 'Manifest seal mismatch')
            if 'target' in rule:
                require(seal.get('target') == rule['target'], 'Sealed target mismatch')
            require(len(files) == seal.get('payloadFiles', seal.get('files')), 'Sealed file count mismatch')
            require(sum(v['bytes'] for v in files.values()) == seal.get('payloadBytes', seal.get('bytes')),
                    'Sealed byte count mismatch')
        else:
            files = {}
            for line in read_bytes(root / prefix / rule['manifest']).decode().splitlines():
                parts = line.split('  ', 1)
                require(len(parts) == 2 and parts[1] not in files, 'Malformed/duplicate checksum line')
                hash_string(parts[0]); files[parts[1]] = {'sha256': parts[0]}
        for name in files:
            relative(name)
        require(set(files) == actual, 'Seal exact path set mismatch: ' + rule['root'])
        for name, expected in files.items():
            hash_string(expected['sha256']); row = local[name]
            require(row['sha256'] == expected['sha256'] and row['bytes'] == expected.get('bytes', row['bytes']),
                    'Payload mismatch: ' + prefix + name)
        required_flags = actual | set(controls)
        if rule['immutable'] == 'all':
            required_flags |= {n for n, row in local.items() if row['type'] == 'directory'
                               and not any(below(n, x) for x in excluded)}
            require(rows[rule['root']]['flags'] & stat.UF_IMMUTABLE, 'Seal root is not immutable')
        for name in required_flags:
            require(local[name]['flags'] & stat.UF_IMMUTABLE, 'Seal requires immutable flag: ' + prefix + name)
        covered.update(prefix + name for name in actual | set(controls))
        receipts.append({'root': rule['root'], 'reader': rule['reader'], 'files': len(actual),
                         'manifestSHA256': rule['manifestSHA256'], 'verified': True})
    sidecars = set()
    for record in d['closingRecords']:
        row = rows.get(record['path'], {})
        require(row.get('type') == 'file', 'Closing record not selected: ' + record['path'])
        require(row['sha256'] == record.get('sha256', row['sha256']), 'Closing record digest mismatch')
        sidecars.add(record['path'])
    for dep in d['dependencies']:
        if dep['location'] == 'included':
            require(dep['path'] in rows, 'Included dependency not selected: ' + dep['path'])
            if 'sha256' in dep:
                require(rows[dep['path']].get('sha256') == dep['sha256'], 'Dependency digest mismatch')
            sidecars.update(n for n in rows if below(n, dep['path']))
    unsealed = {n for n, row in rows.items() if row['type'] == 'file'} - covered
    require(unsealed <= sidecars, 'Unclassified unsealed files: ' + str(sorted(unsealed - sidecars)))
    return {'seals': receipts, 'unsealedFiles': sorted(unsealed)}


def dependencies(d, root):
    result = []
    for dep in d['dependencies']:
        receipt = dict(dep)
        if dep['location'] == 'external':
            receipt['availability'] = 'not-verified'
        elif dep['kind'] == 'git-bundle':
            path = root / dep['path']
            require('sha256' in dep and 'target' in dep, 'Bundle needs expected SHA-256 and target')
            require(file_hash(path) == dep['sha256'], 'Bundle digest mismatch')
            header = []
            with path.open('rb') as stream:
                for _ in range(10000):
                    line = stream.readline(65537)
                    require(0 < len(line) <= 65536, 'Invalid bundle header')
                    if line == b'\n':
                        break
                    header.append(line.decode().rstrip('\n'))
                else:
                    raise ArchiveError('Bundle header too large')
            require(header and header[0] in ['# v2 git bundle', '# v3 git bundle'], 'Unsupported bundle version')
            prerequisites = [line[1:].split(' ', 1)[0] for line in header[1:] if line.startswith('-')]
            heads = command(['git', 'bundle', 'list-heads', str(path)])
            require(any(line.split(' ', 1)[0] == dep['target'] for line in heads.splitlines()),
                    'Bundle does not advertise exact target')
            # Uses this existing repository only to check prerequisites. No clone, fetch or object writes.
            verification = command(['git', '-C', str(Path(__file__).resolve().parent.parent),
                                    'bundle', 'verify', str(path)])
            receipt.update(availability='included', prerequisites=prerequisites, heads=heads.splitlines(),
                           history='prerequisite-dependent' if prerequisites else 'complete',
                           verification=verification, qualification='Bundle header/prerequisites checked; no workload rerun')
        else:
            receipt['availability'] = 'included'
        result.append(receipt)
    return result


def activity(root):
    try:
        r = subprocess.run(['lsof', '-nP', '-Fpcfn'], capture_output=True, text=True, timeout=30)
        if r.returncode or r.stderr.strip():
            return {'status': 'unknown', 'reason': r.stderr.strip() or 'lsof failed', 'openFiles': []}
        found = []; pid = command_name = fd = None
        for line in r.stdout.splitlines():
            if line.startswith('p'):
                pid = line[1:]
            elif line.startswith('c'):
                command_name = line[1:]
            elif line.startswith('f'):
                fd = line[1:]
            elif line.startswith('n') and below(line[1:], str(root)):
                found.append({'pid': pid, 'command': command_name, 'fd': fd, 'path': line[1:]})
        return {'status': 'in-use' if found else 'clear', 'openFiles': found,
                'qualification': 'Point-in-time observation of files visible to this user; not a global writer lock'}
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {'status': 'unknown', 'reason': str(exc), 'openFiles': []}


def inspect_packet(descriptor):
    caps = capabilities()
    raw = read_bytes(canonical(str(descriptor)))
    d = schema(decode_json(raw)); root = canonical(d['sourceRoot'])
    root_identity = identity(root.stat())
    observed = activity(root)
    rows = snapshot(d, root)
    seals = validate_seals(d, root, rows)
    deps = dependencies(d, root)
    require(rows == snapshot(d, root) and root_identity == identity(root.stat()), 'Source changed during inspection')
    holds = [] if observed['status'] == 'clear' else ['Source activity is ' + observed['status']]
    return {'descriptor': d, 'descriptorSHA256': digest(raw), 'entries': rows, **seals,
            'dependencies': deps, 'capabilities': caps, 'activity': observed, 'holds': holds,
            'ready': not holds, 'logicalBytes': sum(r.get('bytes', 0) for r in rows.values()),
            'sourceRootIdentity': root_identity, 'capturedAt': now()}, raw


def portable(row):
    return {k: v for k, v in row.items() if k != 'originalIdentity'}


def validate_archive(path, rows):
    actual, metadata = set(), set()
    with tarfile.open(path, 'r:gz') as tf:
        require(not tf.pax_headers, 'Global archive headers are unsupported')
        for member in tf:
            name = member.name.rstrip('/')
            # AppleDouble names are accepted only here, with a known logical target.
            p = PurePosixPath(name)
            require(name and not p.is_absolute() and '..' not in p.parts and str(p) == name
                    and '\\' not in name and not any(ord(c) < 32 or ord(c) == 127 for c in name),
                    'Unsafe archive member: ' + name)
            require(name not in actual, 'Duplicate archive member: ' + name)
            require(member.type in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE),
                    'Unsupported archive member type: ' + name)
            for key in member.pax_headers:
                require(key in ['path', 'mtime', 'atime', 'ctime', 'size', 'LIBARCHIVE.creationtime',
                                'SCHILY.fflags', 'SCHILY.acl.access', 'SCHILY.acl.default', 'SCHILY.acl.ace']
                        or key.startswith(('LIBARCHIVE.xattr.', 'SCHILY.xattr.')),
                        'Unsupported archive header: ' + key)
            actual.add(name)
            if name not in rows:
                target = str(p.with_name(p.name[2:])) if p.name.startswith('._') and len(p.name) > 2 else None
                require(target in rows and member.isfile() and 26 <= member.size <= 16 * 1024 * 1024,
                        'Unplanned archive member: ' + name)
                content = tf.extractfile(member).read()
                require(struct.unpack('>II', content[:8]) == (0x00051607, 0x00020000), 'Invalid AppleDouble header')
                count = struct.unpack('>H', content[24:26])[0]; end = 26 + count * 12
                require(count > 0 and end <= len(content), 'Invalid AppleDouble table')
                ranges = []; ids = set()
                for i in range(count):
                    ident, offset, size = struct.unpack('>III', content[26+i*12:38+i*12])
                    require(ident not in ids and offset >= end and offset + size <= len(content),
                            'Invalid AppleDouble entry')
                    require(all(offset + size <= start or offset >= stop for start, stop in ranges),
                            'Overlapping AppleDouble entries')
                    ids.add(ident); ranges.append((offset, offset + size))
                metadata.add(name)
            else:
                expected = rows[name]
                require(member.isdir() == (expected['type'] == 'directory'), 'Archive type mismatch: ' + name)
                if member.isfile():
                    require(member.size == expected['bytes'], 'Archive size mismatch: ' + name)
                    h = hashlib.sha256()
                    stream = tf.extractfile(member)
                    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                        h.update(chunk)
                    require(member.size == expected['bytes'] and h.hexdigest() == expected['sha256'],
                            'Archive content mismatch: ' + name)
                else:
                    require(member.size == 0, 'Directory member contains data')
        require(not tf.pax_headers, 'Global archive headers are unsupported')
    require(actual - metadata == set(rows), 'Archive member set mismatch')
    return {'logicalMembers': len(rows), 'metadataMembers': len(metadata), 'exactPathSet': True}


def save(path, value):
    data = value if isinstance(value, bytes) else (json.dumps(value, indent=2, ensure_ascii=False) + '\n').encode()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data); stream.flush(); os.fsync(stream.fileno())


def new_destination(path, protected):
    path = canonical(str(path), exists=False)
    canonical(str(path.parent))
    for other in protected:
        other = canonical(str(other), exists=False)
        require(not (path == other or path in other.parents or other in path.parents),
                'Destination overlaps protected input: ' + str(other))
    require(not path.exists(), 'Destination already exists: ' + str(path))
    return path


def space(parent, required):
    free = shutil.disk_usage(parent).free
    require(free >= required, f'Insufficient space: need {required} bytes; available {free}')
    return {'requiredBytes': required, 'availableBytes': free}


def failure(destination, exc):
    save(destination / ('failure-' + uuid.uuid4().hex + '.json'),
         {'status': 'incomplete', 'at': now(), 'error': str(exc), 'originalChangesAuthorized': False})


def create(descriptor, destination):
    inspection, raw = inspect_packet(descriptor)
    require(inspection['ready'], 'Cannot copy: ' + ', '.join(inspection['holds']))
    d = inspection['descriptor']; root = Path(d['sourceRoot']); rows = inspection['entries']
    destination = new_destination(destination, [root, descriptor])
    estimate = inspection['logicalBytes'] * 3 + len(rows) * 32768 + 64 * 1024 * 1024
    capacity = space(destination.parent, estimate)
    require(activity(root)['status'] == 'clear', 'Source is in use or activity check unavailable')
    destination.mkdir(mode=0o700)
    try:
        save(destination / 'descriptor.json', raw)
        save(destination / 'inventory.json', inspection)
        archive = destination / 'payload.tar.gz'
        # A fixed NUL-delimited member list prevents implicit traversal of new files or option injection.
        argv = ['/usr/bin/tar', '--format', 'pax', '--fflags', '--xattrs', '--acls', '--mac-metadata',
                '--no-recursion', '-czf', str(archive), '-C', str(root), '--null', '-T', '-']
        command(argv, input='\0'.join(rows) + '\0')
        os.chmod(archive, 0o600)
        validation = validate_archive(archive, rows)
        require(snapshot(d, root) == rows and identity(root.stat()) == inspection['sourceRootIdentity'],
                'Source changed while copying')
        require(activity(root)['status'] == 'clear', 'Source activity changed while copying')
        receipt = {'schemaVersion': 1, 'runId': destination.name + '-' + uuid.uuid4().hex,
                   'status': 'copied_restore_pending', 'createdAt': now(), 'packetId': d['packetId'],
                   'archiveSHA256': file_hash(archive), 'archiveBytes': archive.stat().st_size,
                   'descriptorSHA256': digest(raw), 'toolSHA256': file_hash(Path(__file__).resolve()),
                   'tools': inspection['capabilities'], 'argv': argv, 'space': capacity,
                   'originalsUnchanged': True, 'originalDeletionAuthorized': False, **validation}
        save(destination / 'create.json', receipt)
        names = ['descriptor.json', 'inventory.json', 'create.json', 'payload.tar.gz']
        sums = ''.join(file_hash(destination / n) + '  ' + n + '\n' for n in names).encode()
        save(destination / 'RUN-SHA256SUMS', sums)
        return {**receipt, 'run': str(destination), 'runSHA256': digest(sums),
                'nextAction': 'Keep runSHA256 separately and pass it to verify; originals stay in place.'}
    except BaseException as exc:
        failure(destination, exc)
        raise


def verified_run(run, expected):
    canonical(str(run)); hash_string(expected)
    raw = read_bytes(run / 'RUN-SHA256SUMS')
    require(digest(raw) == expected, 'Run trust anchor mismatch')
    names = ['descriptor.json', 'inventory.json', 'create.json', 'payload.tar.gz']
    lines = raw.decode().splitlines()
    require(len(lines) == len(names), 'Invalid run manifest')
    for line, name in zip(lines, names):
        pieces = line.split('  ', 1)
        require(len(pieces) == 2 and pieces[1] == name, 'Invalid run manifest member')
        hash_string(pieces[0])
        require(file_hash(run / name) == pieces[0], 'Run checksum mismatch: ' + name)
    d = schema(decode_json(read_bytes(run / 'descriptor.json')))
    inventory = decode_json(read_bytes(run / 'inventory.json'))
    receipt = decode_json(read_bytes(run / 'create.json'))
    require(receipt['status'] == 'copied_restore_pending' and receipt['originalsUnchanged'] is True,
            'Run creation did not finish')
    require(inventory['descriptor'] == d and inventory['descriptorSHA256'] == receipt['descriptorSHA256']
            == file_hash(run / 'descriptor.json'), 'Inconsistent descriptor identity')
    require(receipt['archiveSHA256'] == file_hash(run / 'payload.tar.gz'), 'Inconsistent archive identity')
    return d, inventory, receipt


def verify(run, destination, expected):
    caps = capabilities()
    d, inventory, creation = verified_run(run, expected)
    destination = new_destination(destination, [run, Path(d['sourceRoot'])])
    rows = inventory['entries']; archive = run / 'payload.tar.gz'
    space(destination.parent, inventory['logicalBytes'] + len(rows) * 32768 + 64 * 1024 * 1024)
    validation = validate_archive(archive, rows)
    destination.mkdir(mode=0o700)
    try:
        root = destination / 'payload'; root.mkdir(mode=0o700)
        argv = ['/usr/bin/tar', '-xpf', '-', '--fflags', '--xattrs', '--acls', '--mac-metadata', '-C', str(root)]
        with archive.open('rb') as stream:
            command(argv, stdin=stream)
        restored = snapshot(d, root)
        actual_paths = {str(p.relative_to(root)) for p in root.rglob('*')}
        require(actual_paths == set(rows), 'Unexpected restored entries')
        content = all(restored[n].get('sha256') == rows[n].get('sha256')
                      and restored[n].get('bytes') == rows[n].get('bytes') for n in rows)
        differences = [n for n in rows if portable(restored[n]) != portable(rows[n])]
        comparison = {'contentVerified': content, 'metadataVerified': not differences,
                      'differences': differences, 'entries': len(rows)}
        save(destination / 'comparison.json', comparison)
        require(content and not differences, 'Restored content/metadata mismatch: ' + ', '.join(differences[:5]))
        seals = validate_seals(d, root, restored)
        deps = dependencies(d, root)
        verified_run(run, expected)
        catalog = {'schemaVersion': 1, 'status': 'restore-verified', 'verifiedAt': now(),
                   'runId': creation['runId'], 'run': str(run), 'runSHA256': expected,
                   'packetId': d['packetId'], 'sourceRoot': d['sourceRoot'], 'include': d['include'],
                   'review': d['review'], 'lineage': d['lineage'], 'dependencies': deps, **seals,
                   'archiveSHA256': creation['archiveSHA256'], 'archiveBytes': creation['archiveBytes'],
                   'descriptorSHA256': creation['descriptorSHA256'], 'creatorToolSHA256': creation['toolSHA256'],
                   'verifierToolSHA256': file_hash(Path(__file__).resolve()), 'tools': caps,
                   'restoredRoot': str(root), **validation, **comparison,
                   'originalsUnchangedDuringCreation': True, 'originalDeletionAuthorized': False,
                   'humanReviewed': False, 'productAcceptance': 'unchanged',
                   'limits': ['Copy-only; same-volume storage is not an off-device backup.',
                              'Transport verification does not change the historical verdict.',
                              'External dependencies remain external; no workload was rerun.',
                              'Original source availability is not required or re-certified by verify.']}
        save(destination / 'catalog.json', catalog)
        sums = ''.join(file_hash(destination / n) + '  ' + n + '\n'
                       for n in ['catalog.json', 'comparison.json']).encode()
        save(destination / 'VERIFICATION-SHA256SUMS', sums)
        return {'status': catalog['status'], 'catalog': str(destination / 'catalog.json'),
                'verificationSHA256': digest(sums), **comparison}
    except BaseException as exc:
        failure(destination, exc)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest='action', required=True)
    inspect_parser = actions.add_parser('inspect', help='Read-only source and seal inspection')
    inspect_parser.add_argument('--descriptor', type=Path, required=True)
    create_parser = actions.add_parser('create', help='Copy to an exclusive new run directory')
    create_parser.add_argument('--descriptor', type=Path, required=True)
    create_parser.add_argument('--destination', type=Path, required=True)
    verify_parser = actions.add_parser('verify', help='Verify saved identities and restore to a new directory')
    verify_parser.add_argument('--run', type=Path, required=True)
    verify_parser.add_argument('--restore-to', type=Path, required=True)
    verify_parser.add_argument('--expected-run-sha256', required=True,
                               help='runSHA256 returned by create, retained separately from the run')
    args = parser.parse_args()
    try:
        if args.action == 'inspect':
            result, _ = inspect_packet(args.descriptor)
        elif args.action == 'create':
            result = create(args.descriptor, args.destination)
        else:
            result = verify(args.run, args.restore_to, args.expected_run_sha256)
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return 0 if result.get('ready', True) else 1
    except (ArchiveError, OSError, ValueError, KeyError, TypeError, tarfile.TarError) as exc:
        print(json.dumps({'status': 'failed', 'error': str(exc), 'originalChangesAuthorized': False}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
