#!/usr/bin/env python3
"""Fixed native producer child operations; no operation occurs on import.

Controller/config/helper closure must be root-owned and immutable. Payload work
runs only as the exact nonroot selected identity. The outer controller owns its
bounded process group; existing producer owned_process remains authoritative for
all build/restore command construction and drainage.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import types

MAX_JSON = 4 * 1024 * 1024
REMOTE = 'https://github.com/Westbrook/ideogram-editor.git'

def require(value, message):
    if not value: raise ValueError(message)

def pairs(rows):
    result = {}
    for key, value in rows:
        require(key not in result, 'Duplicate JSON key'); result[key] = value
    return result

def decode(raw):
    require(len(raw) <= MAX_JSON, 'JSON bound')
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _: require(False, 'Nonfinite JSON'))

def absolute(value):
    require(isinstance(value, str) and value.startswith('/') and str(Path(value)) == value and not any(ord(c) < 32 or ord(c) == 127 for c in value), 'Canonical absolute path required')
    require('..' not in Path(value).parts, 'Parent traversal refused')
    return Path(value)

def stamp(s):
    return (s.st_dev, s.st_ino, s.st_mode, s.st_nlink, s.st_uid, s.st_gid, s.st_size, s.st_mtime_ns, s.st_ctime_ns)

def read(path, maximum=MAX_JSON, immutable=False):
    path = absolute(str(path)); require(path.resolve(strict=True) == path, 'Linked input refused')
    if immutable:
        for ancestor in [path, *path.parents]:
            s = ancestor.lstat(); require(s.st_uid == 0 and not stat.S_IMODE(s.st_mode) & 0o022, 'Controller source/config is not root-owned immutable')
    before = path.lstat(); require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= maximum, 'Regular single-link bounded file required')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        require(stamp(before) == stamp(os.fstat(fd)), 'Input changed before read'); result = bytearray()
        while block := os.read(fd, min(1048576, maximum + 1 - len(result))):
            result.extend(block); require(len(result) <= maximum, 'Input grew beyond bound')
        require(len(result) == before.st_size and stamp(before) == stamp(os.fstat(fd)) == stamp(path.lstat()), 'Input changed while read')
        return bytes(result)
    finally: os.close(fd)

def reference(path, maximum=MAX_JSON):
    raw = read(path, maximum)
    return {'path': str(path), 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}

def verify_ref(ref, immutable=False):
    require(set(ref) == {'path', 'bytes', 'sha256'} and type(ref['bytes']) is int and 0 <= ref['bytes'] <= 256 * 1024**2 and re.fullmatch('[0-9a-f]{64}', ref['sha256']), 'Invalid exact reference')
    raw = read(ref['path'], ref['bytes'], immutable)
    require(len(raw) == ref['bytes'] and hashlib.sha256(raw).hexdigest() == ref['sha256'], 'Exact reference differs')
    return raw

def save(path, value):
    raw = (json.dumps(value, sort_keys=True, indent=2, allow_nan=False) + '\n').encode()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb') as stream: stream.write(raw); stream.flush(); os.fsync(stream.fileno())
    except BaseException: raise
    return reference(path)

def load_module(path, expected):
    raw = read(path, 2 * 1024**2, True)
    require(hashlib.sha256(raw).hexdigest() == expected, 'Sealed helper differs')
    module = types.ModuleType('hosted_sealed_' + Path(path).stem); module.__file__ = str(path)
    exec(compile(raw, str(path), 'exec', dont_inherit=True), module.__dict__)
    return module

def config_at(path, digest, action):
    raw = read(path, immutable=True); require(hashlib.sha256(raw).hexdigest() == digest, 'Controller configuration grant differs')
    config = decode(raw); require(config['kind'] == 'hosted-native-controller-config-1', 'Configuration kind differs')
    require(config['input']['remote'] == REMOTE and re.fullmatch('[0-9a-f]{40}', config['input']['commit'] or '') and re.fullmatch('[0-9a-f]{40}', config['input']['tree'] or ''), 'Input commit/tree not issued')
    # Parent authenticates the complete immutable source/binary closure at both
    # phase boundaries. A periodic observer reauthenticates only its exact
    # executed Python adapter/scanner closure, avoiding unrelated binary hashing
    # outside the scanner's one-second observation window.
    sources = config['sources'] if action != 'observe' else [row for row in config['sources'] if row['path'].endswith(('/hosted-worker.py', '/volume_observer.py'))]
    require(action != 'observe' or len(sources) == 2, 'Exact observer source closure missing')
    for row in sources: verify_ref(row, True)
    if action != 'observe':
        for row in config['tools'].values(): verify_ref(row, True)
    return config

def admit_descriptor_targets(rows):
    # The only caller is the fixed root controller's boundedChild invocation:
    # fd0 is DEVNULL and fd1/2 are controller-owned logging pipes. libuv may
    # implement those pipes as anonymous AF_UNIX stream socketpairs. They are
    # permitted logging endpoints, never caller-provided network authority.
    # Every additional inherited socket is refused. The offline filter also
    # prevents connect/readdressing and creation of new external endpoints.
    seen = set()
    for fd, target in rows:
        require(type(fd) is int and fd >= 0 and fd not in seen and isinstance(target, str), 'Invalid descriptor observation')
        seen.add(fd)
        require(fd <= 2 or not target.startswith('socket:'), 'Unapproved inherited socket descriptor refused')

def selected_identity(config):
    owner = config['owner']; require(type(owner['uid']) is int and owner['uid'] > 0 and type(owner['gid']) is int and owner['gid'] > 0 and owner['groups'] == [], 'Nonroot owner required')
    require(os.getuid() == os.geteuid() == owner['uid'] and os.getgid() == os.getegid() == owner['gid'] and sorted(os.getgroups()) == owner['groups'], 'Producer ownership/groups differ')
    status = Path('/proc/self/status').read_text()
    for key in ('CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'):
        values = re.findall(r'^' + key + r':\s*([0-9a-fA-F]+)$', status, re.M)
        require(len(values) == 1 and int(values[0], 16) == 0, 'Producer capabilities are not zero')
    require(re.search(r'^NoNewPrivs:\s*1$', status, re.M), 'No-new-privileges required')
    require(not any(k.startswith(('LD_', 'DYLD_')) or k in ('NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'PYTHONHOME', 'BASH_ENV', 'ENV') for k in os.environ), 'Injected runtime environment refused')
    descriptors = []
    for item in Path('/proc/self/fd').iterdir():
        try: target = os.readlink(item)
        except FileNotFoundError: continue  # the already-closed directory iterator descriptor
        descriptors.append((int(item.name), target))
    admit_descriptor_targets(descriptors)
    return owner

def data_root(config):
    allocation = decode(verify_ref(config['dataAllocation'], True)); root = absolute(allocation['root'])
    require(allocation['kind'] == 'evidence-volume-allocation-1' and allocation['capacityBytes'] == 32 * 1024**3 and root.resolve(strict=True) == root, 'Data allocation differs')
    for parent in root.parents:
        info = parent.lstat(); require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not stat.S_IMODE(info.st_mode) & 0o022, 'Producer data parent must be root-owned immutable')
    s = root.lstat(); require(stat.S_ISDIR(s.st_mode) and (s.st_uid, s.st_gid, stat.S_IMODE(s.st_mode)) == (config['owner']['uid'], config['owner']['gid'], 0o700), 'Private producer data root required')
    require({'dev': s.st_dev, 'ino': s.st_ino} == config['dataRootIdentity'], 'Producer data root replaced')
    return root

def observer(config):
    owner = selected_identity(config); root = data_root(config)
    helper = next(row for row in config['sources'] if row['path'].endswith('/tooling/rollback-producer/volume_observer.py'))
    worker = load_module(helper['path'], helper['sha256'])
    class BoundRoot(worker.Filesystem):
        def root_stat(self): return os.stat(root, follow_symlinks=False)
        def open_root(self): return os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    request = {'kind': 'capsule-volume-request-1', 'mode': 'sample', 'ownerUid': owner['uid'], 'ownerGid': owner['gid'], 'rootIdentity': config['dataRootIdentity'], 'policyId': worker.POLICY_ID}
    result = worker.observe(request, filesystem=BoundRoot()); raw = worker.canonical(result) + b'\n'
    require(len(raw) <= worker.MAX_OUTPUT_BYTES, 'Observer output cap exceeded')
    sys.stdout.buffer.write(raw); sys.stdout.buffer.flush()
    return 0 if result['status'] == 'complete' and result['drained'] else 1

def command(argv, *, env=None, maximum=1024**2):
    # Parent controller supplies the enclosing command deadline/process-group
    # cancellation. No new session/daemon is created by these fixed helpers.
    child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=None, env=env, close_fds=True)
    try:
        raw = child.stdout.read(maximum + 1); require(len(raw) <= maximum, 'Child output bound')
        require(child.wait() == 0, 'Fixed child failed'); return raw
    finally:
        if child.poll() is None: child.kill(); child.wait()
        child.stdout.close()

def git_environment(root):
    return {'PATH': '/usr/bin:/bin', 'HOME': str(root / 'home'), 'TMPDIR': str(root / 'tmp'), 'LANG': 'C', 'LC_ALL': 'C', 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_SYSTEM': '/dev/null', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_ATTR_NOSYSTEM': '1', 'GIT_TERMINAL_PROMPT': '0', 'GIT_OPTIONAL_LOCKS': '0', 'GIT_NO_REPLACE_OBJECTS': '1', 'GIT_ASKPASS': '/bin/false', 'SSH_ASKPASS': '/bin/false'}

def initialize(config):
    selected_identity(config); root = data_root(config)
    require(not list(root.iterdir()), 'Initial producer layout must be empty')
    for name in ('home', 'tmp', 'incoming', 'inputs', 'workspaces', 'outputs', 'toolchain'):
        (root / name).mkdir(mode=0o700)
    return {'initialized':True,'qualification':False}

def transfer(config):
    selected_identity(config); root = data_root(config)
    for name in ('home', 'tmp', 'incoming', 'inputs', 'workspaces', 'outputs', 'toolchain'):
        path=root/name; s=path.lstat();require(path.resolve(strict=True)==path and stat.S_ISDIR(s.st_mode) and (s.st_uid,s.st_gid,stat.S_IMODE(s.st_mode))==(config['owner']['uid'],config['owner']['gid'],0o700),'Exact initialized private data layout required')
    bare = root / 'incoming/objects.git'; env = git_environment(root); git = config['tools']['git']['path']
    base = [git, '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.attributesFile=/dev/null', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always']
    command([*base, 'init', '--bare', '--template=', str(bare)], env=env)
    base += ['--git-dir=' + str(bare)]
    command([*base, 'fetch', '--no-auto-maintenance', '--no-tags', '--no-recurse-submodules', '--depth=1', '--no-write-fetch-head', REMOTE, config['input']['commit']], env=env)
    commit = command([*base, 'cat-file', 'commit', config['input']['commit']], env=env).decode('utf8')
    headers = commit.split('\n\n', 1)[0].splitlines()
    require(headers[0] == 'tree ' + config['input']['tree'] and not any(x.startswith('parent ') for x in headers), 'Expected exact parentless input commit/tree')
    tree = command([*base, 'ls-tree', '-rz', '--full-tree', config['input']['tree']], env=env)
    members = {}
    for item in tree.split(b'\0'):
        if not item: continue
        metadata, raw_name = item.split(b'\t', 1); name = raw_name.decode('utf8'); fields = metadata.decode('ascii').split(' ')
        require(fields[0:2] == ['100644', 'blob'] and re.fullmatch('[0-9a-f]{40}', fields[2]), 'Unsupported Git member')
        require(name not in members and str(PurePosixPath(name)) == name and not name.startswith('/') and all(x not in ('.', '..', '.git') for x in name.split('/')) and not any(ord(c) < 32 or ord(c) == 127 for c in name) and '\\' not in name, 'Unsafe/duplicate Git member')
        members[name] = fields[2]
    require('INPUTS.json' in members, 'Missing fixed input manifest')
    manifest_bytes = command([*base, 'cat-file', 'blob', members['INPUTS.json']], env=env)
    expected = config['input']['manifest']; require(len(manifest_bytes) == expected['bytes'] and hashlib.sha256(manifest_bytes).hexdigest() == expected['sha256'], 'Input manifest differs from independent pin')
    manifest = decode(manifest_bytes); rows = manifest['files']
    require(len(rows) == 72 and len({r['path'] for r in rows}) == 72 and set(members) == {'INPUTS.json', *[r['path'] for r in rows]} and sum(r['bytes'] for r in rows) == 219487623, 'Input membership/aggregate differs')
    observed = []
    for row in [{'path': 'INPUTS.json', **expected}, *rows]:
        name = row['path']; destination = root / 'inputs' / name
        destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        require(destination.parent.resolve(strict=True) == destination.parent, 'Input parent alias')
        child = subprocess.Popen([*base, 'cat-file', 'blob', members[name]], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, env=env, close_fds=True)
        total = 0; digest = hashlib.sha256()
        try:
            fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'wb') as output:
                while block := child.stdout.read(1048576):
                    total += len(block); require(total <= row['bytes'], 'Raw Git blob exceeds pin'); digest.update(block); output.write(block)
                output.flush(); os.fsync(output.fileno())
            require(child.wait() == 0 and total == row['bytes'] and digest.hexdigest() == row['sha256'], 'Raw Git blob differs')
        finally:
            if child.poll() is None: child.kill(); child.wait()
            child.stdout.close()
        ref = reference(destination, row['bytes']); require(ref['bytes'] == row['bytes'] and ref['sha256'] == row['sha256'], 'Materialized readback differs'); observed.append(ref)
    return {'commit': config['input']['commit'], 'tree': config['input']['tree'], 'files': observed, 'qualification': False}

def bootstrap(config):
    selected_identity(config); root = data_root(config); target = root / 'toolchain/tooling'; target.mkdir(mode=0o700)
    for name in ('bootstrap-toolchain.py', 'toolchain.json'):
        source = next(row for row in config['sources'] if row['path'].endswith('/tooling/' + name)); raw = verify_ref(source, True)
        fd = os.open(target / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'wb') as stream: stream.write(raw); stream.flush(); os.fsync(stream.fileno())
    os.execve(config['tools']['python']['path'], [config['tools']['python']['path'], '-I', '-S', '-B', str(target / 'bootstrap-toolchain.py')], dict(os.environ))

def offline_admission(config):
    selected_identity(config); actual = os.readlink('/proc/self/ns/net')
    require(re.fullmatch(r'net:\[[0-9]+\]', actual) and actual != config['onlineNetns'], 'Independent network namespace required')
    require(sorted(os.listdir('/sys/class/net')) == ['lo'], 'External network interface present')
    require(not Path('/proc/net/route').read_text().splitlines()[1:], 'IPv4 route present')
    for row in Path('/proc/net/ipv6_route').read_text().splitlines():
        require(row.split()[-1] == 'lo', 'External IPv6 route present')
    return {'networkNamespace': actual, 'parentNetworkNamespace': config['onlineNetns'], 'interfaces': ['lo'], 'externalRoutes': 0, 'uid': os.getuid(), 'gid': os.getgid(), 'groups': sorted(os.getgroups()), 'zeroCapabilities': True}

def producer(config, version, mode, expected_draft=None):
    selected_identity(config); root = data_root(config)
    require(version in (16, 17, 18) and mode in ('build', 'verify'), 'Fixed producer family/mode only')
    prepared = decode(read(root / 'prepared/prepared.json')); selected = next(x for x in prepared['sources'] if x['storageVersion'] == version)
    launcher = Path(config['controlRoot']) / f'tooling/rollback-producer/schema{version}/run.py'
    seal = config['producers'][str(version)]['seal']
    require(verify_ref(seal, True) and str(launcher) == selected['producer']['launcher']['path'] and selected['producer']['seal']['hash'] == 'sha256:' + seal['sha256'], 'Prepared producer differs from active source authority')
    argv = [config['tools']['python']['path'], '-I', '-S', '-B', str(launcher), '--seal-sha256', 'sha256:' + seal['sha256'], mode]
    if mode == 'build':
        source = selected['sourceInput']; raw = read(source['path']); require(hashlib.sha256(raw).hexdigest() == source['hash'][7:] and str(len(raw)) == source['byteLength'], 'Prepared source wrapper changed')
        argv += ['--source-input', source['path'], '--source-input-sha256', source['hash'], '--host-selection', config['hostSelection']['path'], '--host-selection-sha256', 'sha256:' + config['hostSelection']['sha256'], '--toolchain-repo', str(root / 'toolchain'), '--workspace', str(root / f'workspaces/build{version}'), '--output', str(root / f'outputs/build{version}')]
    else:
        observed = offline_admission(config)
        policy_ref = next(row for row in config['sources'] if row['path'].endswith('/tooling/rollback-producer/hosted-offline.py'))
        policy = load_module(policy_ref['path'], policy_ref['sha256']); observed['socketPolicy'] = policy.install()
        save(root / f'offline-{version}.json', observed)
        draft = root / f'outputs/build{version}/draft.json'; ref = reference(draft)
        # Root controller supplies only the exact predecessor's draft pin.
        require(ref['sha256'] == expected_draft, 'Build-to-verify draft identity differs')
        argv += ['--draft', str(draft), '--draft-sha256', 'sha256:' + ref['sha256'], '--output', str(root / f'outputs/verified{version}')]
    os.execve(argv[0], argv, dict(os.environ))

def prepare(config, recheck=False):
    selected_identity(config); root = data_root(config)
    node = config['tools']['node']['path']; helper = str(Path(config['controlRoot']) / 'tooling/rollback-producer/hosted-inputs.mjs')
    argv = [node, '--import', str(Path(config['controlRoot']) / 'tests/store/no-network.mjs'), helper]
    if recheck:
        receipt = root / 'prepared/prepared.json'; ref = reference(receipt)
        argv += ['recheck', '--receipt', str(receipt), '--receipt-sha256', ref['sha256']]
    else: argv += ['prepare', '--input-root', str(root / 'inputs'), '--manifest', str(root / 'inputs/INPUTS.json'), '--output', str(root / 'prepared')]
    os.execve(node, argv, dict(os.environ))


def collect(config, phase):
    selected_identity(config); root = data_root(config)
    require(re.fullmatch(r'(build|verify)(16|17|18)', phase), 'Fixed collection phase required')
    mode, version = ('build' if phase.startswith('build') else 'verified'), phase[-2:]
    base = root / ('outputs/' + mode + version); require(base.resolve(strict=True) == base, 'Output root alias')
    rows = []; total = 0
    def visit(directory, prefix='', depth=0):
        nonlocal total
        require(depth <= 128, 'Output depth bound')
        before = directory.lstat()
        for member in sorted(directory.iterdir()):
            require(len(rows) < 100000, 'Output entry bound'); s = member.lstat(); name = prefix + member.name
            if stat.S_ISDIR(s.st_mode): rows.append({'path': name, 'type': 'directory', 'mode': stat.S_IMODE(s.st_mode)}); visit(member, name + '/', depth + 1)
            elif stat.S_ISLNK(s.st_mode):
                target = os.readlink(member); require(stamp(s) == stamp(member.lstat()), 'Output link changed'); rows.append({'path': name, 'type': 'symlink', 'target': target, 'mode': stat.S_IMODE(s.st_mode)})
            else:
                require(stat.S_ISREG(s.st_mode) and s.st_nlink == 1, 'Output special/hardlink refused')
                digest = hashlib.sha256(); count = 0
                fd = os.open(member, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                try:
                    require(stamp(s) == stamp(os.fstat(fd)), 'Output changed before read')
                    while block := os.read(fd, 1048576): count += len(block); digest.update(block); require(count <= s.st_size, 'Output grew')
                    require(count == s.st_size and stamp(s) == stamp(os.fstat(fd)) == stamp(member.lstat()), 'Output changed')
                finally: os.close(fd)
                total += count; require(total <= 32 * 1024**3, 'Output logical bound')
                rows.append({'path': name, 'type': 'file', 'bytes': count, 'sha256': digest.hexdigest(), 'mode': stat.S_IMODE(s.st_mode)})
        require(stamp(before) == stamp(directory.lstat()), 'Output membership changed')
    visit(base)
    required = ['draft.json', 'linux-build.json'] if mode == 'build' else ['packet.json', 'fresh-restore.json', 'verifier.json']
    require(all(any(r['path'] == name and r['type'] == 'file' for r in rows) for name in required), 'Required output closure absent')
    result = {'kind': 'hosted-native-output-inventory-1', 'root': str(base), 'phase': phase, 'entries': rows, 'regularBytes': total, 'qualification': False}
    index = save(root / ('output-index-' + phase + '.json'), result)
    return {'inventory': index, 'required': [reference(base / name, 64 * 1024**2) for name in required], 'qualification': False}


def host_check(config):
    selected_identity(config)
    helper = next(row for row in config['sources'] if row['path'].endswith('/schema18/linux_host.py'))
    host = load_module(helper['path'], helper['sha256'])
    selection = decode(verify_ref(config['hostSelection'], True)); expected = decode(verify_ref(config['hostObservation'], True))
    actual = host.native_host(config['hostEnvironment'], selection)
    require(actual == expected, 'Frozen native host closure changed')
    return {'frozenHostMatches': True, 'physicalQualification': False}


def main():
    require(sys.flags.isolated and sys.flags.no_site and sys.dont_write_bytecode and not sys.flags.optimize, 'Use python -I -S -B without optimization')
    parser = argparse.ArgumentParser(); parser.add_argument('--config', required=True); parser.add_argument('--grant', required=True); parser.add_argument('--action', choices=['initialize', 'observe', 'inputs', 'toolchain', 'build16', 'build17', 'build18', 'verify16', 'verify17', 'verify18', 'prepare', 'recheck', 'collect', 'host-check'], required=True); parser.add_argument('--draft-sha256'); parser.add_argument('--phase')
    args = parser.parse_args(); config = config_at(args.config, args.grant, args.action)
    require((args.draft_sha256 is not None) == args.action.startswith('verify'), 'Unexpected/missing draft argument')
    require((args.phase is not None) == (args.action == 'collect'), 'Unexpected/missing collection phase')
    if args.action == 'initialize': print(json.dumps(initialize(config))); return 0
    if args.action == 'observe': return observer(config)
    if args.action == 'host-check': print(json.dumps(host_check(config))); return 0
    if args.action == 'inputs': print(json.dumps(transfer(config), separators=(',', ':'))); return 0
    if args.action == 'toolchain': bootstrap(config)
    if args.action in ('prepare', 'recheck'): prepare(config, args.action == 'recheck')
    if args.action == 'collect': print(json.dumps(collect(config, args.phase), separators=(',', ':'))); return 0
    producer(config, int(args.action[-2:]), 'verify' if args.action.startswith('verify') else 'build', args.draft_sha256)

if __name__ == '__main__':
    try: sys.exit(main())
    except Exception as error: sys.stderr.write(type(error).__name__ + ': ' + str(error)[:2048] + '\n'); sys.exit(1)
