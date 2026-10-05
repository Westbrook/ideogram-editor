#!/usr/bin/env python3
"""Read-only, fail-closed evidence for one local toolchain writer cgroup.

Run in a distinct nonroot observer container sharing the writer PID namespace,
with the host cgroup namespace, a read-only whole cgroup2 mount, no capabilities,
no group authority beyond its fixed primary GID and no-new-privileges. The
supplementary list must be empty or contain that primary GID exactly once;
the raw list remains evidence. The controller independently
authenticates exact Docker CIDs, namespace settings, source and image pins. This
worker never controls Docker, writes cgroup files, signals, or scans a volume.
Nested cgroups are deliberately unsupported and refused. An observation is not
a capability grant; its caller owns the complete one-second scheduling deadline.
"""
import argparse
import json
import os
import posixpath
import re
import stat
import sys
import time

MAX_MEMBERS = 256
MAX_ANCESTORS = 128
MAX_ENTRIES = 4096
MAX_READ = 262144
MAX_TOTAL_READ = 8 * 1024 * 1024
MAX_SECONDS = 0.5
CREDENTIAL_POLICY = 'local-primary-group-authority-1'


class Refusal(Exception):
    def __init__(self, code, credential_refusal=None):
        super().__init__(code)
        self.credential_refusal = credential_refusal


def require(condition, code):
    if not condition:
        raise Refusal(code)


def canonical(value):
    return (isinstance(value, str) and 0 < len(value) <= 4096
            and value.startswith('/') and not value.startswith('//')
            and not re.search(r'[\x00-\x20\x7f\\]', value)
            and posixpath.normpath(value) == value)


def membership(raw):
    rows = raw.rstrip('\n').split('\n')
    require(len(rows) == 1 and rows[0].startswith('0::'), 'KERNEL_UNIFIED_REQUIRED')
    path = rows[0][3:]
    require(canonical(path), 'KERNEL_MEMBERSHIP_PATH')
    return path


def hierarchy(raw):
    mounts = []
    for row in raw.rstrip('\n').split('\n'):
        fields = row.split(' ')
        if '-' not in fields:
            raise Refusal('KERNEL_MOUNT_SHAPE')
        sep = fields.index('-')
        require(sep >= 6 and len(fields) == sep + 4, 'KERNEL_MOUNT_SHAPE')
        if fields[sep + 1] != 'cgroup2':
            continue
        require(sep >= 6 and len(fields) == sep + 4
                and fields[0].isdigit() and int(fields[0]) > 0
                and canonical(fields[3]) and canonical(fields[4]), 'KERNEL_MOUNT_SHAPE')
        require(fields[3] == '/', 'KERNEL_HIDDEN_ANCESTRY')
        options = fields[5].split(',')
        require(options.count('ro') == 1 and 'rw' not in options, 'KERNEL_WRITABLE_MOUNT')
        mounts.append({'path': fields[4], 'mountId': int(fields[0])})
    require(len(mounts) == 1, 'KERNEL_MOUNT_AMBIGUOUS')
    return mounts[0]


def event_values(raw):
    values = {}
    for row in raw.rstrip('\n').split('\n'):
        fields = row.split(' ')
        require(len(fields) == 2 and fields[0] in ('populated', 'frozen')
                and fields[0] not in values and fields[1] in ('0', '1'), 'KERNEL_EVENTS')
        values[fields[0]] = int(fields[1])
    require(set(values) == {'populated', 'frozen'}, 'KERNEL_EVENTS')
    return values


def member_values(raw):
    values = raw.split()
    require(len(values) <= MAX_MEMBERS, 'KERNEL_MEMBER_BOUND')
    require(all(re.fullmatch(r'[1-9][0-9]{0,9}', v) and int(v) <= 2147483647 for v in values),
            'KERNEL_MEMBER_PID')
    result = sorted(int(v) for v in values)
    require(len(set(result)) == len(result), 'KERNEL_DUPLICATE_MEMBER')
    return result


def process_fields(pid, status, raw_stat, raw_cgroup):
    names = ('Uid', 'Gid', 'Groups', 'CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb', 'NoNewPrivs')
    fields = {}
    for name in names:
        rows = [row[len(name) + 1:].strip() for row in status.splitlines() if row.startswith(name + ':')]
        require(len(rows) == 1, 'KERNEL_STATUS')
        fields[name] = rows[0]
    require(raw_stat.startswith(str(pid) + ' (') and ') ' in raw_stat, 'KERNEL_STAT')
    tail = raw_stat[raw_stat.rfind(') ') + 2:].split()
    require(len(tail) >= 20 and re.fullmatch(r'[0-9]{1,20}', tail[19]) is not None
            and re.fullmatch(r'[0-9]{1,10}', tail[1]) is not None, 'KERNEL_STAT')

    def numbers(value):
        parts = value.split()
        require(len(parts) <= 64 and all(re.fullmatch(r'[0-9]{1,10}', p) and int(p) < 2**32 for p in parts),
                'KERNEL_CREDENTIAL')
        return [int(p) for p in parts]

    capabilities = []
    for name in names[3:8]:
        require(re.fullmatch(r'[0-9a-fA-F]{1,16}', fields[name]) is not None, 'KERNEL_CAPABILITY')
        capabilities.append(str(int(fields[name], 16)))
    return {'pid': pid, 'startTime': tail[19], 'parent': int(tail[1]),
            'uids': numbers(fields['Uid']), 'gids': numbers(fields['Gid']),
            'groups': numbers(fields['Groups']), 'capabilities': capabilities,
            'noNewPrivs': fields['NoNewPrivs'], 'cgroupPath': membership(raw_cgroup)}


def credentials(row, uid, gid, role='member'):
    expected = {'uids': [uid] * 4, 'gids': [gid] * 4, 'groups': {'oneOf': [[], [gid]]},
                'capabilities': ['0'] * 5, 'noNewPrivs': '1'}
    mismatches = [key for key, value in expected.items()
                  if (row[key] not in ([], [gid]) if key == 'groups' else row[key] != value)]
    # Local policy successor: the already held primary GID may be represented
    # once in the supplementary list. Never erase or canonicalize the raw list.
    # Diagnostics contain only bounded parsed fields, not raw /proc text.
    if uid <= 0 or gid <= 0 or mismatches:
        actual = {key: list(row[key]) for key in ('uids', 'gids', 'groups', 'capabilities')}
        actual['noNewPrivs'] = row['noNewPrivs'] if row['noNewPrivs'] in ('', '0', '1') else 'invalid'
        raise Refusal('KERNEL_PRIVILEGES', {'role': role, 'pid': row['pid'],
                      'expected': expected, 'actual': actual, 'mismatches': mismatches,
                      'expectedOwnerNonroot': uid > 0 and gid > 0})


def failure_result(error):
    code = str(error) if isinstance(error, Refusal) else 'KERNEL_READ_UNAVAILABLE'
    result = {'kind': 'local-cgroup-observation-1', 'credentialPolicy': CREDENTIAL_POLICY,
              'status': 'FAIL', 'code': code}
    if isinstance(error, Refusal) and error.credential_refusal is not None:
        result['credentialRefusal'] = error.credential_refusal
    return result


def identity_fields(value, directory=False):
    require((stat.S_ISDIR(value.st_mode) if directory else stat.S_ISREG(value.st_mode))
            and value.st_uid == 0 and not value.st_mode & 0o022, 'KERNEL_CONTROL_OWNER')
    return {'dev': value.st_dev, 'ino': value.st_ino, 'uid': value.st_uid,
            'gid': value.st_gid, 'mode': value.st_mode}


class KernelView:
    def __init__(self):
        self.started = time.monotonic()
        self.total = 0

    def check(self):
        require(time.monotonic() - self.started <= MAX_SECONDS, 'KERNEL_DEADLINE')

    def text(self, path):
        self.check()
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
        try:
            require(stat.S_ISREG(os.fstat(fd).st_mode), 'KERNEL_FILE_TYPE')
            chunks = []
            count = 0
            while True:
                self.check()
                chunk = os.read(fd, min(16384, MAX_READ + 1 - count))
                if not chunk:
                    break
                count += len(chunk)
                self.total += len(chunk)
                require(count <= MAX_READ and self.total <= MAX_TOTAL_READ, 'KERNEL_READ_BOUND')
                chunks.append(chunk)
            return b''.join(chunks).decode('ascii')
        finally:
            os.close(fd)

    def info(self, path, directory=False):
        self.check()
        require(os.path.realpath(path) == path, 'KERNEL_CANONICAL')
        return identity_fields(os.lstat(path), directory)

    def no_children(self, path):
        self.check()
        with os.scandir(path) as entries:
            for count, entry in enumerate(entries, 1):
                require(count <= MAX_ENTRIES, 'KERNEL_ENTRY_BOUND')
                require(not entry.is_symlink() and not entry.is_dir(follow_symlinks=False),
                        'KERNEL_DESCENDANT_CGROUP')


def process(view, pid):
    prefix = '/proc/' + str(pid)
    return process_fields(pid, view.text(prefix + '/status'), view.text(prefix + '/stat'),
                          view.text(prefix + '/cgroup'))


def inside(path, parent):
    return path == parent or path.startswith(parent.rstrip('/') + '/')


def authenticate(view, mount, group_path):
    path = mount['path'].rstrip('/') + group_path
    require(group_path != '/' and canonical(path), 'KERNEL_ROOT_WRITER')
    rows = []
    current = path
    while True:
        require(len(rows) < MAX_ANCESTORS and inside(current, mount['path']), 'KERNEL_ANCESTOR_BOUND')
        rows.append({'path': current, 'directory': view.info(current, True),
                     'controls': {name: view.info(current + '/' + name)
                                  for name in ('cgroup.procs', 'cgroup.threads')}})
        if current == mount['path']:
            break
        current = posixpath.dirname(current)
    controls = {name: view.info(path + '/' + name) for name in ('cgroup.freeze', 'cgroup.events', 'cgroup.type')}
    rows[0]['controls'].update(controls)
    require(view.text(path + '/cgroup.type').strip() == 'domain', 'KERNEL_DOMAIN_REQUIRED')
    view.no_children(path)
    return path, rows


def observe(view, writer_uid, writer_gid, observer_uid, observer_gid, expected, self_pid=None):
    require(writer_uid != observer_uid and min(writer_uid, writer_gid, observer_uid, observer_gid) > 0,
            'KERNEL_DISTINCT_OWNER')
    require(expected in (0, 1), 'KERNEL_EXPECTED_STATE')
    self_pid = os.getpid() if self_pid is None else self_pid
    observer = process(view, self_pid)
    credentials(observer, observer_uid, observer_gid, 'observer')
    mount_raw = view.text('/proc/' + str(self_pid) + '/mountinfo')
    mount = hierarchy(mount_raw)
    writer = process(view, 1)
    credentials(writer, writer_uid, writer_gid, 'writer')
    group_path = writer['cgroupPath']
    require(not inside(observer['cgroupPath'], group_path), 'KERNEL_OBSERVER_OVERLAP')
    path, ancestry = authenticate(view, mount, group_path)
    observer_path = mount['path'].rstrip('/') + observer['cgroupPath']
    observer_group = view.info(observer_path, True)
    events = event_values(view.text(path + '/cgroup.events'))
    require(events == {'populated': 1, 'frozen': expected}, 'KERNEL_FREEZE_STATE')
    pids = member_values(view.text(path + '/cgroup.procs'))
    require(1 in pids and self_pid not in pids, 'KERNEL_WRITER_MEMBERSHIP')
    members = []
    for pid in pids:
        row = process(view, pid)
        credentials(row, writer_uid, writer_gid)
        require(row['cgroupPath'] == group_path, 'KERNEL_FOREIGN_MEMBER')
        members.append(row)
    require(next(row for row in members if row['pid'] == 1) == writer, 'KERNEL_INIT_DRIFT')
    # Re-read each identity and the complete directory/membership/control closure.
    # Refusal on churn is deliberate even for the pre-pause or thaw snapshots.
    for row in members:
        require(process(view, row['pid']) == row, 'KERNEL_PROCESS_DRIFT')
    require(member_values(view.text(path + '/cgroup.procs')) == pids, 'KERNEL_MEMBERSHIP_DRIFT')
    require(authenticate(view, mount, group_path) == (path, ancestry), 'KERNEL_ANCESTRY_DRIFT')
    require(view.text('/proc/' + str(self_pid) + '/mountinfo') == mount_raw, 'KERNEL_MOUNT_DRIFT')
    require(process(view, self_pid) == observer and view.info(observer_path, True) == observer_group,
            'KERNEL_OBSERVER_DRIFT')
    require(event_values(view.text(path + '/cgroup.events')) == events, 'KERNEL_FREEZE_DRIFT')
    view.check()
    return {'kind': 'local-cgroup-observation-1', 'credentialPolicy': CREDENTIAL_POLICY,
            'status': 'PASS', 'frozen': expected,
            'binding': {'writer': {'pid': 1, 'startTime': writer['startTime']},
                        'cgroup': {'path': group_path, 'dev': ancestry[0]['directory']['dev'],
                                   'ino': ancestry[0]['directory']['ino'], 'mountId': mount['mountId']},
                        'ancestry': ancestry,
                        'observerCgroup': {'path': observer['cgroupPath'], 'dev': observer_group['dev'],
                                           'ino': observer_group['ino']}},
            'members': members, 'observer': observer}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('writer-uid', 'writer-gid', 'observer-uid', 'observer-gid'):
        parser.add_argument('--' + name, required=True, type=int)
    parser.add_argument('--expect-frozen', required=True, type=int, choices=(0, 1))
    args = parser.parse_args()
    try:
        require(sys.platform == 'linux', 'KERNEL_LINUX_REQUIRED')
        result = observe(KernelView(), args.writer_uid, args.writer_gid, args.observer_uid,
                         args.observer_gid, args.expect_frozen)
    except (Refusal, OSError, UnicodeError) as error:
        print(json.dumps(failure_result(error), separators=(',', ':')))
        return 1
    print(json.dumps(result, separators=(',', ':')))
    return 0


if __name__ == '__main__':
    sys.exit(main())
