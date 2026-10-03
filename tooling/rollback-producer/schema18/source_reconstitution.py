"""Reconstitute reviewed foreign source bytes for a new Linux build.

This is deliberately not an exact metadata restore and never emits an executable
pin. The retained origin archive/manifest remain authoritative provenance. The
new Linux tree is a distinct source artifact whose subsequent exact transport,
compilation, and fresh executable restore must all be qualified independently.
"""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import struct
import sys
import tarfile

MAX_ENTRIES = 200000
MAX_BYTES = 8 * 1024 ** 3
MAX_METADATA = 16 * 1024 ** 2
POLICY = 'linux-source-bytes-modes-reconstitution-1'

class SourceError(Exception): pass

def require(value, message):
    if not value: raise SourceError(message)

def canonical(value):
    path = Path(value)
    require(path.is_absolute() and path == path.resolve(strict=True), 'Canonical existing input required')
    return path

def relative(value, metadata=False):
    require(isinstance(value, str) and value and value != '.' and len(value) <= 4096, 'Invalid source path')
    path = PurePosixPath(value)
    require(not path.is_absolute() and str(path) == value and all(part not in ('.', '..') for part in path.parts)
            and '\\' not in value and not any(ord(c) < 32 or ord(c) == 127 for c in value), 'Unsafe source path')
    require(metadata or not any(p.startswith('._') for p in path.parts), 'Source collides with foreign metadata namespace')
    return value

def unique(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'Duplicate metadata key'); result[key] = value
    return result

def stable(st):
    return (st.st_dev, st.st_ino, st.st_mode, st.st_nlink, st.st_size, st.st_mtime_ns, st.st_ctime_ns)

def file_ref(path, maximum=MAX_BYTES, expected_size=None):
    path = canonical(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and 0 <= before.st_size <= maximum
                and (expected_size is None or before.st_size == expected_size), 'Single-link bounded regular source input required')
        h = hashlib.sha256(); count = 0
        while chunk := os.read(fd, min(1024 ** 2, maximum + 1 - count)):
            count += len(chunk); require(count <= maximum and count <= before.st_size, 'Source input exceeds admitted bytes'); h.update(chunk)
        require(stable(before) == stable(os.fstat(fd)) == stable(path.lstat()), 'Source input changed')
        return {'path': str(path), 'hash': 'sha256:' + h.hexdigest(), 'byteLength': str(before.st_size)}
    finally: os.close(fd)

def pinned(ref, limit):
    require(isinstance(ref, dict) and set(ref) == {'path', 'hash', 'byteLength'}, 'Malformed source reference')
    require(isinstance(ref['hash'], str) and re.fullmatch(r'sha256:[0-9a-f]{64}', ref['hash'])
            and isinstance(ref['byteLength'], str) and re.fullmatch(r'0|[1-9][0-9]*', ref['byteLength'])
            and int(ref['byteLength']) <= limit, 'Invalid source reference bounds')
    require(file_ref(ref['path'], limit, int(ref['byteLength'])) == ref, 'Source trust anchor differs')
    return Path(ref['path'])

def read_json(ref):
    path = pinned(ref, 64 * 1024 ** 2)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd); data = bytearray()
        require(before.st_nlink == 1 and before.st_size == int(ref['byteLength']), 'Source metadata changed')
        while chunk := os.read(fd, 1024 ** 2):
            require(len(data) + len(chunk) <= int(ref['byteLength']), 'Source metadata grew'); data.extend(chunk)
        require('sha256:' + hashlib.sha256(data).hexdigest() == ref['hash']
                and stable(before) == stable(os.fstat(fd)) == stable(path.lstat()), 'Parsed metadata differs from trust anchor')
        return json.loads(data, object_pairs_hook=unique)
    finally: os.close(fd)

class BoundedTarInfo(tarfile.TarInfo):
    def _proc_pax(self, archive):
        require(0 <= self.size <= MAX_METADATA, 'PAX metadata exceeds bound')
        archive._source_metadata_bytes = getattr(archive, '_source_metadata_bytes', 0) + self.size
        archive._source_extension_count = getattr(archive, '_source_extension_count', 0) + 1
        require(archive._source_metadata_bytes + getattr(archive, '_source_appledouble_bytes', 0) <= 64 * 1024 ** 2 and archive._source_extension_count <= MAX_ENTRIES, 'Aggregate PAX metadata exceeds bound')
        return super()._proc_pax(archive)
    def _proc_gnulong(self, archive):
        raise SourceError('GNU extension is not part of the retained source transport')

def check_appledouble(data):
    require(26 <= len(data) <= MAX_METADATA and struct.unpack('>II', data[:8]) == (0x00051607, 0x00020000), 'Invalid foreign metadata')
    count = struct.unpack('>H', data[24:26])[0]; end = 26 + 12 * count
    require(count > 0 and end <= len(data), 'Invalid foreign metadata entries')
    ids, ranges = set(), []
    for i in range(count):
        ident, offset, size = struct.unpack('>III', data[26+i*12:38+i*12])
        require(ident not in ids and offset >= end and offset + size <= len(data), 'Invalid foreign metadata range')
        ids.add(ident); ranges.append((offset, offset + size))
    previous_end = end
    for start, stop in sorted(ranges):
        require(start >= previous_end, 'Overlapping foreign metadata'); previous_end = stop

def reconstitute(archive_ref, manifest_ref, destination, *, storage_version):
    require(sys.platform == 'linux', 'Linux source reconstitution must run on Linux')
    require(type(storage_version) is int and storage_version in (17, 18), 'Explicit source storage version required')
    manifest = read_json(manifest_ref); origin = pinned(archive_ref, MAX_BYTES)
    require(manifest.get('kind') == 'schema17-closure-transport-2'
            and manifest.get('metadataPolicy') == 'schema17-executable-metadata-2'
            and manifest.get('originalsUnchanged') is True
            and manifest.get('status') == 'copied-restore-pending', 'Unsupported retained origin transport')
    require(all(manifest['archive'][key] == archive_ref[key] for key in ('hash', 'byteLength')), 'Origin archive/manifest mismatch')
    rows = manifest['entries']
    require(isinstance(rows, dict) and 0 < len(rows) <= MAX_ENTRIES, 'Source inventory bound')
    total = 0
    for name, row in rows.items():
        relative(name)
        require(row.get('type') in ('file', 'directory') and type(row.get('mode')) is int
                and 0 <= row['mode'] <= 0o777, 'Unsupported source type or privileged mode')
        for ancestor in PurePosixPath(name).parents:
            if str(ancestor) != '.': require(rows.get(str(ancestor), {}).get('type') == 'directory', 'Missing typed source ancestor')
        if row['type'] == 'file':
            require(row.get('nlink') == 1 and type(row.get('bytes')) is int and row['bytes'] >= 0
                    and isinstance(row.get('sha256'), str) and re.fullmatch('[0-9a-f]{64}', row['sha256']), 'Malformed source leaf')
            total += row['bytes']; require(total <= MAX_BYTES, 'Source byte bound')
    dest = Path(destination)
    require(dest.is_absolute() and not dest.exists() and dest.parent == dest.parent.resolve(strict=True), 'New canonical destination required')
    for protected in (origin, Path(manifest_ref['path'])):
        require(dest != protected and dest not in protected.parents and protected not in dest.parents, 'Destination overlaps origin')
    disk = os.statvfs(dest.parent)
    require(disk.f_bavail * disk.f_frsize >= total * 2 + len(rows) * 32768 + 64 * 1024 ** 2, 'Insufficient source reconstitution headroom')
    dest.mkdir(mode=0o700); target = dest / 'source'; target.mkdir(mode=0o700)
    # Ancestors stay private/writeable until all bytes are verified. No extractall,
    # source ownership changes, links, special entries, or archive-supplied names
    # beyond the authenticated exact inventory are accepted.
    for name, row in sorted(rows.items(), key=lambda x: (len(PurePosixPath(x[0]).parts), x[0])):
        if row['type'] == 'directory': (target / name).mkdir(mode=0o700)
    seen = set(); logical = set(); metadata_bytes = 0
    fd = os.open(origin, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd); require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and str(before.st_size) == archive_ref['byteLength'], 'Invalid or linked source archive')
        with os.fdopen(os.dup(fd), 'rb') as source, tarfile.open(fileobj=source, mode='r|gz', tarinfo=BoundedTarInfo) as bundle:
            require(not bundle.pax_headers, 'Global headers refused')
            for member in bundle:
                name = relative(member.name.rstrip('/'), metadata=True)
                require(name not in seen and len(seen) < MAX_ENTRIES * 2 and member.type in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE), 'Duplicate/unsupported source member'); seen.add(name)
                require(not bundle.pax_headers, 'Global headers refused')
                for key in member.pax_headers:
                    require(key in ('path','mtime','atime','ctime','size','LIBARCHIVE.creationtime','SCHILY.fflags','SCHILY.acl.access','SCHILY.acl.default','SCHILY.acl.ace')
                            or key.startswith(('LIBARCHIVE.xattr.','SCHILY.xattr.')), 'Unsupported source extension')
                if name not in rows:
                    path = PurePosixPath(name); mapped = str(path.with_name(path.name[2:])) if path.name.startswith('._') else None
                    require(mapped in rows and member.isfile() and 26 <= member.size <= MAX_METADATA, 'Undeclared source member')
                    metadata_bytes += member.size; bundle._source_appledouble_bytes = metadata_bytes
                    require(metadata_bytes + getattr(bundle, '_source_metadata_bytes', 0) <= 64 * 1024 ** 2, 'Foreign metadata total bound')
                    stream = bundle.extractfile(member); check_appledouble(stream.read(MAX_METADATA + 1)); continue
                row = rows[name]; logical.add(name)
                require(member.isdir() == (row['type'] == 'directory'), 'Source type differs')
                if member.isdir(): require(member.size == 0, 'Directory payload refused'); continue
                require(member.size == row['bytes'], 'Source length differs'); stream = bundle.extractfile(member)
                output = os.open(target / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                try:
                    h = hashlib.sha256(); count = 0
                    while chunk := stream.read(1024 ** 2):
                        count += len(chunk); require(count <= row['bytes'], 'Source member grew'); h.update(chunk)
                        view = memoryview(chunk)
                        while view:
                            n = os.write(output, view); require(n > 0, 'Short source write'); view = view[n:]
                    require(count == row['bytes'] and h.hexdigest() == row['sha256'], 'Source bytes differ')
                    os.fchmod(output, row['mode']); os.fsync(output)
                finally: os.close(output)
        require(logical == set(rows) and stable(before) == stable(os.fstat(fd)) == stable(origin.lstat()), 'Source membership or origin changed')
        require(file_ref(origin) == archive_ref, 'Origin archive changed during reconstitution')
        installed = {}
        for name, row in rows.items():
            if row['type'] == 'directory': continue
            ref = file_ref(target / name)
            require(ref['hash'] == 'sha256:' + row['sha256'] and ref['byteLength'] == str(row['bytes']), 'Installed source differs')
            installed[name] = {'type':'file','mode':row['mode'],'bytes':row['bytes'],'sha256':row['sha256']}
        for name, row in sorted(rows.items(), key=lambda x: len(PurePosixPath(x[0]).parts), reverse=True):
            if row['type'] == 'directory': os.chmod(target / name, row['mode']); installed[name] = {'type':'directory','mode':row['mode']}
        require(read_json(manifest_ref) == manifest, 'Origin manifest changed during projection')
        record = {'kind':POLICY,'storageVersion':storage_version,'originArchive':archive_ref,'originManifest':manifest_ref,
                  'sourceRoot':str(target),'entries':installed,'sourceBytesModesIdentity':'sha256:'+hashlib.sha256(json.dumps(installed,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode('utf-8')).hexdigest(),
                  'originalMetadataRetained':True,'metadataEquivalent':False,'ownership':'new Linux owner; exact source bytes and modes only','executableQualified':False}
        path = dest / 'reconstitution.json'; payload = (json.dumps(record,sort_keys=True,indent=2)+'\n').encode()
        out = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            view = memoryview(payload)
            while view:
                count = os.write(out, view); require(count > 0, 'Short record write'); view = view[count:]
            os.fsync(out)
        finally: os.close(out)
        return target, file_ref(path)
    finally: os.close(fd)
