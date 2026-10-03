#!/usr/bin/env python3
"""Separate Linux schema18 rollback producer. No action happens without an explicit subcommand."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import signal
import shlex
import stat
import subprocess
import sys
import tarfile
import time
from transport import archive, canonical_json, content_id, file_ref, verify_ref, sealed_json, inventory, acquire, create_owned, restore_owned
from toolchain import authenticate
from linux_host import native_host
from linux_build import HELPERS, BUILD_ROLES, build as build_linux
from prepare_source_input import prepare as prepare_source
from foreign_source import foreign_source_manifest
from linux_build_evidence import verify_linux_build

HERE = Path(__file__).resolve().parent
CAPABILITY18 = 'sha256:c2eb7167875862e82da5f86dc52238001c09852a25c62d2f1bf9be9a2c3f0752'
OWNED_OUTPUTS = set()


OWNED_TREES = []


def acquire_tree(destination, *, provenance, storageVersion=18):
    archive.require(storageVersion == 18, 'Producer family differs')
    tree = acquire(destination, provenance=provenance, storageVersion=storageVersion)
    OWNED_TREES.append(tree)
    return tree


def owned_tree(root):
    root = Path(root)
    matches = [tree for tree in OWNED_TREES if root == tree.root or tree.root in root.parents]
    archive.require(len(matches) == 1, 'Root has no unique live construction capability')
    return matches[0]


def create(root, includes, destination, *, role, provenance, storageVersion=18):
    archive.require(type(storageVersion) is int and storageVersion == 18, 'Producer family differs')
    return create_owned(owned_tree(root), root, includes, destination, role=role, provenance=provenance, storageVersion=storageVersion)


def restore(closure, destination):
    archive.keys(closure, ['archive', 'manifest'], ['name'])
    archive.require(sealed_json(closure['manifest'])['storageVersion'] == 18, 'Restore family differs')
    root, proof, tree = restore_owned({key: closure[key] for key in ['archive', 'manifest']}, destination)
    OWNED_TREES.append(tree)
    return root, proof


def load(path):
    return archive.decode_json(archive.read_bytes(Path(path)))


def trusted(path, expected):
    archive.require(isinstance(expected, str) and re.fullmatch('sha256:[0-9a-f]{64}', expected), 'A separately retained SHA-256 trust anchor is required')
    data = archive.read_bytes(archive.canonical(str(path)))
    archive.require(len(data) <= 64 * 1024 * 1024 and 'sha256:' + archive.digest(data) == expected, 'Input trust anchor changed')
    return archive.decode_json(data)


def packet_identity(packet):
    def without_paths(value, pointer=()):
        if isinstance(value, list): return [without_paths(item, (*pointer, index)) for index, item in enumerate(value)]
        if isinstance(value, dict):
            kind = reference_kind(value, pointer)
            return {key: without_paths(item, (*pointer, key)) for key, item in value.items() if not (key == 'path' and kind == 'file')}
        return value
    return content_id(without_paths(packet))


def reference_kind(value, pointer=()):
    """Absolute evidence refs and the one declared relative content schema."""
    if not isinstance(value, dict) or set(value) != {'path', 'hash', 'byteLength'}: return None
    path = value['path']; digest = value['hash']; length = value['byteLength']
    archive.require(isinstance(path, str) and isinstance(digest, str) and re.fullmatch(r'sha256:[0-9a-f]{64}', digest) and
                    isinstance(length, str) and re.fullmatch(r'0|[1-9][0-9]*', length) and int(length) <= 2 ** 53 - 1, 'Malformed evidence/content identity')
    if os.path.isabs(path):
        archive.require(os.path.normpath(path) == path, 'Noncanonical evidence reference')
        return 'file'
    archive.require(len(pointer) == 3 and pointer[:2] == ('retained', 'objects') and type(pointer[2]) is int and
                    path == 'sha256/' + digest[7:9] + '/' + digest[7:], 'Unknown or unbound relative content reference')
    return 'object'


def verify_observation_objects(value, declared_root, objects):
    archive.require(value.get('kind') == 'schema18-executable-observation-1' and value.get('storageVersion') == 18 and
                    value.get('root') == declared_root and os.path.isabs(declared_root) and os.path.normpath(declared_root) == declared_root,
                    'Relative content observation has no declared fixture root')
    rows = value['retained']['objects']; archive.require(isinstance(rows, list) and len(rows) <= 200000, 'Invalid observed object inventory')
    observed = {}
    for index, item in enumerate(rows):
        archive.require(reference_kind(item, ('retained', 'objects', index)) == 'object' and item['path'] not in observed, 'Duplicate/malformed relative object')
        observed[item['path']] = {key: item[key] for key in ['hash', 'byteLength']}
    archive.require(observed == objects, 'Observed relative object bytes or membership differ from the declared fixture')


def fixture_objects(root):
    root = archive.canonical(str(root))
    rows = inventory(root, ['objects'])
    return {name.removeprefix('objects/'): {'hash': 'sha256:' + row['sha256'], 'byteLength': str(row['bytes'])}
            for name, row in rows.items() if name.startswith('objects/') and row['type'] == 'file'}


def archive_fixture_objects(manifest, stream):
    expected = {name: row for name, row in manifest['entries'].items() if name.startswith('objects/') and row['type'] == 'file'}
    archive.require(len(expected) <= 200000 and sum(row['bytes'] for row in expected.values()) <= 1024 ** 3, 'Fixture objects exceed verification bounds')
    found = {}
    with tarfile.open(fileobj=stream, mode='r:gz') as bundle:
        for member in bundle:
            name = member.name.rstrip('/')
            if name not in expected: continue
            row = expected[name]
            archive.require(name not in found and member.isfile() and member.size == row['bytes'], 'Fixture object archive member differs')
            digest = hashlib.sha256()
            with bundle.extractfile(member) as incoming:
                for block in iter(lambda: incoming.read(1024 * 1024), b''): digest.update(block)
            archive.require(digest.hexdigest() == row['sha256'], 'Fixture object archive bytes differ')
            found[name] = {'hash': 'sha256:' + row['sha256'], 'byteLength': str(row['bytes'])}
    archive.require(set(found) == set(expected), 'Fixture object archive membership differs')
    return {name.removeprefix('objects/'): value for name, value in found.items()}


def packet_pin(packet):
    return {'kind': 'schema18-executable-pin-1', 'packetId': packet['packetId'], 'identityHash': packet_identity(packet), 'platform': packet['platform']}


def current_platform():
    archive.require(sys.platform == 'linux' and platform.machine() in ('aarch64', 'x86_64'), 'Linux x64/arm64 producer required')
    return {'os': 'linux', 'arch': 'arm64' if platform.machine() == 'aarch64' else 'x64', 'release': platform.release(), 'machine': platform.machine()}


def closure_identity(closures):
    return content_id([{'name': item['name'], **{key: {field: item[key][field] for field in ['hash', 'byteLength']} for key in ['archive', 'manifest']}} for item in closures])


def validate_packet(packet):
    archive.require(packet.get('kind') == 'schema18-executable-packet-1' and packet.get('storageVersion') == 18 and packet.get('capabilityHash') == CAPABILITY18 and packet.get('verifiedFreshRestore', {}).get('result') == 'verified', 'Only a verified schema18 executable packet is accepted')
    archive.require(re.fullmatch('[A-Za-z0-9_-]{1,128}', packet['packetId']) and packet['compiler']['name'] == 'typescript' and packet['compiler']['version'] == '7.0.2', 'Invalid packet/compiler identity')
    archive.require(packet['toolchain']['node'] == '26.10.0' and packet['toolchain']['npm'] == '12.1.0', 'Wrong packet toolchain')
    archive.require(packet['platform']['os'] == sys.platform and packet['platform']['arch'] == current_platform()['arch'] and packet['platform']['identity'] == content_id(current_platform()), 'Packet native platform does not match this installation')
    archive.require(0 < len(packet['compiledClosures']) <= 32 and len({item['name'] for item in packet['compiledClosures']}) == len(packet['compiledClosures']), 'Invalid compiled closures')
    refs = [packet['sourceArchive'], packet['sourceManifest'], *[item[key] for item in packet['compiledClosures'] for key in ['archive', 'manifest']], packet['verifiedFreshRestore']['receipt']]
    for ref in refs: verify_ref(ref)
    proof = packet['verifiedFreshRestore']; receipt = sealed_json(proof['receipt'], 65536)
    archive.require(int(proof['receipt']['byteLength']) <= 65536 and receipt.get('kind') == 'schema18-fresh-restore-1' and receipt.get('storageVersion') == 18 and receipt.get('capabilityHash') == CAPABILITY18 and receipt.get('result') == 'verified', 'Invalid executable proof receipt')
    archive.require(proof['sourceArchiveHash'] == packet['sourceArchive']['hash'] == receipt['sourceArchiveHash'] and proof['compiledClosureHash'] == closure_identity(packet['compiledClosures']) == receipt['compiledClosureHash'], 'Restore receipt names different archives')
    for field, expected in [('toolchainIdentity', packet['toolchain']['identity']), ('dependencyIdentity', packet['dependencies']['identity']), ('nativeProfileHash', packet['native']['profileHash']), ('platformIdentity', packet['platform']['identity'])]:
        archive.require(receipt[field] == expected, 'Restore identity differs: ' + field)
    archive.require(receipt['checks'] == {'freshRestore': True, 'openExistingSchema18': True, 'refuseFutureSchema19': True, 'replayByteIdentity': True, 'networkEffects': 0} and type(receipt['checks']['networkEffects']) is int, 'Required actual restore checks are missing')
    evidence = [item for item in packet['compiledClosures'] if item['name'] == 'qualification-evidence']
    archive.require(len(evidence) == 1, 'Durable qualification evidence closure is required')
    manifest = sealed_json(evidence[0]['manifest'])
    archive.require(manifest.get('kind') == 'linux-owned-closure-transport-1' and manifest.get('metadataPolicy') == 'linux-owned-construction-metadata-1' and manifest.get('storageVersion') == 18 and manifest.get('originalsUnchanged') is True and
                    {key: manifest['archive'][key] for key in ['hash', 'byteLength']} == {key: evidence[0]['archive'][key] for key in ['hash', 'byteLength']}, 'Evidence archive/manifest binding differs')
    archive.validate_archive(Path(evidence[0]['archive']['path']), manifest['entries'])
    with tarfile.open(evidence[0]['archive']['path'], 'r:gz') as bundle:
        def bytes_at(name, maximum=64 * 1024 * 1024):
            archive.relative(name); member = bundle.getmember(name)
            archive.require(member.isfile() and member.size <= maximum, 'Invalid evidence JSON member')
            with bundle.extractfile(member) as stream: data = stream.read()
            row = manifest['entries'][name]
            archive.require(row['type'] == 'file' and len(data) == row['bytes'] and archive.digest(data) == row['sha256'], 'Parsed evidence member differs from sealed manifest')
            return data
        index_bytes = bytes_at('index.json', 4 * 1024 * 1024)
        archive.require('sha256:' + archive.digest(index_bytes) == receipt['evidence']['index']['hash'] and str(len(index_bytes)) == receipt['evidence']['index']['byteLength'], 'Evidence index differs from restore receipt')
        index = archive.decode_json(index_bytes)
        archive.require(index['kind'] == 'schema18-evidence-index-1' and len(index['entries']) <= 2048, 'Invalid evidence index')
        available = {(item['hash'], item['byteLength']) for item in [packet['sourceArchive'], packet['sourceManifest'], *[item[key] for item in packet['compiledClosures'] if item['name'] != 'qualification-evidence' for key in ['archive', 'manifest']]]}
        entries = {}
        for item in index['entries']:
            key = (item['hash'], item['byteLength']); path = 'blobs/' + item['hash'].removeprefix('sha256:')
            archive.require(key not in entries and item['path'] == path, 'Duplicate or invalid evidence blob')
            row = manifest['entries'][path]
            archive.require('sha256:' + row['sha256'] == item['hash'] and str(row['bytes']) == item['byteLength'], 'Evidence blob identity differs')
            entries[key] = item
        packet_files = {(item['hash'], item['byteLength']): item for item in [packet['sourceArchive'], packet['sourceManifest'], *[item[key] for item in packet['compiledClosures'] if item['name'] != 'qualification-evidence' for key in ['archive', 'manifest']]]}
        def retained_json(ref):
            key = (ref['hash'], ref['byteLength'])
            return sealed_json(packet_files[key]) if key in packet_files else archive.decode_json(bytes_at(entries[key]['path']))
        retained_draft = retained_json(receipt['evidence']['draft'])
        verify_linux_build(retained_draft, retained_json, archive.require, rows_identity)
        source_input = retained_json(retained_draft['sourceInput'])
        foreign_key = foreign_source_manifest(source_input, retained_json, archive.require, 18)
        restore_records = receipt['evidence']['restores']
        archive.require([item['role'] for item in restore_records] == ['source', 'application', 'fixture'], 'Required fresh restore evidence is incomplete')
        fixture_restore = retained_json(restore_records[2]['record'])
        seed = retained_draft['seedClosure']; seed_manifest = retained_json(seed['manifest'])
        archive.require(all(seed_manifest['archive'][key] == seed['archive'][key] for key in ['hash', 'byteLength']), 'Seed archive identity differs')
        seed_blob = entries[(seed['archive']['hash'], seed['archive']['byteLength'])]['path']
        with bundle.extractfile(seed_blob) as stream: objects = archive_fixture_objects(seed_manifest, stream)
        before_ref = receipt['evidence']['seedObservation']; after_ref = receipt['evidence']['restoredObservation']
        content_bindings = {(before_ref['hash'], before_ref['byteLength']): seed_manifest['sourceRoot'],
                            (after_ref['hash'], after_ref['byteLength']): fixture_restore['restoredRoot']}
        def verify_nested(value, pointer=(), content_allowed=False):
            if isinstance(value, list):
                for index, item in enumerate(value): verify_nested(item, (*pointer, index), content_allowed)
            elif isinstance(value, dict):
                kind = reference_kind(value, pointer)
                if kind == 'file':
                    archive.require((value['hash'], value['byteLength']) in available | set(entries), 'Required evidence was not retained')
                elif kind == 'object': archive.require(content_allowed, 'Content object has no verified fixture binding')
                else:
                    for key, item in value.items(): verify_nested(item, (*pointer, key), content_allowed)
        for item in entries.values():
            if item['originalPath'].endswith('.json'):
                value = archive.decode_json(bytes_at(item['path'])); key = (item['hash'], item['byteLength']); allowed = key in content_bindings
                if allowed: verify_observation_objects(value, content_bindings[key], objects)
                elif isinstance(value, dict): archive.require(value.get('kind') != 'schema18-executable-observation-1', 'Undeclared executable observation')
                if key != foreign_key: verify_nested(value, content_allowed=allowed)
        for ref in [packet['sourceManifest'], *[item['manifest'] for item in packet['compiledClosures'] if item['name'] != 'qualification-evidence']]:
            verify_nested(sealed_json(ref))
        before = archive.decode_json(bytes_at(entries[(before_ref['hash'], before_ref['byteLength'])]['path']))
        after = archive.decode_json(bytes_at(entries[(after_ref['hash'], after_ref['byteLength'])]['path']))
        archive.require(all(before[key] == after[key] for key in ['retained', 'document', 'events', 'projectionDigest', 'ui', 'draft', 'schema18Receipt', 'capabilityManifest']), 'Retained restored executable observation differs')
        archive.require(after['openExistingSchema18'] is True and after['refuseFutureSchema19'] is True and after['capabilityHash'] == CAPABILITY18 and after['replayByteIdentity'] is True and type(after['networkEffects']) is int and after['networkEffects'] == 0 and all(value == 0 for value in after['effects'].values()) and after['nativeFFIInitialized'] is True and after['nativeTextEngineInitialized'] is True and after['rootLockExclusion'] is True and after['loadedNativeLibraries'], 'Required native/replay/no-effects proof is absent')
        application = next(item for item in packet['compiledClosures'] if item['name'] == 'application-runtime')
        runtime_manifest = retained_json(application['manifest'])
        host_row = runtime_manifest['entries']['.rollback/linux-host.json']
        host_ref = {'hash': 'sha256:' + host_row['sha256'], 'byteLength': str(host_row['bytes'])}
        host = retained_json(host_ref)
        archive.require(host['kind'] == 'linux-native-host-observation-1' and host['platform']['os'] == 'linux' and host['platform']['arch'] == packet['platform']['arch'], 'Proof host platform differs')
        for observation in [before, after]:
            archive.require(observation['linuxHost']['sha256'] == host_ref['hash'] and observation['linuxHost']['selectionHash'] == host['selectionHash'] and observation['linuxHost']['systemLibraryCount'] == len(host['systemLibraries']), 'Proof used a different Linux host closure')
        command_records = receipt['evidence']['commands']
        roles = BUILD_ROLES
        archive.require([item['role'] for item in command_records] == roles, 'Required build/proof command evidence is incomplete')
        for item in command_records:
            ref = item['record']; record = archive.decode_json(bytes_at(entries[(ref['hash'], ref['byteLength'])]['path']))
            archive.require(type(record['exitCode']) is int and record['exitCode'] == 0 and record['processGroupDrained'] is True and record['failure'] is None,
                            'A build/proof command did not complete cleanly: ' + item['role'])
            verify_nested(record)
            archive.require(isinstance(record['argv'], list) and record['argv'] and isinstance(record['environment'], dict), 'Missing actual command invocation/environment')
        from metadata_policy import verify_restore_set
        applications = [item for item in packet['compiledClosures'] if item['name'] == 'application-runtime']
        archive.require(len(applications) == 1, 'Exactly one application runtime closure is required')
        expected_closures = {'source': {'archive': packet['sourceArchive'], 'manifest': packet['sourceManifest']},
                             'application': applications[0], 'fixture': retained_draft['seedClosure']}
        verify_restore_set(restore_records, expected_closures, retained_json)
        verifier = retained_json(receipt['evidence']['verifier'])
        archive.require(verifier['kind'] == 'linux-schema18-packaging-verifier-1' and set(verifier['files']) == set(HELPERS), 'Packaging verifier identity is incomplete')
        verify_nested(verifier)
    verify_ref(evidence[0]['archive']); verify_ref(evidence[0]['manifest'])


def save(path, value):
    archive.save(Path(path), value)


def fresh(path):
    path = archive.canonical(str(path), exists=False)
    archive.require(path.parent.is_dir() and not path.exists(), 'Use a new destination with an existing canonical parent')
    path.mkdir(mode=0o700)
    OWNED_OUTPUTS.add(path)
    return path


def source_paths(repo):
    data = subprocess.run(['git', '-C', str(repo), 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], check=True, capture_output=True).stdout
    names = sorted(set(name.decode('utf8') for name in data.split(b'\0') if name))
    selected = [name for name in names if re.match(r'^(src|server|tests|tooling|vendor|docs|\.github)/', name) or
                re.match(r'^(package(?:-lock)?\.json|tsconfig(?:\.[\w-]+)?\.json|vite(?:\.[\w-]+)?\.config\.ts|index\.html|\.npmrc|\.progress-report/project\.json|AGENTS\.md|README(?:\.md)?|LICENSE(?:\.txt)?)$', name)]
    archive.require(selected and 'server/storage/database.ts' in selected, 'Source selection is incomplete')
    for name in selected:
        archive.relative(name)
    return selected


def restored_source_paths(root, expected):
    """Globs may consume new files: verify membership, not only old hashes."""
    actual = []
    for name in ['src', 'server', 'tests', 'tooling', 'vendor', 'docs', '.github']:
        base = root / name
        if not base.exists(): continue
        for path in base.rglob('*'):
            archive.require(not path.is_symlink(), 'Source tree gained a link')
            if path.is_file(): actual.append(str(path.relative_to(root)))
    actual.extend(path.name for path in root.iterdir() if path.is_file() and re.match(r'^(package(?:-lock)?\.json|tsconfig(?:\.[\w-]+)?\.json|vite(?:\.[\w-]+)?\.config\.ts|index\.html|\.npmrc|AGENTS\.md|README(?:\.md)?|LICENSE(?:\.txt)?)$', path.name))
    if (root / '.progress-report/project.json').exists(): actual.append('.progress-report/project.json')
    archive.require(sorted(set(actual)) == expected, 'Build source membership changed since capture')


def assert_schema18(repo):
    database = (repo / 'server/storage/database.ts').read_text()
    schema = (repo / 'server/storage/schema.ts').read_text()
    archive.require('[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18].includes(version)' in database and
                    CAPABILITY18 in schema and 'COMPOSITION_TEXT_SCHEMA19' not in schema and
                    not (repo / 'server/storage/composition-text-schema.ts').exists(), 'Source is no longer the frozen schema18 executable')


def require_profile_closure(source, policy):
    required = ['src/text/profile.json', *[str(path.relative_to(source)) for path in sorted((source / 'src/text/retained-profiles').glob('*.json'))]]
    selected = [item['path'] for item in policy['runtimeFiles']]; trees = [item['path'] for item in policy['runtimeTrees']]
    archive.require(len(required) > 1 and all(path in selected or any(archive.below(path, tree) for tree in trees) for path in required), 'Runtime policy omits a captured retained text profile')


def rows_identity(rows):
    return content_id({name: {k: row[k] for k in ['type', 'mode', 'bytes', 'sha256'] if k in row} for name, row in rows.items()})


def command(argv, cwd, log, *, timeout=1800, env=None):
    log.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    assert_producer_sources()
    tree = owned_tree(cwd)
    result = tree.run([str(arg) for arg in argv], cwd, log, env or {}, timeout, grants=[other for other in OWNED_TREES if other is not tree])
    assert_producer_sources()
    return result


def safe_environment(node, workspace, npm=None):
    home = workspace / 'home'; cache = workspace / 'npm-cache'; temp = workspace / 'tmp'
    for directory in [home, cache, temp]: directory.mkdir(mode=0o700)
    for parent in [workspace, *workspace.parents]:
        archive.require(not (parent / 'node_modules/.bin').exists(), 'Build could inherit an undeclared ancestor command directory')
    commands = workspace / 'commands'; commands.mkdir(mode=0o700)
    wrappers = {'node': [str(node)], 'python3': [sys.executable]}
    if npm is not None: wrappers.update(npm=[str(node), str(npm)], npx=[str(node), str(npm.with_name('npx-cli.js'))])
    for name, argv in wrappers.items():
        path = commands / name
        path.write_text('#!/bin/sh\nexec ' + ' '.join(shlex.quote(value) for value in argv) + ' "$@"\n'); os.chmod(path, 0o700)
    return {'PATH': str(commands) + ':/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': str(home), 'TMPDIR': str(temp),
            'LANG': 'en_US.UTF-8', 'npm_config_cache': str(cache), 'npm_config_userconfig': str(home / 'absent.npmrc'),
            'npm_config_nodedir': str(node.parent.parent), 'npm_config_audit': 'false', 'npm_config_fund': 'false'}


def collect_evidence(destination, roots, packet_refs, content_bindings=None, substitutions=None, foreign_manifest=None):
    """Retain referenced evidence by hash; old paths remain descriptive only."""
    destination.mkdir(mode=0o700); blobs = destination / 'blobs'; blobs.mkdir(mode=0o700)
    available = {(item['hash'], item['byteLength']) for item in packet_refs}
    pending = list(roots); seen = set(); index = []; content_bindings = content_bindings or {}; substitutions = substitutions or {}
    def references(value, pointer=(), content_allowed=False):
        if isinstance(value, list):
            for index, item in enumerate(value): yield from references(item, (*pointer, index), content_allowed)
        elif isinstance(value, dict):
            kind = reference_kind(value, pointer)
            if kind == 'file': yield value
            elif kind == 'object': archive.require(content_allowed, 'Content object has no verified fixture binding')
            else:
                for key, item in value.items(): yield from references(item, (*pointer, key), content_allowed)
    def json_references(source, key):
        if key == foreign_manifest: return ()  # Exact typed original manifest retained as inert provenance.
        value = sealed_json(file_ref(source)); allowed = key in content_bindings
        if allowed:
            binding = content_bindings[key]; verify_observation_objects(value, binding['declaredRoot'], binding['objects'])
        elif isinstance(value, dict):
            archive.require(value.get('kind') != 'schema18-executable-observation-1', 'Executable observation is not bound to a fixture')
        return references(value, content_allowed=allowed)
    total = 0
    while pending:
        item = pending.pop()
        if not (isinstance(item, dict) and set(item) == {'path', 'hash', 'byteLength'}):
            pending.extend(references(item)); continue
        key = (item['hash'], item['byteLength'])
        if key in seen: continue
        seen.add(key); archive.require(len(seen) <= 2048, 'Evidence reference graph is too large')
        replacement = substitutions.get(key, item)
        archive.require((replacement['hash'], replacement['byteLength']) == key, 'Evidence substitution changes immutable identity')
        source = verify_ref(replacement)
        if key in available:
            if item['path'].endswith('.json'): pending.extend(json_references(source, key))
            continue
        total += int(item['byteLength']); archive.require(total <= 1024 ** 3, 'Evidence graph exceeds its byte bound')
        name = item['hash'].removeprefix('sha256:'); target = blobs / name
        with os.fdopen(os.open(source, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as incoming:
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'wb') as outgoing:
                shutil.copyfileobj(incoming, outgoing, 1048576); outgoing.flush(); os.fsync(outgoing.fileno())
        verify_ref(replacement); copied = file_ref(target)
        archive.require(copied['hash'] == item['hash'] and copied['byteLength'] == item['byteLength'], 'Evidence copy changed')
        index.append({'hash': item['hash'], 'byteLength': item['byteLength'], 'path': 'blobs/' + name, 'originalPath': item['path'],
                      **({'resolvedPath': str(source)} if str(source) != item['path'] else {})})
        if item['path'].endswith('.json'): pending.extend(json_references(source, key))
    record = {'kind': 'schema18-evidence-index-1', 'entries': sorted(index, key=lambda row: row['hash']),
              'packetInputs': [{'hash': value[0], 'byteLength': value[1]} for value in sorted(available)]}
    save(destination / 'index.json', record)
    return file_ref(destination / 'index.json')


def source_input(args):
    return prepare_source(args, globals(), 18)

def build(args):
    return build_linux(args, globals(), 18)


def verify(args):
    draft = trusted(archive.canonical(args.draft), args.draft_sha256); archive.require(draft['kind'] == 'schema18-executable-packet-draft-1' and draft['storageVersion'] == 18, 'Invalid draft')
    output = fresh(Path(args.output))
    try:
        source, source_proof = restore({'archive': draft['sourceArchive'], 'manifest': draft['sourceManifest']}, output / 'source')
        assert_schema18(source)
        archive.require(len(draft['compiledClosures']) == 1 and draft['compiledClosures'][0]['name'] == 'application-runtime', 'Unsupported compiled closure layout')
        product, product_proof = restore(draft['compiledClosures'][0], output / 'application')
        identities = load(product / '.rollback/identities.json')
        archive.require(all(identities['identity'][key] == draft[key] for key in ['compiler', 'toolchain', 'dependencies', 'native', 'platform']), 'Compiled identities differ from descriptor')
        archive.require(draft['platform']['os'] == sys.platform and draft['platform']['arch'] == current_platform()['arch'] and draft['platform']['identity'] == content_id(current_platform()), 'Rollback executable requires its captured native platform')
        # Seed data is a purpose-built public fixture, never the user's root.
        root, fixture_proof = restore(draft['seedClosure'], output / 'fixture')
        node = product / '.rollback/node'; env = safe_environment(node, output)
        observed = output / 'restored-observation.json'
        run = command([node, '--import', product / '.rollback/no-network.mjs', product / '.rollback/proof.mjs', 'check', product, root, observed, product / '.rollback/linux-host.json', file_ref(product / '.rollback/linux-host.json')['hash']], product, output / 'logs/restored.log', timeout=120, env=env)
        before = sealed_json(draft['seedObservation']); after = load(observed)
        for key in ['retained', 'document', 'events', 'projectionDigest', 'ui', 'draft', 'schema18Receipt', 'capabilityManifest']:
            archive.require(before[key] == after[key], 'Fresh executable replay differs: ' + key)
        archive.require(after['openExistingSchema18'] and after['refuseFutureSchema19'] and after['capabilityHash'] == CAPABILITY18 and after['replayByteIdentity'] and after['networkEffects'] == 0, 'Executable restore proof failed')
        source_manifest = sealed_json(draft['sourceManifest']); product_manifest = sealed_json(draft['compiledClosures'][0]['manifest'])
        for directory, manifest, restore_proof in [(source, source_manifest, source_proof), (product, product_manifest, product_proof)]:
            restore_record = sealed_json(restore_proof); restored = sealed_json(restore_record['installedManifest'])
            archive.require(restored['sourceArchiveHash'] == manifest['archive']['hash'] and restored['sourceManifestHash'] == restore_record['manifest']['hash'], 'Installed metadata is bound to different archive/manifest bytes')
            current = inventory(directory, manifest['includes'])
            archive.require({str(path.relative_to(directory)) for path in directory.rglob('*')} == set(restored['entries']), 'Restored source/runtime gained undeclared paths during proof')
            archive.require(set(current) == set(restored['entries']) and all(archive.portable(current[name]) == archive.portable(restored['entries'][name]) for name in current), 'Restored executable/source changed during proof')
        packet_refs = [draft['sourceArchive'], draft['sourceManifest'], *[item[key] for item in draft['compiledClosures'] for key in ['archive', 'manifest']]]
        observed_ref = file_ref(observed); objects = fixture_objects(root); seed_manifest = sealed_json(draft['seedClosure']['manifest'])
        content_bindings = {(draft['seedObservation']['hash'], draft['seedObservation']['byteLength']): {'declaredRoot': seed_manifest['sourceRoot'], 'objects': objects},
                            (observed_ref['hash'], observed_ref['byteLength']): {'declaredRoot': str(root), 'objects': objects}}
        # Original producer bytes remain in the authenticated runtime closure.
        # A repaired packaging verifier never rewrites the compiled draft or
        # resolves its old producer identity to the newer local file by path.
        original_producer = file_ref(product / '.rollback/packet.py')
        substitutions = {(original_producer['hash'], original_producer['byteLength']): original_producer}
        verifier = {'kind': 'linux-schema18-packaging-verifier-1', 'files': {name: file_ref(HERE / name) for name in HELPERS}}
        save(output / 'verifier.json', verifier); verifier_ref = file_ref(output / 'verifier.json')
        evidence_tree = acquire_tree(output / 'evidence-owned', provenance={'draft': file_ref(Path(args.draft))})
        evidence_index = evidence_tree.construct(lambda root: collect_evidence(root / 'inputs', [file_ref(Path(args.draft)), file_ref(product / '.rollback/identities.json'), source_proof, product_proof, fixture_proof, observed_ref, run['receipt'], verifier_ref, *packet_refs], packet_refs, content_bindings, substitutions, foreign_source_manifest(sealed_json(draft['sourceInput']), sealed_json, archive.require, 18)), kind='retained-evidence', inputs={'draft':file_ref(Path(args.draft)), 'source':source_proof, 'application':product_proof, 'fixture':fixture_proof})
        evidence_closure = create(evidence_tree.root / 'inputs', ['blobs', 'index.json'], output / 'evidence', role='retained-executable-qualification-evidence', provenance={'index': {key: evidence_index[key] for key in ['hash', 'byteLength']}})
        compiled_closures = [*draft['compiledClosures'], {'name': 'qualification-evidence', **evidence_closure}]
        closure_hash = closure_identity(compiled_closures)
        receipt = {'kind': 'schema18-fresh-restore-1', 'storageVersion': 18, 'result': 'verified', 'sourceArchiveHash': draft['sourceArchive']['hash'], 'compiledClosureHash': closure_hash, 'capabilityHash': CAPABILITY18,
                   'toolchainIdentity': draft['toolchain']['identity'], 'dependencyIdentity': draft['dependencies']['identity'], 'nativeProfileHash': draft['native']['profileHash'], 'platformIdentity': draft['platform']['identity'],
                   'checks': {'freshRestore': True, 'openExistingSchema18': True, 'refuseFutureSchema19': True, 'replayByteIdentity': True, 'networkEffects': 0},
                   'evidence': {'closure': 'qualification-evidence', 'index': {key: evidence_index[key] for key in ['hash', 'byteLength']},
                                'draft': {key: file_ref(Path(args.draft))[key] for key in ['hash', 'byteLength']},
                                'verifier': {key: verifier_ref[key] for key in ['hash', 'byteLength']},
                                'restores': [{'role': role, 'record': {key: ref[key] for key in ['hash', 'byteLength']}} for role, ref in [('source', source_proof), ('application', product_proof), ('fixture', fixture_proof)]],
                                'commands': [{'role': Path(item['log']['path']).stem, 'record': {key: item['receipt'][key] for key in ['hash', 'byteLength']}} for item in [*draft['commands'], run]],
                                'seedObservation': {key: draft['seedObservation'][key] for key in ['hash', 'byteLength']}, 'restoredObservation': {key: file_ref(observed)[key] for key in ['hash', 'byteLength']}}}
        save(output / 'fresh-restore.json', receipt)
        archive.require((output / 'fresh-restore.json').stat().st_size <= 65536, 'Migration receipt exceeds its metadata bound')
        packet = {key: draft[key] for key in ['storageVersion', 'packetId', 'sourceArchive', 'sourceManifest', 'compiler', 'toolchain', 'dependencies', 'native', 'platform', 'compiledClosures']}
        packet['compiledClosures'] = compiled_closures
        packet.update(kind='schema18-executable-packet-1', capabilityHash=CAPABILITY18, verifiedFreshRestore={'receipt': file_ref(output / 'fresh-restore.json'), 'sourceArchiveHash': draft['sourceArchive']['hash'], 'compiledClosureHash': closure_hash, 'capabilityHash': CAPABILITY18, 'result': 'verified'})
        # Dirty source identity is content-addressed. HEAD is retained only as
        # ancestry in capture/draft; the migration descriptor has no fake Git SHA.
        assert_producer_sources()
        validate_packet(packet); save(output / 'packet.json', packet)
        print(json.dumps({'packet': str(output / 'packet.json'), 'identity': file_ref(output / 'packet.json'), 'pin': packet_pin(packet)}))
    except BaseException as error:
        archive.failure(output, error); raise


def install(args):
    packet = trusted(archive.canonical(args.packet), args.packet_sha256)
    validate_packet(packet)
    output_path = Path(args.output)
    archive.require(output_path.name == packet['packetId'] and output_path.parent.name == 'rollback-executables', 'Install under the selected root/rollback-executables/<packetId>')
    for parent in [output_path.parent, output_path.parent.parent]:
        parent = archive.canonical(str(parent)); info = parent.stat()
        archive.require(parent.is_dir() and info.st_uid == os.getuid() and info.st_mode & 0o077 == 0, 'Installed packet ancestors must be private and owned')
    output = fresh(output_path)
    try:
        index = 0
        def relocate(value, pointer=()):
            nonlocal index
            if isinstance(value, list): return [relocate(item, (*pointer, position)) for position, item in enumerate(value)]
            if isinstance(value, dict):
                if reference_kind(value, pointer) == 'file':
                    source = verify_ref(value); target = output / (str(index).zfill(3) + '.sealed'); index += 1
                    # Private fixed-name copies; no source link following, merge,
                    # archive execution, chmod of originals or cleanup.
                    with os.fdopen(os.open(source, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as stream:
                        before = archive.identity(os.fstat(stream.fileno()))
                        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                        with os.fdopen(fd, 'wb') as destination:
                            shutil.copyfileobj(stream, destination, 1048576); destination.flush(); os.fsync(destination.fileno())
                        archive.require(before == archive.identity(os.fstat(stream.fileno())) == archive.identity(source.lstat()), 'Packet input changed during relocation')
                    verify_ref(value); result = file_ref(target)
                    archive.require(result['hash'] == value['hash'] and result['byteLength'] == value['byteLength'], 'Installed packet bytes differ')
                    return result
                return {key: relocate(item, (*pointer, key)) for key, item in value.items()}
            return value
        installed = relocate(packet)
        archive.require(packet_identity(installed) == packet_identity(packet), 'Relocation changed executable pin identity')
        save(output / 'packet.json', installed)
        fd = os.open(output, os.O_RDONLY); os.fsync(fd); os.close(fd)
        fd = os.open(output.parent, os.O_RDONLY); os.fsync(fd); os.close(fd)
        print(json.dumps({'installed': str(output / 'packet.json'), 'identity': file_ref(output / 'packet.json'), 'pin': packet_pin(installed)}))
    except BaseException as error:
        archive.failure(output, error); raise


def main():
    def interrupted(number, frame):
        signal.signal(signal.SIGTERM, signal.SIG_IGN); signal.signal(signal.SIGINT, signal.SIG_IGN)
        raise InterruptedError('Producer interrupted by signal ' + str(number))
    signal.signal(signal.SIGTERM, interrupted); signal.signal(signal.SIGINT, interrupted)
    parser = argparse.ArgumentParser(description=__doc__); sub = parser.add_subparsers(dest='mode', required=True)
    child = sub.add_parser('source-input')
    for name in ['origin-packet','origin-packet-sha256','origin-pin','origin-pin-sha256','output']: child.add_argument('--' + name, required=True)
    child = sub.add_parser('build')
    for name in ['source-input', 'source-input-sha256', 'host-selection', 'host-selection-sha256', 'toolchain-repo', 'workspace', 'output']:
        child.add_argument('--' + name, required=True)
    child = sub.add_parser('verify')
    for name in ['draft', 'draft-sha256', 'output']: child.add_argument('--' + name, required=True)
    child = sub.add_parser('install')
    for name in ['packet', 'packet-sha256', 'output']: child.add_argument('--' + name, required=True)
    args = parser.parse_args()
    try: globals()[args.mode.replace('-', '_')](args)
    except BaseException as error:
        output = Path(args.output)
        if output in OWNED_OUTPUTS: archive.failure(output, error)
        raise

if __name__ == '__main__':
    raise SystemExit('Use python3 -I run.py --seal-sha256 <reviewed-seal-hash> ...')
