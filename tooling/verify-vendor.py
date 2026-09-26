#!/usr/bin/env python3
"""Verify immutable producer inputs and archives before installing any dependencies."""
import base64
import hashlib
import json
from pathlib import Path
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[1]
NAMES = ['tokens', 'styles', 'primitives', 'elements']

def fail(message):
    raise SystemExit(message)

def sha(data):
    return hashlib.sha256(data).hexdigest()

def verify(root=ROOT):
    package = json.loads((root / 'package.json').read_text())
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
    lock_path = root / 'package-lock.json'
    if lock_path.exists():
        lock = json.loads(lock_path.read_text())
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
            if '@en-reve/' not in path and location and not location.startswith('https://registry.npmjs.org/'):
                fail(f'Nonregistry third-party dependency: {path} {location}')
            if item.get('link'):
                fail(f'Consumer symlink dependency: {path}')
        for name in ['lit', 'signal-polyfill', 'signal-utils']:
            if lock['packages'][f'node_modules/{name}']['version'] != package['dependencies'][name]:
                fail(f'Peer pin mismatch: {name}')
    print(f'Verified {len(records)} frozen files and four archives: {identity}')
    return identity

if __name__ == '__main__':
    verify(Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT)
