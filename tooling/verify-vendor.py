#!/usr/bin/env python3
"""Verify immutable producer inputs and archives before installing any dependencies."""
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[1]
NAMES = ['tokens', 'styles', 'primitives', 'elements']
CANVASKIT_VERSION = '0.40.0-ideogram.3'
CANVASKIT_PATH = f'vendor/text/canvaskit-wasm-{CANVASKIT_VERSION}.tgz'

def fail(message):
    raise SystemExit(message)

def sha(data):
    return hashlib.sha256(data).hexdigest()

def owned_bytes(root, relative, label='CanvasKit'):
    path = Path(relative)
    if path.is_absolute() or '..' in path.parts or path.as_posix() != relative or '\\' in relative:
        fail(f'Unsafe {label} path: {relative}')
    target = root
    for part in path.parts:
        target = target / part
        if target.is_symlink():
            fail(f'Unsafe {label} link: {relative}')
    try:
        info = target.stat()
    except FileNotFoundError:
        fail(f'Missing required {label} file: {relative}')
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid():
        fail(f'Unsafe {label} file: {relative}')
    fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(fd)
        if (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns) != (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns):
            fail(f'Changed {label} file: {relative}')
        with os.fdopen(os.dup(fd), 'rb') as stream:
            data = stream.read()
        after = target.lstat()
        if (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns, after.st_nlink) != (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns, 1) or len(data) != info.st_size:
            fail(f'Changed {label} file: {relative}')
        return data
    finally:
        os.close(fd)

def verify_canvaskit(root, package, lock):
    """One declared local package, checked from frozen inputs without node_modules."""
    spec = 'file:' + CANVASKIT_PATH
    if package['dependencies'].get('canvaskit-wasm') != spec:
        fail('CanvasKit dependency must use the declared portable archive')
    raw = owned_bytes(root, 'src/text/profile.json')
    if owned_bytes(root, 'vendor/text/manifest.json') != raw:
        fail('CanvasKit profile/manifest mismatch')
    profile = json.loads(raw)
    identity = profile.pop('id')
    if identity != 'sha256:' + sha(json.dumps(profile, separators=(',', ':'), ensure_ascii=False).encode()):
        fail('CanvasKit profile identity mismatch')
    engine = profile['engine']
    if engine['package'] != 'canvaskit-wasm' or engine['version'] != CANVASKIT_VERSION:
        fail('CanvasKit engine identity mismatch')
    records = json.loads(owned_bytes(root, 'vendor/text/FILES.json'))
    for relative, data in [('vendor/text/manifest.json', raw), (CANVASKIT_PATH, owned_bytes(root, CANVASKIT_PATH))]:
        matches = [r for r in records if r['path'] == relative]
        if len(matches) != 1 or len(data) != matches[0]['bytes'] or sha(data) != matches[0]['sha256']:
            fail(f'CanvasKit provenance mismatch: {relative}')
    data = owned_bytes(root, CANVASKIT_PATH)
    if len(data) != engine['tarball']['bytes'] or sha(data) != engine['tarball']['sha256']:
        fail('CanvasKit archive mismatch')
    key = 'node_modules/canvaskit-wasm'
    matches = [k for k in lock['packages'] if k.endswith(key)]
    if matches != [key]:
        fail('Duplicated or missing CanvasKit dependency')
    item = lock['packages'][key]
    integrity = 'sha512-' + base64.b64encode(hashlib.sha512(data).digest()).decode()
    if (item.get('link') or item.get('version') != CANVASKIT_VERSION or item.get('resolved') != spec
            or item.get('integrity') != integrity or lock['packages']['']['dependencies'].get('canvaskit-wasm') != spec):
        fail('Lockfile CanvasKit identity mismatch')
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        members = archive.getmembers()
        expected = {'package/LICENSE', 'package/bin/canvaskit.js', 'package/bin/canvaskit.wasm',
                    'package/package.json', 'package/types/index.d.ts'}
        if len(members) != len(expected) or {m.name for m in members} != expected or any(not m.isfile() for m in members):
            fail('Unsafe CanvasKit package archive')
        packed = json.load(archive.extractfile('package/package.json'))
        fields = {'name': 'canvaskit-wasm', 'version': CANVASKIT_VERSION, 'main': 'bin/canvaskit.js',
                  'types': 'types/index.d.ts', 'license': 'BSD-3-Clause'}
        if any(packed.get(k) != v for k, v in fields.items()) or set(packed) != set(fields) | {'description'}:
            fail('Packed CanvasKit identity mismatch')
        for part, member in [('js', 'package/bin/canvaskit.js'), ('wasm', 'package/bin/canvaskit.wasm')]:
            content = archive.extractfile(member).read()
            if len(content) != engine[part]['bytes'] or sha(content) != engine[part]['sha256']:
                fail(f'Packed CanvasKit {part} mismatch')
        notices = [r for r in profile['notices'] if r['path'] == 'vendor/text/notices/custom-skia-LICENSE.txt']
        content = archive.extractfile('package/LICENSE').read()
        if len(notices) != 1 or len(content) != notices[0]['bytes'] or sha(content) != notices[0]['sha256']:
            fail('Packed CanvasKit license mismatch')

def verify(root=ROOT):
    package = json.loads(owned_bytes(root, 'package.json', 'consumer'))
    lock = json.loads(owned_bytes(root, 'package-lock.json', 'consumer'))
    paths = {}
    for name in NAMES:
        spec = package['dependencies'][f'@en-reve/{name}']
        if not spec.startswith('file:vendor/en-reve/') or '..' in Path(spec[5:]).parts:
            fail(f'Nonportable vendor location: {spec}')
        paths[name] = root / spec[5:]
    directories = {p.parent for p in paths.values()}
    if len(directories) != 1:
        fail('All four packages must use one snapshot')
    directory = directories.pop()
    manifest = json.loads((directory / 'source-manifest.json').read_text())
    packages = json.loads((directory / 'packages.json').read_text())
    producer = json.loads((directory / 'producer-receipt.json').read_text())
    records = manifest['files']
    identity = sha(json.dumps(records, separators=(',', ':'), ensure_ascii=False).encode())
    if identity != manifest['sourceIdentity'] or directory.name != identity or packages['sourceIdentity'] != identity or producer['sourceIdentity'] != identity:
        fail('Source manifest identity mismatch')
    if producer['status'] != 'passed' or any(c['exit'] != 0 for c in producer['commands']):
        fail('Producer did not pass')
    config = json.loads((root / 'tooling/toolchain.json').read_text())
    if producer['toolchain'] != config:
        fail('Producer toolchain differs from the selected toolchain')
    for name, details in {manifest['sourceArchive']['path']: manifest['sourceArchive'], **manifest['provenance']}.items():
        data = (directory / name).read_bytes()
        if len(data) != details['bytes'] or sha(data) != details['sha256']:
            fail(f'Provenance checksum mismatch: {name}')
    if records != sorted(records, key=lambda item: item['path']) or len({r['path'] for r in records}) != len(records):
        fail('Source manifest paths must be unique and sorted')
    with tarfile.open(directory / manifest['sourceArchive']['path']) as archive:
        members = archive.getmembers()
        if [m.name for m in members] != [r['path'] for r in records]:
            fail('Source archive inventory mismatch')
        for member, record in zip(members, records):
            if not member.isfile() or Path(member.name).is_absolute() or '..' in Path(member.name).parts:
                fail(f'Unsafe archived source: {member.name}')
            data = archive.extractfile(member).read()
            if len(data) != record['bytes'] or sha(data) != record['sha256'] or member.mode != record['mode']:
                fail(f'Source file mismatch: {member.name}')
        license_bytes = archive.extractfile('LICENSE').read()
        if license_bytes != (directory / 'LICENSE').read_bytes():
            fail('Source license mismatch')
    by_name = {p['name']: p for p in packages['packages']}
    if sorted(by_name) != sorted(f'@en-reve/{n}' for n in NAMES):
        fail('Expected exactly four coherent runtime packages')
    for name in NAMES:
        path, item = paths[name], by_name[f'@en-reve/{name}']
        data = path.read_bytes()
        integrity = 'sha512-' + base64.b64encode(hashlib.sha512(data).digest()).decode()
        if path.name != item['filename'] or len(data) != item['bytes'] or sha(data) != item['sha256'] or integrity != item['integrity'] or hashlib.sha1(data).hexdigest() != item['shasum']:
            fail(f'Package archive mismatch: {name}')
        with tarfile.open(path) as archive:
            members = archive.getmembers()
            if len({m.name for m in members}) != len(members) or any(not m.isfile() or not m.name.startswith('package/') or '..' in Path(m.name).parts for m in members):
                fail(f'Unsafe package archive: {name}')
            packed = json.load(archive.extractfile('package/package.json'))
            for field in ['name', 'version', 'dependencies', 'peerDependencies']:
                if packed.get(field, {}) != item.get(field, {}):
                    fail(f'Packed graph mismatch: {name} {field}')
            if archive.extractfile('package/LICENSE').read() != license_bytes:
                fail(f'License missing or changed: {name}')
    verify_canvaskit(root, package, lock)
    for name in NAMES:
        key = f'node_modules/@en-reve/{name}'
        matches = [k for k in lock['packages'] if k.endswith(f'node_modules/@en-reve/{name}')]
        if matches != [key]:
            fail(f'Duplicated or missing private dependency: {name}')
        item = lock['packages'][key]
        if item.get('link') or item['resolved'] != package['dependencies'][f'@en-reve/{name}'] or item['integrity'] != by_name[f'@en-reve/{name}']['integrity']:
            fail(f'Lockfile vendor identity mismatch: {name}')
    for path, item in lock['packages'].items():
        location = item.get('resolved', '')
        if '@en-reve/' not in path and path != 'node_modules/canvaskit-wasm' and location and not location.startswith('https://registry.npmjs.org/'):
            fail(f'Nonregistry third-party dependency: {path} {location}')
        if item.get('link'):
            fail(f'Consumer symlink dependency: {path}')
    for name in ['lit', 'signal-polyfill', 'signal-utils']:
        if lock['packages'][f'node_modules/{name}']['version'] != package['dependencies'][name]:
            fail(f'Peer pin mismatch: {name}')
    print(f'Verified {len(records)} frozen files and four En Reve archives: {identity}; sealed CanvasKit {CANVASKIT_VERSION}')
    return identity

if __name__ == '__main__':
    verify(Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT)
