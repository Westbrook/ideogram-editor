#!/usr/bin/env python3
"""Explicitly unmeasured hosted control setup; never invokes a producer phase."""
import argparse
import datetime
import grp
import hashlib
import json
import os
from pathlib import Path
import platform
import pwd
import re
import signal
import stat
import subprocess
import sys
import time
import urllib.request
import uuid

REPOSITORY = 'Westbrook/ideogram-editor'
JOB_NAME = 'native-prerequisites'
PHASES = ('inputs', 'toolchain', 'build16', 'build17', 'build18', 'verify16', 'verify17', 'verify18')
OWNER = {'uid': 20000, 'gid': 20000, 'groups': []}
PACKAGES = ('ca-certificates', 'python3', 'build-essential', 'pkg-config', 'git', 'xz-utils', 'procps', 'util-linux')
INPUT = {'remote': 'https://github.com/Westbrook/ideogram-editor.git', 'commit': '850b10cfa4853a14290c7220538f4d6f49ba124d', 'tree': '769d56f65b15b7c5a420c22ec9160da38b0401ab', 'manifest': {'bytes': 12726, 'sha256': '5b71db1fd6c60980c8297b9fe48922a75c0a4dcaac6f73d6c4c0925a3e921e45'}}
SEALS = {'16': 'b074c7a19c6167a44b4dac1b370a6411dedaf3c9406538313838df919625dc3a', '17': '403083498d96297da60fc33fe17835df00abe286c3e26a981ce5e01f14dd8e3f', '18': '4b61813dc558928169c36c1883268ac8e55dc3e2b9867b33c22cf1981f27a3e9'}
MAX_SETUP_LOG = 16 * 1024**2
SETUP_CHILD_UNCERTAIN = False
SETUP_LABELS = ('apt-update','apt-install','control-toolchain','control-node-version','control-npm-version','control-python-version','producer-group','producer-account','native-host-selection')

def require(value, message):
    if not value: raise ValueError(message)

def canonical(value):
    p = Path(value)
    require(p.is_absolute() and str(p) == value and not any(c in value for c in '\\\r\n\x00'), 'Canonical absolute path required')
    require(p.resolve(strict=True) == p, 'Path alias refused')
    return p

def stamp(s):
    return (s.st_dev, s.st_ino, s.st_mode, s.st_nlink, s.st_uid, s.st_gid, s.st_size, s.st_mtime_ns, s.st_ctime_ns)

def read(path, maximum=4*1024**2, root_owned=False):
    path = canonical(str(path)); before = path.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= maximum, 'Bounded single-link regular input required')
    if root_owned:
        for member in [path, *path.parents]:
            s = member.lstat(); require(s.st_uid == 0 and not stat.S_IMODE(s.st_mode) & 0o022, 'Immutable root-owned input required')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        require(stamp(before) == stamp(os.fstat(fd)), 'Input changed before read'); data = bytearray()
        while block := os.read(fd, 65536):
            data.extend(block); require(len(data) <= maximum, 'Input bound exceeded')
        require(len(data) == before.st_size and stamp(before) == stamp(os.fstat(fd)) == stamp(path.lstat()), 'Input changed during read')
        return bytes(data)
    finally: os.close(fd)

def identity(path, raw=None):
    raw = read(path, 256*1024**2) if raw is None else raw
    return {'path': str(path), 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}

def save(path, value, mode=0o444):
    raw = value if isinstance(value, bytes) else (json.dumps(value, sort_keys=True, indent=2)+'\n').encode()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, 'wb') as f: f.write(raw); f.flush(); os.fsync(f.fileno())
    require(read(path, max(len(raw), 1), True) == raw, 'Exclusive output readback differs')
    return identity(path, raw)

def utc_ms(value):
    require(isinstance(value, str) and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ', value), 'Exact GitHub UTC job timestamp required')
    return int(datetime.datetime.strptime(value, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc).timestamp()*1000)

def select_job(response, run, attempt, head, first_step_ms):
    require(type(run) is int and run > 0 and type(attempt) is int and attempt > 0 and re.fullmatch('[0-9a-f]{40}', head), 'Actual run/attempt/head required')
    require(type(first_step_ms) is int and first_step_ms > 0, 'Actual first-step timestamp required')
    require(isinstance(response, dict) and type(response.get('total_count')) is int and isinstance(response.get('jobs'), list), 'Job response shape differs')
    require(0 < response['total_count'] == len(response['jobs']) <= 100, 'Partial or oversized job response refused')
    matches = [j for j in response['jobs'] if j.get('name') == JOB_NAME]
    require(len(matches) == 1, 'Exactly one fixed hosted job required'); job = matches[0]
    require(job.get('run_id') == run and job.get('run_attempt') == attempt and job.get('head_sha') == head, 'Current job identity differs')
    require(job.get('status') == 'in_progress' and job.get('conclusion') is None and type(job.get('id')) is int and job['id'] > 0, 'Actual active job required')
    started = utc_ms(job.get('started_at')); require(0 < started <= first_step_ms, 'Job start cannot follow first setup observation')
    return {'jobId': job['id'], 'jobName': JOB_NAME, 'startedEpochMs': started, 'deadlineEpochMs': started+21600000, 'startedAt': job['started_at']}

def source_rows(value):
    require(isinstance(value, dict) and set(value) == {'kind', 'files'} and value['kind'] == 'hosted-native-workflow-source-selection-1', 'Fixed source selection required')
    rows = value['files']; require(isinstance(rows, list) and 1 <= len(rows) <= 256, 'Source membership bound')
    seen = set(); total = 0
    for row in rows:
        require(isinstance(row, dict) and set(row) == {'path', 'bytes', 'sha256'}, 'Source row fields differ')
        name = row['path']; require(isinstance(name, str) and not name.startswith('/') and not any(c in name for c in '\\\r\n\x00') and all(p not in ('', '.', '..') for p in name.split('/')), 'Unsafe source member')
        require(name not in seen and not any(name.startswith(p+'/') or p.startswith(name+'/') for p in seen), 'Duplicate or conflicting source member'); seen.add(name)
        require(type(row['bytes']) is int and 0 <= row['bytes'] <= 256*1024**2 and re.fullmatch('[0-9a-f]{64}', row['sha256']), 'Invalid source identity'); total += row['bytes']
    require(total <= 512*1024**2, 'Source closure byte bound')
    return rows

def clean_environment(home, tmp):
    return {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': str(home), 'TMPDIR': str(tmp), 'LANG': 'C', 'LC_ALL': 'C', 'TZ': 'UTC', 'DEBIAN_FRONTEND': 'noninteractive', 'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONNOUSERSITE': '1', 'PYTHONSAFEPATH': '1'}

def fresh_directory(path, mode=0o755, owner=None):
    require(path.parent.resolve(strict=True) == path.parent, 'Directory parent alias refused'); path.mkdir(mode=mode)
    if owner: os.chown(path, owner['uid'], owner['gid'])
    return path

class SetupCommands:
    def __init__(self, directory, environment, deadline):
        self.directory, self.environment, self.deadline, self.records = directory, environment, deadline, []

    def run(self, label, argv, timeout=600, environment=None):
        global SETUP_CHILD_UNCERTAIN
        require(label in SETUP_LABELS, 'Fixed setup label required')
        require(time.time()*1000+timeout*1000+1800000 < self.deadline, 'Setup command would consume cleanup/export reserve')
        out = self.directory/(label+'.stdout'); err = self.directory/(label+'.stderr')
        started = time.time_ns(); result = None; child = None; failure = None
        with out.open('xb') as stdout, err.open('xb') as stderr:
            try:
                child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr, env=environment or self.environment, start_new_session=True)
                end = time.monotonic()+timeout
                while child.poll() is None:
                    require(time.monotonic() < end, 'Unmeasured setup command deadline')
                    require(os.fstat(stdout.fileno()).st_size+os.fstat(stderr.fileno()).st_size <= MAX_SETUP_LOG, 'Unmeasured setup output bound')
                    time.sleep(.05)
                result = child.wait(); require(result == 0, 'Unmeasured setup command failed: '+label)
            except BaseException as error: failure = type(error).__name__+': '+str(error)[:512]
            finally:
                if child:
                    try: os.killpg(child.pid, 0)
                    except ProcessLookupError: pass
                    else:
                        failure = failure or 'Unmeasured setup root left an owned process group'
                        try: os.killpg(child.pid, signal.SIGKILL)
                        except ProcessLookupError: pass
                    try: child.wait(timeout=10)
                    except BaseException: SETUP_CHILD_UNCERTAIN = True; raise
                    drain_end = time.monotonic()+10
                    while True:
                        try: os.killpg(child.pid, 0)
                        except ProcessLookupError: break
                        if time.monotonic() >= drain_end:
                            failure = 'Unmeasured setup process group did not drain'; SETUP_CHILD_UNCERTAIN = True; break
                        time.sleep(.05)
        require(out.stat().st_size+err.stat().st_size <= MAX_SETUP_LOG, 'Setup output bound exceeded')
        os.chmod(out, 0o444); os.chmod(err, 0o444)
        record = {'label': label, 'argv': argv, 'startedEpochNs': str(started), 'endedEpochNs': str(time.time_ns()), 'exitCode': result, 'failure': failure, 'stdout': identity(out), 'stderr': identity(err), 'setupMeasured': False}
        self.records.append(record); save(self.directory/(label+'.json'), record)
        require(failure is None, 'Unmeasured setup failed; retained bounded diagnostics: '+label)
        return read(out, MAX_SETUP_LOG)

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs): raise ValueError('Setup API redirect refused')

def fetch_job(token, run, attempt):
    require(isinstance(token, str) and 1 <= len(token) <= 4096 and not any(c.isspace() for c in token), 'Bounded ephemeral setup token required')
    url = f'https://api.github.com/repos/{REPOSITORY}/actions/runs/{run}/attempts/{attempt}/jobs?per_page=100'
    request = urllib.request.Request(url, headers={'Authorization': 'Bearer '+token, 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'ideogram-hosted-native-setup'})
    # One fixed authenticated request, no proxy configuration, redirects or retry.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    def deadline(_signal, _frame): raise TimeoutError('Fixed job API deadline')
    prior = signal.signal(signal.SIGALRM, deadline); signal.setitimer(signal.ITIMER_REAL,30)
    try:
        with opener.open(request, timeout=30) as response:
            require(response.status == 200 and response.geturl() == url, 'Actual current-job API response required')
            raw = response.read(1024*1024+1); require(len(raw) <= 1024*1024, 'Job response bound')
    finally: signal.setitimer(signal.ITIMER_REAL,0); signal.signal(signal.SIGALRM,prior)
    return url, raw

def setup(args):
    require(sys.platform == 'linux' and platform.machine() == 'x86_64' and os.getuid() == os.geteuid() == 0, 'Root Linux x64 setup required')
    require(os.getgroups() == [0] or not os.getgroups(), 'Unexpected setup supplementary groups')
    require(re.fullmatch('[0-9a-f]{40}', args.head) and re.fullmatch('[0-9a-f]{64}', args.source_sha256) and args.run > 0 and args.attempt > 0, 'Fixed run identity required')
    checkout = canonical(args.checkout); marker_path = Path(f'/opt/ideogram-native-job-{args.run}-{args.attempt}.json')
    marker_raw = read(marker_path, 16384, True); marker = json.loads(marker_raw)
    require(marker['kind'] == 'hosted-native-first-step-1' and marker['run'] == args.run and marker['attempt'] == args.attempt and marker['head'] == args.head, 'Actual first-step identity differs')
    runner_uid = marker['runnerUid']; require(type(runner_uid) is int and runner_uid > 0 and runner_uid != OWNER['uid'], 'Dedicated producer differs from runner')
    prefix = fresh_directory(Path(f'/opt/ideogram-native-{args.run}-{args.attempt}'))
    control = fresh_directory(prefix/'control'); meta = fresh_directory(control/'meta'); logs = fresh_directory(meta/'setup-commands')
    save(meta/'first-step.json', marker_raw)
    token = sys.stdin.buffer.read(4097).decode('ascii'); url, response = fetch_job(token, args.run, args.attempt); del token
    response_ref = save(meta/'github-jobs.json', response)
    observed_job = select_job(json.loads(response), args.run, args.attempt, args.head, marker['firstStepEpochMs'])
    require(time.time()*1000 < observed_job['deadlineEpochMs']-1800000, 'No actual setup/producer time remains')
    selection_raw = read(checkout/'tooling/rollback-producer/hosted-sources.json', 1024*1024)
    require(hashlib.sha256(selection_raw).hexdigest() == args.source_sha256, 'Reviewed source-selection pin differs')
    selection = source_rows(json.loads(selection_raw)); sources = []
    for row in selection:
        raw = read(checkout/row['path'], 256*1024**2)
        require(len(raw) == row['bytes'] and hashlib.sha256(raw).hexdigest() == row['sha256'], 'Selected source bytes differ')
        target = control/row['path']; target.parent.mkdir(mode=0o755, parents=True, exist_ok=True); sources.append(save(target, raw))
    save(meta/'source-selection.json', selection_raw)
    environment = clean_environment(fresh_directory(prefix/'setup-home', 0o700), fresh_directory(prefix/'setup-tmp', 0o700))
    commands = SetupCommands(logs, environment, observed_job['deadlineEpochMs'])
    commands.run('apt-update', ['/usr/bin/apt-get', 'update'], 600)
    commands.run('apt-install', ['/usr/bin/apt-get', 'install', '-y', '--no-install-recommends', *PACKAGES], 1200)
    require(sys.version_info >= (3, 12), 'CPython 3.12+ setup required')
    commands.run('control-toolchain', ['/usr/bin/python3', '-I', '-S', '-B', str(control/'tooling/bootstrap-toolchain.py')], 600)
    tool_dir = fresh_directory(control/'bin'); tools = {}; origins = {}
    for name, source in {'node': control/'.toolchain/node-v26.10.0-linux-x64/bin/node', 'python': Path('/usr/bin/python3').resolve(strict=True), 'git': Path('/usr/bin/git').resolve(strict=True), 'unshare': Path('/usr/bin/unshare').resolve(strict=True), 'setpriv': Path('/usr/bin/setpriv').resolve(strict=True)}.items():
        raw = read(source, 256*1024**2, True); origins[name] = identity(source, raw); tools[name] = save(tool_dir/name, raw, 0o555)
    require(commands.run('control-node-version', [tools['node']['path'], '--version']).decode().strip() == 'v26.10.0', 'Pinned control Node differs')
    require(commands.run('control-npm-version', [tools['node']['path'], str(control/'.toolchain/npm-12.1.0/package/bin/npm-cli.js'), '--version']).decode().strip() == '12.1.0', 'Pinned control npm differs')
    commands.run('control-python-version', [tools['python']['path'], '-I', '-S', '-B', '-c', 'import sys;assert sys.version_info>=(3,12);print(sys.version)'])
    for lookup, value in [(pwd.getpwuid, OWNER['uid']), (grp.getgrgid, OWNER['gid']), (pwd.getpwnam, 'ie-hosted-producer'), (grp.getgrnam, 'ie-hosted-producer')]:
        try: lookup(value)
        except KeyError: continue
        raise ValueError('Dedicated producer account/group already exists')
    commands.run('producer-group', ['/usr/sbin/groupadd', '--gid', str(OWNER['gid']), 'ie-hosted-producer'])
    commands.run('producer-account', ['/usr/sbin/useradd', '--uid', str(OWNER['uid']), '--gid', str(OWNER['gid']), '--no-create-home', '--no-user-group', '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', 'ie-hosted-producer'])
    account = pwd.getpwnam('ie-hosted-producer'); require((account.pw_uid, account.pw_gid) == (OWNER['uid'], OWNER['gid']) and all('ie-hosted-producer' not in g.gr_mem for g in grp.getgrall()), 'Dedicated account identity differs')
    storage = fresh_directory(Path(f'/var/lib/ideogram-native-{args.run}-{args.attempt}')); private = fresh_directory(storage/'setup-private', 0o700, OWNER)
    home = fresh_directory(private/'home', 0o700, OWNER); tmp = fresh_directory(private/'tmp', 0o700, OWNER)
    setup_env = clean_environment(home, tmp); observed = private/'observed'
    argv = [tools['setpriv']['path'], '--reuid=20000', '--regid=20000', '--clear-groups', '--inh-caps=-all', '--ambient-caps=-all', '--bounding-set=-all', '--no-new-privs', '--', tools['python']['path'], '-I', '-S', '-B', str(control/'tooling/rollback-producer/hosted-host.py'), '--producer-root', str(control/'tooling/rollback-producer/schema18'), '--producer-seal', SEALS['18'], '--output', str(observed)]
    commands.run('native-host-selection', argv, 600, setup_env)
    host_selection = save(meta/'host-selection.json', read(observed/'selection.json', 4*1024**2))
    host_observation = save(meta/'host-observation.json', read(observed/'observation.json', 16*1024**2))
    data = fresh_directory(storage/'data', 0o700, OWNER); evidence = fresh_directory(storage/'evidence', 0o700)
    export_parent = fresh_directory(Path(f'/opt/ideogram-native-export-{args.run}-{args.attempt}'))
    require(not list(data.iterdir()) and not list(evidence.iterdir()), 'Actual allocations must start empty')
    run_id = 'ie-native-'+uuid.uuid4().hex; now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    allocations = {}
    for name, root, capacity in [('evidence', evidence, 4*1024**3), ('data', data, 32*1024**3)]:
        allocations[name] = save(meta/(name+'-allocation.json'), {'kind': 'evidence-volume-allocation-1', 'allocationId': run_id+'-'+name, 'purpose': 'qualification-evidence-only', 'capacityBytes': capacity, 'root': str(root), 'issuedAt': now, 'owner': 'Build'})
    setup_record = {'kind': 'hosted-native-unmeasured-setup-1', 'setupMeasured': False, 'physicalQualification': False, 'producerAccountDedicated': True, 'runnerUid': runner_uid, 'owner': OWNER, 'run': args.run, 'attempt': args.attempt, 'controlHead': args.head, 'job': observed_job, 'api': {'url': url, 'response': response_ref}, 'firstStep': identity(meta/'first-step.json'), 'sourceSelection': identity(meta/'source-selection.json'), 'toolOrigins': origins, 'toolCopies': tools, 'commands': commands.records, 'setupHostEnvironment': {k:setup_env[k] for k in ('PATH','HOME','TMPDIR')}, 'setupHostOriginals': [identity(observed/n) for n in ('selection.json','observation.json')], 'payloadPreparationExecuted': False, 'capacityIsReservation': False}
    setup_ref = save(meta/'setup.json', setup_record)
    # These are closed credential-free setup records, not measured payload data.
    # Include their exact immutable bytes so fixed post-drain export retains the
    # command evidence and authenticated API response rather than dangling refs.
    for name in ('first-step.json', 'github-jobs.json', 'source-selection.json'):
        sources.append(identity(meta/name))
    for record in commands.records:
        sources.extend([identity(logs/(record['label']+'.json')), record['stdout'], record['stderr']])
    ds = data.stat(); config = {'kind': 'hosted-native-controller-config-1', 'runId': run_id, 'controlRoot': str(control), 'sources': sources, 'tools': tools, 'owner': OWNER, 'evidenceAllocation': allocations['evidence'], 'dataAllocation': allocations['data'], 'dataRootIdentity': {'dev': ds.st_dev, 'ino': ds.st_ino}, 'onlineNetns': os.readlink('/proc/self/ns/net'), 'setup': setup_ref, 'hostSelection': host_selection, 'hostObservation': host_observation, 'hostEnvironment': {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': str(data/'home'), 'TMPDIR': str(data/'tmp')}, 'input': INPUT, 'producers': {}, 'job': {k:observed_job[k] for k in ('startedEpochMs','deadlineEpochMs')}, 'exportRoot': str(export_parent/run_id)}
    for version in ('16','17','18'):
        ref = identity(control/f'tooling/rollback-producer/schema{version}/producer-seal.json'); require(ref['sha256'] == SEALS[version], 'Active producer seal differs'); config['producers'][version] = {'seal': ref}
    config_ref = save(meta/'config.json', config)
    return {'config': config_ref['path'], 'grant': config_ref['sha256'], 'node': tools['node']['path'], 'control': str(control), 'export_root': config['exportRoot']}

def require_directory_members(path, expected):
    path = canonical(str(path)); require(path.is_dir(), 'Fixed export directory required')
    members = list(path.iterdir())
    require({p.name for p in members} == set(expected), 'Unexpected setup export membership')
    require(all(not p.is_symlink() and (p.is_file() or p.is_dir()) for p in members), 'Linked or special setup export member')

def retain_setup_diagnostics(args, successful):
    """Copy finite setup files after owned groups disappear; no payload files."""
    require(not SETUP_CHILD_UNCERTAIN, 'Undrained setup child prevents diagnostic export')
    require(os.getuid() == os.geteuid() == 0 and args.run > 0 and args.attempt > 0, 'Root actual setup identity required')
    marker = Path(f'/opt/ideogram-native-job-{args.run}-{args.attempt}.json')
    marker_value = json.loads(read(marker, 16384, True)); require(marker_value['head'] == args.head and marker_value['run'] == args.run and marker_value['attempt'] == args.attempt, 'Setup diagnostic identity differs')
    parent = Path(f'/opt/ideogram-native-export-{args.run}-{args.attempt}')
    try: parent.lstat()
    except FileNotFoundError: fresh_directory(parent)
    require(canonical(str(parent)) == parent and parent.stat().st_uid == 0 and stat.S_IMODE(parent.stat().st_mode) == 0o755, 'Fixed setup export parent differs')
    require_directory_members(parent, set())
    target = fresh_directory(parent/'setup'); meta = Path(f'/opt/ideogram-native-{args.run}-{args.attempt}/control/meta')
    selected = [('first-step-original.json', marker, 16384)]
    for name in ('first-step.json','github-jobs.json','source-selection.json','host-selection.json','host-observation.json','setup.json','evidence-allocation.json','data-allocation.json','config.json'):
        selected.append((name,meta/name,16*1024**2))
    for label in SETUP_LABELS:
        for suffix in ('.json','.stdout','.stderr'): selected.append(('commands/'+label+suffix,meta/'setup-commands'/(label+suffix),MAX_SETUP_LOG))
    rows=[]; omitted=[]; total=0
    for destination,source,maximum in selected:
        try: source.lstat()
        except FileNotFoundError: continue
        # An oversized failed log is explicitly omitted, never partially copied.
        if source.lstat().st_size > maximum or total+source.lstat().st_size > 64*1024**2:
            omitted.append({'name':destination,'reason':'Fixed setup diagnostic byte bound'}); continue
        raw=read(source,maximum,True); total+=len(raw); out=target/destination;out.parent.mkdir(mode=0o755,parents=True,exist_ok=True)
        copied=save(out,raw,0o644);rows.append({'source':identity(source,raw),'copy':copied})
    save(target/'inventory.json',{'kind':'hosted-native-unmeasured-setup-export-1','run':args.run,'attempt':args.attempt,'head':args.head,'setupSuccessful':successful,'setupOwnedProcessGroupsAbsent':True,'cleanupScope':'Setup observes and drains each original child process group; it does not establish the sealed producer descendant/namespace policy or prove absence of separately created sessions. Setup is unmeasured and grants no physical qualification.','setupMeasured':False,'qualification':False,'payloadFilesCopied':False,'originalsChanged':False,'maximumBytes':64*1024**2,'regularBytes':total,'files':rows,'omitted':omitted},0o644)
    # Publishing this parent authorizes the upload action to read every member.
    # Refuse collision leftovers and any extra member before emitting that path.
    require_directory_members(parent, {'setup'})
    names = [Path(row['copy']['path']).relative_to(target).parts for row in rows]
    require_directory_members(target, {'inventory.json', *[parts[0] for parts in names]})
    if any(parts[0] == 'commands' for parts in names):
        require_directory_members(target/'commands', {parts[1] for parts in names if parts[0] == 'commands'})
    return str(parent)

def choose_export_phase(attempted, records):
    require(attempted in PHASES, 'Fixed attempted phase required'); selected = None
    for phase in PHASES[:PHASES.index(attempted)+1]:
        record = records.get(phase)
        if record is None:
            require(phase == attempted, 'Missing closed predecessor'); break
        require(record.get('kind') == 'hosted-native-phase-finalization-1' and record.get('phase') == phase and record.get('timingLockReleased') is True, 'Unclosed attempted phase cannot be exported')
        require(record.get('effectiveOutcome') in ('PASS','FAIL','INCONCLUSIVE'), 'Unknown finalized phase outcome')
        if phase != attempted: require(record['effectiveOutcome'] == 'PASS', 'Unsuccessful predecessor cannot precede attempted phase')
        selected = phase
    require(selected is not None, 'No closed phase exists for export'); return selected

def export_phase(args):
    require(os.getuid() == os.geteuid() == 0, 'Root-only export selection required')
    raw = read(args.config, 4*1024**2, True); require(hashlib.sha256(raw).hexdigest() == args.grant, 'Immutable config grant differs'); config = json.loads(raw)
    require(config.get('kind') == 'hosted-native-controller-config-1', 'Config kind differs')
    allocation = json.loads(read(config['evidenceAllocation']['path'], 16384, True)); require(identity(config['evidenceAllocation']['path']) == config['evidenceAllocation'], 'Evidence allocation differs')
    require(allocation['kind'] == 'evidence-volume-allocation-1' and allocation['purpose'] == 'qualification-evidence-only' and allocation['capacityBytes'] == 4*1024**3, 'Original controller allocation required')
    require(re.fullmatch('ie-native-[0-9a-f]{32}', config['runId']), 'Run identity differs'); root = Path(allocation['root'])/config['runId']; records = {}
    for phase in PHASES[:PHASES.index(args.attempted)+1]:
        directory = root/phase
        try: info = directory.lstat()
        except FileNotFoundError: records[phase] = None; continue
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700 and directory.resolve(strict=True) == directory, 'Existing phase directory must be private and canonical')
        final = json.loads(read(directory/'finalization.json', 4*1024**2, True)); require(final['config']['sha256'] == args.grant, 'Closed phase config differs'); records[phase] = final
    print(choose_export_phase(args.attempted, records))

def main():
    require(sys.flags.isolated and sys.flags.no_site and sys.dont_write_bytecode and not sys.flags.optimize, 'Use Python -I -S -B')
    os.umask(0o022)
    parser = argparse.ArgumentParser(); sub = parser.add_subparsers(dest='mode', required=True)
    p = sub.add_parser('setup'); p.add_argument('--checkout', required=True); p.add_argument('--run', required=True, type=int); p.add_argument('--attempt', required=True, type=int); p.add_argument('--head', required=True); p.add_argument('--source-sha256', required=True)
    p = sub.add_parser('export-phase'); p.add_argument('--config', required=True); p.add_argument('--grant', required=True); p.add_argument('--attempted', required=True, choices=PHASES)
    args = parser.parse_args()
    if args.mode != 'setup': return export_phase(args)
    try: outputs = setup(args)
    except BaseException:
        parent = retain_setup_diagnostics(args,False)
        print('safe_export_parent='+parent)
        raise
    outputs['safe_export_parent'] = retain_setup_diagnostics(args,True)
    # Fixed root-owned paths and hashes only; no credentials or command output.
    for key,value in outputs.items(): print(key+'='+value)

if __name__ == '__main__':
    try: main()
    except Exception as error: sys.stderr.write(type(error).__name__+': '+str(error)[:1024]+'\n'); sys.exit(1)
