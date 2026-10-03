"""Scoped Linux transport for newly constructed, producer-owned trees only.

This does not observe all privileged metadata, adopt existing roots, or prove
global inactivity. The frozen arbitrary-tree exact transport remains separate.
"""
import hashlib
import functools
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import threading
import time
import types
import uuid


BASE_SHA256 = '29e8dbebe70c0ee1bde8ff058f266eb3f43f68a09d91ca1bedcd41f430b70089'
POLICY = 'linux-owned-construction-metadata-1'
KIND = 'linux-owned-closure-transport-1'
SCOPE = {
    'kind': 'linux-owned-visible-metadata-1',
    'bytes': 'exact', 'mode': 'exact', 'mtimeNs': 'exact', 'uidGid': 'exact-current-owner-authority',
    'xattrs': 'exact-accessible-name-value-set', 'posixAcl': 'exact-accessible-raw-xattrs',
    'inodeFlags': 'full-equality-within-supported-readable-flags',
    'hiddenMetadataObserved': False, 'hiddenMetadataEquivalent': False,
    'globalInactivityVerified': False,
}
_ISSUER = object()
_TREES = {}
_OPERATIONS_LOCK = threading.RLock()


def _serial(function):
    @functools.wraps(function)
    def owned_operation(*args, **kwargs):
        with _OPERATIONS_LOCK:
            return function(*args, **kwargs)
    return owned_operation


def _base_module():
    local = Path(__file__).absolute().with_name('linux_transport_exact.py')
    source = local if local.exists() else Path(__file__).absolute().parent.parent / 'transport' / 'linux_transport.py'
    descriptor = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > 65536:
            raise RuntimeError('Invalid pinned archive helper')
        data = bytearray()
        while len(data) <= 65536:
            block = os.read(descriptor, 65536 - len(data) + 1)
            if not block:
                break
            data.extend(block)
        after = os.fstat(descriptor)
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
                after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise RuntimeError('Pinned helper changed while reading')
    finally:
        os.close(descriptor)
    if hashlib.sha256(data).hexdigest() != BASE_SHA256:
        raise RuntimeError('Frozen archive helper identity differs')
    name = __name__ + '_pinned_byte_primitives'
    if name in sys.modules:
        raise RuntimeError('Unexpected preloaded archive helper')
    module = types.ModuleType(name)
    module.__file__ = str(source)
    sys.modules[name] = module
    exec(compile(bytes(data), str(source), 'exec'), module.__dict__)
    return module


_base = _base_module()
for _name in ('ArchiveError', 'require', 'keys', 'now', 'digest', 'canonical_json', 'content_id', 'decode_json',
              'below', 'relative', 'canonical', 'identity', 'portable', 'validate_archive', 'file_ref', 'verify_ref',
              'sealed_json', 'read_bytes', 'save', 'new_destination', 'space', 'failure', 'command'):
    globals()[_name] = getattr(_base, _name)
archive = sys.modules[__name__]


def _host():
    _base._linux()
    require(sys.byteorder == 'little', 'Owned supervisor supports little-endian Linux only')
    status = read_bytes(Path('/proc') / str(os.getpid()) / 'status', 65536).decode('ascii')
    def fields(name):
        rows = re.findall(r'^' + name + r':\s*([^\n]+)$', status, re.MULTILINE)
        require(len(rows) == 1, 'Cannot determine owned-process identity: ' + name)
        return rows[0].split()
    uid, gid = os.geteuid(), os.getegid()
    require(uid != 0 and fields('Uid') == [str(uid)] * 4 and fields('Gid') == [str(gid)] * 4,
            'Owned construction requires an ordinary nonroot identity without saved privileged IDs')
    caps = {}
    for name in ('CapInh', 'CapPrm', 'CapEff', 'CapAmb'):
        values = fields(name)
        require(len(values) == 1 and re.fullmatch('[0-9a-fA-F]+', values[0]) and int(values[0], 16) == 0,
                'Owned construction does not admit privileged capability authority')
        caps[name] = values[0].lower()
    return {'uid': uid, 'gid': gid, 'groups': sorted(set([gid, *os.getgroups()])), 'capabilities': caps}


def capabilities():
    return {'backend': 'linux-owned-manual-ustar-gzip-1', 'metadataPolicy': POLICY, 'metadataScope': SCOPE,
            'identity': _host(), 'python': sys.version.split()[0], 'baseHash': 'sha256:' + BASE_SHA256,
            'activity': 'owned-construction-and-supervised-descendant-drain; no global lsof claim'}


def _uuid(value):
    require(isinstance(value, str), 'Invalid ownership ID')
    try:
        require(str(uuid.UUID(value)) == value, 'Noncanonical ownership ID')
    except ValueError as error:
        raise ArchiveError('Invalid ownership ID') from error


def _storage(value):
    require(type(value) is int and value in (16, 17, 18), 'Explicit owned storageVersion 16, 17, or 18 is required')


def entry(path, *, _checked_host=None):
    host = _host() if _checked_host is None else _checked_host
    path = canonical(str(path))
    descriptor = _base._open(path)
    try:
        before = os.fstat(descriptor)
        directory = stat.S_ISDIR(before.st_mode)
        require(directory or stat.S_ISREG(before.st_mode) and before.st_nlink == 1, 'Unsupported link/special file')
        require(before.st_uid == host['uid'] and before.st_gid in host['groups'], 'Tree exceeds current owner authority')
        values = _base._xattrs(descriptor)
        # Names invisible to this unprivileged process are unknown, never absent.
        require(not any(name.startswith('trusted.') for name in values), 'Unexpected privileged xattr visibility')
        flags = _base._flags(descriptor, directory)
        row = {'type': 'directory' if directory else 'file', 'mode': stat.S_IMODE(before.st_mode),
               'mtimeNs': before.st_mtime_ns, 'uid': before.st_uid, 'gid': before.st_gid,
               'flags': flags, 'xattrs': values, 'acl': _base._acl(values), 'originalIdentity': identity(before)}
        if not directory:
            count, hashed = _base._read_fd(descriptor, _base.MAX_BYTES)
            require(count == before.st_size, 'Constructed file size changed')
            row.update(bytes=count, sha256=hashed, nlink=1)
        require(identity(before) == identity(os.fstat(descriptor)) == identity(_base._stat(path)) and
                values == _base._xattrs(descriptor) and flags == _base._flags(descriptor, directory),
                'Constructed bytes or accessible metadata changed while reading')
        _base._validate_row(row)
        if _checked_host is None:
            require(_host() == host, 'Owner authority changed')
        return row
    finally:
        os.close(descriptor)


def snapshot(description, root):
    """Read-only scoped observation; it grants no construction/capture authority."""
    host = _host()
    root = canonical(str(root))
    _base._includes(description['include'])
    root_identity = identity(_base._stat(root))
    require(stat.S_ISDIR(root_identity[2]) and root_identity[7] == host['uid'], 'Unowned observation root')
    rows = {}
    total = attributes = metadata_bytes = 0
    def visit(name, recurse):
        nonlocal total, attributes, metadata_bytes
        relative(name)
        row = entry(root / name, _checked_host=host)
        if name in rows:
            require(rows[name] == row, 'Constructed ancestor changed')
        else:
            rows[name] = row
            total += row.get('bytes', 0)
            attributes += sum(len(_base.base64.b64decode(value)) for value in row['xattrs'].values())
            metadata_bytes += len(canonical_json(name)) + len(canonical_json(row)) + 2
            require(len(rows) <= _base.MAX_ENTRIES and total <= _base.MAX_BYTES and
                    attributes <= _base.MAX_ALL_XATTR_BYTES and metadata_bytes + 2 <= _base.MAX_JSON,
                    'Constructed tree exceeds bounded transport profile')
        if recurse and row['type'] == 'directory':
            descriptor = _base._open(root / name, os.O_RDONLY | os.O_DIRECTORY)
            try:
                require(identity(os.fstat(descriptor)) == row['originalIdentity'], 'Constructed directory changed')
                children = _base._children(descriptor, _base.MAX_ENTRIES - len(rows))
                for child in children:
                    visit(name + '/' + child, True)
                require(children == _base._children(descriptor, len(children)) and
                        identity(os.fstat(descriptor)) == identity(_base._stat(root / name)) == row['originalIdentity'],
                        'Constructed membership changed')
            finally:
                os.close(descriptor)
    for name in description['include']:
        for parent in reversed(PurePosixPath(name).parents):
            if str(parent) != '.' and str(parent) not in rows:
                visit(str(parent), False)
        visit(name, True)
    require(root_identity == identity(_base._stat(root)) and _host() == host, 'Scoped observation boundary changed')
    result = dict(sorted(rows.items()))
    _base._validate_rows(result)
    return result


def inventory(root, includes):
    return snapshot({'include': includes}, root)


def _record_binding(value, ref):
    _base._ref_shape(ref)
    data = canonical_json(value) + b'\n'
    require(ref['hash'] == 'sha256:' + digest(data) and ref['byteLength'] == str(len(data)),
            'Retained owned record differs from its sealed bytes')


def _lease_shape(value):
    keys(value, ['id', 'root', 'device', 'inode', 'uid'])
    _uuid(value['id'])
    _base._absolute(value['root'])
    require(type(value['device']) is int and value['device'] >= 0 and type(value['inode']) is int and value['inode'] > 0 and
            type(value['uid']) is int and value['uid'] > 0, 'Invalid owned root identity')


def _filter_identity(machine):
    """Consumer-side pin of the helper's reviewed classic-BPF program."""
    require(machine in ('x86_64', 'aarch64'), 'Unsupported owned filter architecture')
    arch, clone, unshare, setns = ((0xc000003e, 56, 272, 308) if machine == 'x86_64'
                                  else (0xc00000b7, 220, 97, 268))
    instructions = [
        (0x20, 0, 0, 4), (0x15, 1, 0, arch), (0x06, 0, 0, 0x80000000),
        (0x20, 0, 0, 0), (0x45, 0, 1, 0x40000000), (0x06, 0, 0, 0x80000000),
        (0x15, 0, 1, setns), (0x06, 0, 0, 0x00050001),
        (0x15, 0, 1, unshare), (0x06, 0, 0, 0x00050001),
        (0x15, 0, 1, 435), (0x06, 0, 0, 0x00050026),
        (0x15, 0, 3, clone), (0x20, 0, 0, 16), (0x45, 0, 1, 0x7e020000),
        (0x06, 0, 0, 0x00050001), (0x06, 0, 0, 0x7fff0000),
    ]
    encoded = b''.join(_base.struct.pack('<HBBI', *row) for row in instructions)
    return {'policy': 'linux-owned-no-namespace-entry-1', 'sha256': digest(encoded),
            'architecture': machine, 'installed': True}


class OwnedTree:
    def __init__(self, issuer, destination, host, provenance, storage_version):
        require(issuer is _ISSUER, 'Existing paths cannot be adopted as owned trees')
        self.wrapper = destination
        self.root = destination / 'root'
        self.control = destination / 'control'
        _base._mkdir(self.root)
        _base._mkdir(self.control)
        self._descriptor = _base._open(self.root, os.O_RDONLY | os.O_DIRECTORY)
        observed = os.fstat(self._descriptor)
        self._identity = {'id': str(uuid.uuid4()), 'root': str(self.root), 'device': observed.st_dev,
                          'inode': observed.st_ino, 'uid': host['uid']}
        self._host = host
        self._provenance = decode_json(canonical_json(provenance))
        self._version = storage_version
        self._operations = []
        self._operation_bytes = 0
        self._active = None
        self._tainted = False
        self._closed = False
        _TREES[self._identity['id']] = self

    def _assert(self, idle=True):
        require(not self._closed and _TREES.get(self._identity['id']) is self and not self._tainted,
                'Owned capability is absent, closed, or permanently tainted')
        try:
            require(_host() == self._host, 'Owned process authority changed')
            observed = os.fstat(self._descriptor)
            current = _base._stat(self.root)
            require((observed.st_dev, observed.st_ino) == (current.st_dev, current.st_ino) ==
                    (self._identity['device'], self._identity['inode']) and current.st_uid == self._host['uid'] and
                    stat.S_ISDIR(current.st_mode) and stat.S_IMODE(current.st_mode) == 0o700,
                    'Owned private root changed or was replaced')
            wrapper = _base._stat(self.wrapper)
            require(wrapper.st_uid == self._host['uid'] and stat.S_ISDIR(wrapper.st_mode) and
                    stat.S_IMODE(wrapper.st_mode) == 0o700, 'Owned private wrapper changed')
        except BaseException:
            self._tainted = True
            raise
        require(not idle or self._active is None, 'Owned construction/command is still active')

    def _descendant(self, root):
        root = canonical(str(root))
        require(root == self.root or self.root in root.parents, 'Root is not a descendant of this fresh owned tree')
        require(stat.S_ISDIR(_base._stat(root).st_mode), 'Owned selection root is not a directory')
        return root

    def _retain(self, record):
        require(len(self._operations) < 4096, 'Too many owned construction operations')
        size = len(canonical_json(record)) + 1
        require(size <= 8 * _base.CHUNK and self._operation_bytes + size <= 16 * _base.CHUNK,
                'Owned construction receipts exceed bounded metadata budget')
        destination = self.control / ('operation-' + str(len(self._operations)) + '.json')
        save(destination, record)
        self._operations.append({'record': record, 'receipt': file_ref(destination)})
        self._operation_bytes += size

    @_serial
    def construct(self, callback, *, kind, inputs, creator=None):
        """Invoke a sealed producer's synchronous filesystem-only creator.

        The callback must close its writers and must not spawn/delegate work;
        executable builders use run(). Hostile same-UID callers are not isolated.
        """
        self._assert()
        require(kind in ('source-reconstitution', 'retained-evidence', 'fixture-construction') and callable(callback),
                'Unsupported owned creator')
        require(isinstance(inputs, dict) and 0 < len(inputs) <= 32 and all(isinstance(key, str) for key in inputs),
                'Creator requires explicit pinned inputs')
        for reference in inputs.values():
            verify_ref(reference)
        code = getattr(callback, '__code__', None)
        require(code is not None, 'Creator must have a retained Python source identity')
        observed_creator = file_ref(canonical(str(Path(code.co_filename).absolute())))
        if creator is not None:
            require(creator == observed_creator, 'Creator source identity differs')
        self._active = 'construction'
        try:
            result = callback(self.root)
            self._assert(idle=False)
            for reference in inputs.values():
                verify_ref(reference)
            verify_ref(observed_creator)
            record = {'kind': 'linux-owned-construction-operation-1', 'operation': kind,
                      'lease': dict(self._identity), 'inputs': inputs, 'creator': observed_creator,
                      'result': 'completed', 'filesystemOnlyCreator': True, 'completedAt': now()}
            self._retain(record)
            return result
        except BaseException:
            self._tainted = True
            raise
        finally:
            self._active = None

    @_serial
    def run(self, argv, cwd, log, env, timeout, *, grants=()):
        owners = [self, *grants]
        require(len(owners) <= 16 and len({id(tree) for tree in owners}) == len(owners), 'Invalid owned command grants')
        for tree in owners:
            require(type(tree) is OwnedTree, 'Command grants must be live owned capabilities')
            tree._assert()
        roots = [tree.root for tree in owners]
        require(all(not (left in right.parents or right in left.parents) for index, left in enumerate(roots)
                    for right in roots[index + 1:]), 'Owned command roots overlap')
        cwd = canonical(str(cwd))
        require(any(cwd == root or root in cwd.parents for root in roots), 'Command cwd has no owned grant')
        require(isinstance(argv, (list, tuple)) and 0 < len(argv) <= 256 and all(isinstance(arg, (str, Path)) for arg in argv),
                'Invalid direct-exec command')
        argv = [str(arg) for arg in argv]
        argv[0] = str(canonical(str(Path(argv[0]).resolve(strict=True))))
        require(isinstance(env, dict) and all(isinstance(key, str) and isinstance(value, str) for key, value in env.items()),
                'Command requires an explicit string environment')
        require(type(timeout) in (int, float) and 0 < timeout <= 3600, 'Command timeout outside owned profile')
        log = new_destination(log, roots)
        parent = _base._stat(log.parent)
        require(stat.S_ISDIR(parent.st_mode) and parent.st_uid == self._host['uid'] and stat.S_IMODE(parent.st_mode) == 0o700,
                'Command records require an existing private owner directory outside owned data roots')
        helper = file_ref(Path(__file__).absolute().with_name('owned_process.py'))
        receipt_path = log.with_name(log.name + '.receipt.json')
        control_path = log.with_name(log.name + '.control.json')
        nonce = str(uuid.uuid4())
        control = {'kind': 'linux-owned-command-control-1', 'argv': argv, 'cwd': str(cwd), 'env': dict(env),
                   'timeoutSeconds': timeout, 'log': str(log), 'receipt': str(receipt_path), 'nonce': nonce,
                   'leases': [dict(tree._identity) for tree in owners], 'helper': helper}
        require(len(canonical_json(control)) + 1 <= 4 * _base.CHUNK, 'Owned command control exceeds helper budget')
        save(control_path, control)
        control_ref = file_ref(control_path)
        for tree in owners:
            tree._active = nonce
        child = None
        try:
            child = subprocess.Popen([sys.executable, '-I', '-S', str(helper['path']), str(control_path)],
                                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                     close_fds=True, start_new_session=True)
            child.wait(timeout=timeout + 15)
            require(child.returncode == 0, 'Owned command supervisor failed; all granted trees are tainted')
            result_ref = file_ref(receipt_path)
            result = sealed_json(result_ref)
            _command_record(result)
            require(result['nonce'] == nonce and result['argv'] == argv and result['cwd'] == str(cwd) and
                    result['environment'] == env and result['leases'] == control['leases'] and result['log']['path'] == str(log),
                    'Owned command result differs from the actual invocation')
            require(result['supervisor']['pid'] == child.pid, 'Owned result names another supervisor')
            verify_ref(control_ref)
            verify_ref(result['log'])
            verify_ref(helper)
            for tree in owners:
                tree._assert(idle=False)
                tree._retain({'kind': 'linux-owned-command-operation-1', 'lease': dict(tree._identity),
                              'helper': helper, 'control': control, 'controlRef': control_ref,
                              'result': result, 'resultRef': result_ref})
            return {**result, 'receipt': result_ref}
        except BaseException:
            for tree in owners:
                tree._tainted = True
            # No attempt to claim detached descendants were drained. The taint
            # cannot be cleared by a caller-supplied boolean or another command.
            if child is not None and child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=5)
            raise
        finally:
            for tree in owners:
                tree._active = None

    @_serial
    def close(self):
        require(self._active is None, 'Cannot close an active owned tree')
        if not self._closed:
            self._closed = True
            _TREES.pop(self._identity['id'], None)
            os.close(self._descriptor)


@_serial
def acquire(destination, *, provenance, storageVersion):
    _storage(storageVersion)
    host = _host()
    require(isinstance(provenance, dict) and len(canonical_json(provenance)) <= _base.CHUNK, 'Invalid acquisition provenance')
    require(len(_TREES) < 64, 'Too many live owned capabilities')
    protected = [tree.root for tree in _TREES.values() if not tree._closed]
    destination = new_destination(destination, protected)
    _base._mkdir(destination)
    return OwnedTree(_ISSUER, destination, host, provenance, storageVersion)


def _command_record(record):
    keys(record, ['kind', 'nonce', 'argv', 'cwd', 'environment', 'exitCode', 'elapsedMs', 'processGroupDrained',
                  'ownedDescendantsDrained', 'globalInactivityVerified', 'filter', 'leases', 'log',
                  'supervisor', 'finishedAt', 'failure'])
    require(record['kind'] == 'linux-owned-command-result-1' and record['failure'] is None and
            type(record['exitCode']) is int and record['exitCode'] == 0 and record['processGroupDrained'] is True and
            record['ownedDescendantsDrained'] is True and record['globalInactivityVerified'] is False and
            type(record['elapsedMs']) is int and record['elapsedMs'] >= 0, 'Owned command was not actually drained and successful')
    _uuid(record['nonce'])
    require(isinstance(record['argv'], list) and record['argv'] and all(isinstance(arg, str) for arg in record['argv']) and
            isinstance(record['environment'], dict) and all(isinstance(key, str) and isinstance(value, str)
            for key, value in record['environment'].items()), 'Malformed owned invocation')
    _base._absolute(record['cwd'])
    require(isinstance(record['leases'], list) and 0 < len(record['leases']) <= 16, 'Missing command leases')
    for lease in record['leases']:
        _lease_shape(lease)
    require(len({lease['id'] for lease in record['leases']}) == len(record['leases']), 'Repeated command lease')
    keys(record['filter'], ['policy', 'sha256', 'architecture', 'installed'])
    require(record['filter'] == _filter_identity(record['filter']['architecture']), 'Missing or altered owned namespace boundary')
    keys(record['supervisor'], ['pid', 'startTicks'])
    require(type(record['supervisor']['pid']) is int and record['supervisor']['pid'] > 0 and
            isinstance(record['supervisor']['startTicks'], str) and re.fullmatch('0|[1-9][0-9]*', record['supervisor']['startTicks']),
            'Missing supervisor identity')
    _base._ref_shape(record['log'])


def _ownership(value):
    keys(value, ['kind', 'lease', 'storageVersion', 'provenance', 'operations', 'globalInactivityVerified',
                 'exclusiveSameUidWriterVerified', 'constructionContract'])
    require(value['kind'] == 'linux-owned-construction-chain-1' and value['globalInactivityVerified'] is False and
            value['exclusiveSameUidWriterVerified'] is False and value['constructionContract'] ==
            'sealed-cooperative-producer-no-external-writers-or-delegated-services-1', 'Unsupported construction authority')
    _lease_shape(value['lease'])
    _storage(value['storageVersion'])
    require(isinstance(value['provenance'], dict) and isinstance(value['operations'], list) and
            0 < len(value['operations']) <= 4096, 'Construction history is absent')
    require(sum(len(canonical_json(item.get('record'))) + 1 for item in value['operations']
                if isinstance(item, dict)) <= 16 * _base.CHUNK, 'Owned operation metadata exceeds budget')
    for operation in value['operations']:
        keys(operation, ['record', 'receipt'])
        record = operation['record']
        require(len(canonical_json(record)) + 1 <= 8 * _base.CHUNK, 'Owned operation exceeds individual budget')
        _record_binding(record, operation['receipt'])
        require(isinstance(record, dict) and record.get('lease') == value['lease'], 'Operation belongs to another root')
        if record.get('kind') == 'linux-owned-construction-operation-1':
            keys(record, ['kind', 'operation', 'lease', 'inputs', 'creator', 'result', 'filesystemOnlyCreator', 'completedAt'])
            require(record['operation'] in ('source-reconstitution', 'retained-evidence', 'fixture-construction') and
                    record['result'] == 'completed' and record['filesystemOnlyCreator'] is True and
                    isinstance(record['inputs'], dict) and 0 < len(record['inputs']) <= 32, 'Incomplete owned creator')
            for reference in [record['creator'], *record['inputs'].values()]:
                _base._ref_shape(reference)
        elif record.get('kind') == 'linux-owned-command-operation-1':
            keys(record, ['kind', 'lease', 'helper', 'control', 'controlRef', 'result', 'resultRef'])
            _base._ref_shape(record['helper'])
            _record_binding(record['control'], record['controlRef'])
            _record_binding(record['result'], record['resultRef'])
            _command_record(record['result'])
            control, result = record['control'], record['result']
            keys(control, ['kind', 'argv', 'cwd', 'env', 'timeoutSeconds', 'log', 'receipt', 'nonce', 'leases', 'helper'])
            require(control['kind'] == 'linux-owned-command-control-1' and control['helper'] == record['helper'] and
                    record['lease'] in result['leases'] and control['leases'] == result['leases'] and
                    control['nonce'] == result['nonce'] and control['argv'] == result['argv'] and
                    control['cwd'] == result['cwd'] and control['env'] == result['environment'] and
                    control['log'] == result['log']['path'] and control['receipt'] == record['resultRef']['path'],
                    'Owned command provenance differs')
        elif record.get('kind') == 'linux-owned-restored-construction-1':
            keys(record, ['kind', 'lease', 'archive', 'manifest', 'restoreProof', 'result'])
            require(record['result'] == 'verified-scoped-restore', 'Incomplete restored construction')
            for reference in (record['archive'], record['manifest'], record['restoreProof']):
                _base._ref_shape(reference)
        else:
            raise ArchiveError('Unknown owned construction operation')


def _owned_manifest(value):
    keys(value, ['kind', 'metadataPolicy', 'metadataScope', 'storageVersion', 'role', 'sourceRoot', 'includes', 'entries',
                 'provenance', 'archive', 'backend', 'baseHelper', 'ownership', 'createdAt', 'originalsUnchanged',
                 'originalDeletionAuthorized', 'status', 'logicalMembers', 'metadataMembers', 'exactPathSet'])
    require(value['kind'] == KIND and value['metadataPolicy'] == POLICY and value['metadataScope'] == SCOPE and
            value['originalsUnchanged'] is True and value['originalDeletionAuthorized'] is False and
            value['status'] == 'copied-scoped-restore-pending' and value['exactPathSet'] is True and
            type(value['metadataMembers']) is int and value['metadataMembers'] == 0, 'Unsupported/incomplete owned transport')
    _storage(value['storageVersion'])
    _base._absolute(value['sourceRoot'])
    require(isinstance(value['role'], str) and re.fullmatch('[A-Za-z0-9_-]{1,128}', value['role']) and
            isinstance(value['provenance'], dict), 'Invalid owned closure role/provenance')
    _base._includes(value['includes'])
    _base._validate_rows(value['entries'])
    _ownership(value['ownership'])
    require(value['ownership']['storageVersion'] == value['storageVersion'] and
            below(value['sourceRoot'], value['ownership']['lease']['root']), 'Owned root/version differs')
    require(type(value['logicalMembers']) is int and value['logicalMembers'] == len(value['entries']), 'Owned member count differs')
    selected = set(value['includes'])
    ancestors = {str(parent) for chosen in selected for parent in PurePosixPath(chosen).parents}
    require(selected <= set(value['entries']), 'Owned selection is incomplete')
    for name, row in value['entries'].items():
        require(name in ancestors or any(str(parent) in selected for parent in [PurePosixPath(name), *PurePosixPath(name).parents]),
                'Unselected owned member')
        require(row['uid'] == value['ownership']['lease']['uid'] and
                not any(key.startswith('trusted.') for key in row['xattrs']), 'Metadata exceeds owned profile')
    for reference in (value['archive'], value['backend'], value['baseHelper']):
        _base._ref_shape(reference)
    require(value['baseHelper']['hash'] == 'sha256:' + BASE_SHA256, 'Owned byte primitive identity differs')


@_serial
def create_owned(tree, root, includes, destination, *, role, provenance, storageVersion):
    require(type(tree) is OwnedTree, 'Capture requires a live fresh-construction capability')
    tree._assert()
    _storage(storageVersion)
    require(storageVersion == tree._version, 'Owned tree storage version differs')
    root = tree._descendant(root)
    require(tree._operations, 'No actual creator invocation was retained')
    require(isinstance(role, str) and re.fullmatch('[A-Za-z0-9_-]{1,128}', role) and isinstance(provenance, dict),
            'Invalid owned capture description')
    require(len(canonical_json(provenance)) <= _base.CHUNK, 'Owned capture provenance exceeds bound')
    destination = new_destination(destination, [tree.root])
    before = inventory(root, includes)
    ownership = {'kind': 'linux-owned-construction-chain-1', 'lease': dict(tree._identity), 'storageVersion': storageVersion,
                 'provenance': tree._provenance, 'operations': decode_json(canonical_json(tree._operations)),
                 'globalInactivityVerified': False, 'exclusiveSameUidWriterVerified': False,
                 'constructionContract': 'sealed-cooperative-producer-no-external-writers-or-delegated-services-1'}
    _ownership(ownership)
    space(destination.parent, sum(row.get('bytes', 0) for row in before.values()) * 3 + len(before) * 32768 + _base.MAX_JSON)
    _base._mkdir(destination)
    tree._active = 'capture'
    try:
        payload = destination / 'payload.tar.gz'
        _base._write_archive(payload, root, before)
        validation = validate_archive(payload, before)
        require(inventory(root, includes) == before, 'Owned source changed during capture')
        tree._assert(idle=False)
        manifest = {'kind': KIND, 'metadataPolicy': POLICY, 'metadataScope': SCOPE, 'storageVersion': storageVersion,
                    'role': role, 'sourceRoot': str(root), 'includes': includes, 'entries': before, 'provenance': provenance,
                    'archive': file_ref(payload), 'backend': file_ref(Path(__file__).absolute()),
                    'baseHelper': file_ref(Path(_base.__file__)), 'ownership': ownership, 'createdAt': now(),
                    'originalsUnchanged': True, 'originalDeletionAuthorized': False,
                    'status': 'copied-scoped-restore-pending', **validation}
        _owned_manifest(manifest)
        save(destination / 'manifest.json', manifest)
        return {'archive': file_ref(payload), 'manifest': file_ref(destination / 'manifest.json')}
    except BaseException as error:
        tree._tainted = True
        failure(destination, error)
        raise
    finally:
        tree._active = None


def _install_scoped(path, row, host):
    require(row['uid'] == host['uid'] and row['gid'] in host['groups'], 'Restore exceeds current owner authority')
    descriptor = _base._open(path)
    try:
        current = os.fstat(descriptor)
        require(current.st_uid == host['uid'], 'Restored entry is not owned')
        if current.st_gid != row['gid']:
            os.fchown(descriptor, -1, row['gid'])
        os.fchmod(descriptor, row['mode'])
        observed = _base._xattrs(descriptor)
        for name in observed:
            if name not in row['xattrs']:
                os.removexattr(descriptor, name)
        for name, value in sorted(row['xattrs'].items()):
            # Inherited filesystem/LSM metadata can be readable but not settable.
            # Matching bytes need no authority to rewrite them; differences fail.
            if observed.get(name) != value:
                os.setxattr(descriptor, name, _base.base64.b64decode(value, validate=True))
        os.utime(descriptor, ns=(current.st_atime_ns, row['mtimeNs']))
        os.fsync(descriptor)
        require(_base._flags(descriptor, row['type'] == 'directory') == row['flags'], 'Installed full flags differ')
        require(identity(os.fstat(descriptor)) == identity(_base._stat(path)), 'Scoped restore entry was replaced')
    finally:
        os.close(descriptor)


def verify_restore_record(proof, original, installed, expected):
    _owned_manifest(original)
    keys(expected, ['archive', 'manifest'], ['name'])
    keys(installed, ['kind', 'metadataPolicy', 'metadataScope', 'sourceArchiveHash', 'sourceManifestHash', 'entries'])
    require(installed['kind'] == 'linux-owned-installed-metadata-1' and installed['metadataPolicy'] == POLICY and
            installed['metadataScope'] == SCOPE and installed['sourceArchiveHash'] == expected['archive']['hash'] and
            installed['sourceManifestHash'] == expected['manifest']['hash'], 'Owned installed record binding differs')
    _base._validate_rows(installed['entries'])
    require({name: portable(row) for name, row in original['entries'].items()} ==
            {name: portable(row) for name, row in installed['entries'].items()}, 'Declared scoped metadata or bytes differ')
    keys(proof, ['kind', 'metadataPolicy', 'metadataScope', 'storageVersion', 'result', 'archive', 'manifest', 'restoredRoot',
                 'contentVerified', 'scopedMetadataVerified', 'exactMetadata', 'hiddenMetadataObserved',
                 'globalInactivityVerified', 'entries', 'installedManifest', 'originalDeletionAuthorized', 'verifiedAt'])
    require(proof['kind'] == 'linux-owned-closure-restore-1' and proof['metadataPolicy'] == POLICY and proof['metadataScope'] == SCOPE and
            type(proof['storageVersion']) is int and proof['storageVersion'] == original['storageVersion'] and
            proof['result'] == 'verified-scoped-restore' and proof['contentVerified'] is True and proof['scopedMetadataVerified'] is True and
            proof['exactMetadata'] is False and proof['hiddenMetadataObserved'] is False and proof['globalInactivityVerified'] is False and
            proof['originalDeletionAuthorized'] is False and type(proof['entries']) is int and proof['entries'] == len(original['entries']),
            'Unsupported or overstated owned restore proof')
    require(_base._same_ref(proof['archive'], expected['archive']) and _base._same_ref(proof['manifest'], expected['manifest']) and
            _base._same_ref(original['archive'], expected['archive']), 'Owned restore closure differs')
    _base._absolute(proof['restoredRoot'])
    _record_binding(original, expected['manifest'])
    _record_binding(installed, proof['installedManifest'])
    return {'result': 'verified-scoped-restore', 'contentVerified': True, 'scopedMetadataVerified': True,
            'exactMetadata': False, 'hiddenMetadataObserved': False, 'globalInactivityVerified': False,
            'entries': len(original['entries'])}


def verify_restore_set(records, expected, read_record):
    roles = ['source', 'application', 'fixture']
    require(isinstance(records, list) and len(records) == 3 and all(isinstance(item, dict) for item in records) and
            [item.get('role') for item in records] == roles and isinstance(expected, dict) and set(expected) == set(roles),
            'Incomplete or duplicated owned restore roles')
    for item in records:
        keys(item, ['role', 'record'])
        proof = read_record(item['record'])
        verify_restore_record(proof, read_record(proof['manifest']), read_record(proof['installedManifest']), expected[item['role']])


@_serial
def restore_owned(closure, destination):
    host = _host()
    keys(closure, ['archive', 'manifest'], ['name'])
    payload = verify_ref(closure['archive'])
    manifest = sealed_json(closure['manifest'])
    _owned_manifest(manifest)
    require(_base._same_ref(manifest['archive'], closure['archive']), 'Owned archive/manifest differs')
    rows = manifest['entries']
    require(all(row['uid'] == host['uid'] and row['gid'] in host['groups'] for row in rows.values()),
            'Scoped restore requires the same numeric owner and available groups; no remapping')
    validate_archive(payload, rows)
    destination = new_destination(destination, [payload.parent, Path(closure['manifest']['path']).parent, Path(manifest['sourceRoot'])])
    space(destination.parent, sum(row.get('bytes', 0) for row in rows.values()) + len(rows) * 32768 + _base.MAX_JSON)
    tree = acquire(destination, provenance={'restoredFrom': closure}, storageVersion=manifest['storageVersion'])
    tree._active = 'restore'
    transferred = False
    try:
        def begin(name, row):
            if row['type'] == 'directory':
                _base._mkdir(tree.root / name)
                return None
            return _base._open(tree.root / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
        def write(descriptor, block):
            require(descriptor is not None, 'Cannot write a directory')
            _base._write_all(descriptor, block)
        def end(descriptor):
            if descriptor is not None:
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
        _base._walk_archive(payload, rows, begin, write, end)
        for name in sorted(rows, key=lambda value: (len(PurePosixPath(value).parts), value), reverse=True):
            _install_scoped(tree.root / name, rows[name], host)
        after = inventory(tree.root, manifest['includes'])
        require({name: portable(row) for name, row in after.items()} ==
                {name: portable(row) for name, row in rows.items()}, 'Scoped restore bytes/metadata differ')
        actual = set()
        def walk(path, prefix=''):
            descriptor = _base._open(path, os.O_RDONLY | os.O_DIRECTORY)
            try:
                for child in _base._children(descriptor, len(rows) - len(actual)):
                    name = prefix + child
                    require(name in rows and name not in actual, 'Unexpected owned restore member')
                    actual.add(name)
                    if rows[name]['type'] == 'directory':
                        walk(path / child, name + '/')
            finally:
                os.close(descriptor)
        walk(tree.root)
        require(actual == set(rows), 'Scoped restore membership differs')
        os.fsync(tree._descriptor)
        tree._assert(idle=False)
        verify_ref(closure['archive'])
        verify_ref(closure['manifest'])
        installed = {'kind': 'linux-owned-installed-metadata-1', 'metadataPolicy': POLICY, 'metadataScope': SCOPE,
                     'sourceArchiveHash': closure['archive']['hash'], 'sourceManifestHash': closure['manifest']['hash'], 'entries': after}
        save(destination / 'installed-manifest.json', installed)
        proof = {'kind': 'linux-owned-closure-restore-1', 'metadataPolicy': POLICY, 'metadataScope': SCOPE,
                 'storageVersion': manifest['storageVersion'], 'result': 'verified-scoped-restore',
                 'archive': closure['archive'], 'manifest': closure['manifest'], 'restoredRoot': str(tree.root),
                 'contentVerified': True, 'scopedMetadataVerified': True, 'exactMetadata': False,
                 'hiddenMetadataObserved': False, 'globalInactivityVerified': False, 'entries': len(rows),
                 'installedManifest': file_ref(destination / 'installed-manifest.json'),
                 'originalDeletionAuthorized': False, 'verifiedAt': now()}
        verify_restore_record(proof, manifest, installed, closure)
        save(destination / 'restore.json', proof)
        proof_ref = file_ref(destination / 'restore.json')
        tree._retain({'kind': 'linux-owned-restored-construction-1', 'lease': dict(tree._identity),
                      'archive': closure['archive'], 'manifest': closure['manifest'], 'restoreProof': proof_ref,
                      'result': 'verified-scoped-restore'})
        transferred = True
        return tree.root, proof_ref, tree
    except BaseException as error:
        tree._tainted = True
        failure(destination, error)
        raise
    finally:
        tree._active = None
        if not transferred:
            tree.close()
