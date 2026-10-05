#!/usr/bin/env python3
"""Synthetic kernel files only: no Docker, cgroup controls, or live /proc reads."""
import copy
import hashlib
import importlib.util
import json
import sys
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('observer', sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
group = sys.argv[2]
count = 0


def check(value):
    global count
    assert value
    count += 1


def refuses(call, expected):
    global count
    try:
        call()
    except m.Refusal as error:
        assert str(error) == expected, (str(error), expected)
        count += 1
        return
    raise AssertionError('accepted ' + expected)


MOUNT = '32 21 0:28 / /sys/fs/cgroup ro,nosuid,nodev,noexec,relatime - cgroup2 cgroup rw\n'


def proc(pid, uid, gid, path, start='456'):
    status = '\n'.join(['Uid:\t' + ' '.join([str(uid)] * 4),
                        'Gid:\t' + ' '.join([str(gid)] * 4), 'Groups:\t',
                        *[n + ':\t0000000000000000' for n in ('CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb')],
                        'NoNewPrivs:\t1']) + '\n'
    raw_stat = str(pid) + ' (name with ) close) S ' + ' '.join(['0'] * 18 + [start]) + '\n'
    return status, raw_stat, '0::' + path + '\n'


class View:
    def __init__(self):
        self.files = {'/proc/90/mountinfo': MOUNT,
                      '/sys/fs/cgroup/writer/cgroup.type': 'domain\n',
                      '/sys/fs/cgroup/writer/cgroup.events': 'populated 1\nfrozen 1\n',
                      '/sys/fs/cgroup/writer/cgroup.procs': '1\n23\n'}
        for pid, uid, gid, path in [(1, 1000, 1100, '/writer'), (23, 1000, 1100, '/writer'),
                                    (90, 2000, 2200, '/observer')]:
            for name, value in zip(('status', 'stat', 'cgroup'), proc(pid, uid, gid, path)):
                self.files['/proc/' + str(pid) + '/' + name] = value
        self.reads = {}
        self.info_reads = {}
        self.mutation = None
        self.child = False
        self.children_calls = 0
        self.bad_owner = False

    def check(self):
        pass

    def text(self, path):
        self.reads[path] = self.reads.get(path, 0) + 1
        if self.mutation:
            value = self.mutation(path, self.reads[path])
            if value is not None:
                return value
        return self.files[path]

    def info(self, path, directory=False):
        self.info_reads[path] = self.info_reads.get(path, 0) + 1
        if self.bad_owner:
            raise m.Refusal('KERNEL_CONTROL_OWNER')
        ino = int(hashlib.sha256(path.encode()).hexdigest()[:8], 16)
        return {'dev': 1, 'ino': ino, 'uid': 0, 'gid': 0, 'mode': 0o40755 if directory else 0o100644}

    def no_children(self, path):
        self.children_calls += 1
        if self.child:
            raise m.Refusal('KERNEL_DESCENDANT_CGROUP')


def observe(view=None, expected=1, **kwargs):
    args = dict(writer_uid=1000, writer_gid=1100, observer_uid=2000, observer_gid=2200,
                expected=expected, self_pid=90)
    args.update(kwargs)
    return m.observe(view or View(), **args)


if group == 'parsers':
    check(m.hierarchy(MOUNT) == {'path': '/sys/fs/cgroup', 'mountId': 32})
    check(m.membership('0::/writer\n') == '/writer')
    check(m.member_values('23\n1\n') == [1, 23])
    check(m.event_values('frozen 1\npopulated 1\n') == {'frozen': 1, 'populated': 1})
    refuses(lambda: m.hierarchy(MOUNT + MOUNT), 'KERNEL_MOUNT_AMBIGUOUS')
    refuses(lambda: m.hierarchy(MOUNT.replace('0:28 / ', '0:28 /hidden ')), 'KERNEL_HIDDEN_ANCESTRY')
    refuses(lambda: m.hierarchy(MOUNT.replace('ro,nosuid', 'rw,nosuid')), 'KERNEL_WRITABLE_MOUNT')
    refuses(lambda: m.hierarchy(MOUNT + '33 21 0:28 / /extra ro - cgroup2 cgroup\n'), 'KERNEL_MOUNT_SHAPE')
    refuses(lambda: m.membership('0::/writer\n0::/other\n'), 'KERNEL_UNIFIED_REQUIRED')
    for raw in ('0::/writer/../other\n', '0:://writer\n', '0::/writer\\x\n'):
        refuses(lambda raw=raw: m.membership(raw), 'KERNEL_MEMBERSHIP_PATH')
    refuses(lambda: m.member_values('0\n1\n'), 'KERNEL_MEMBER_PID')
    refuses(lambda: m.member_values('1\n1\n'), 'KERNEL_DUPLICATE_MEMBER')
    refuses(lambda: m.event_values('populated 1\nfrozen 1\nfrozen 1\n'), 'KERNEL_EVENTS')
    refuses(lambda: m.event_values('populated 1\n'), 'KERNEL_EVENTS')
elif group == 'credentials':
    row = m.process_fields(1, *proc(1, 1000, 1100, '/writer'))
    check(row['startTime'] == '456' and row['parent'] == 0)
    m.credentials(row, 1000, 1100)
    check(True)
    for field, value in [('uids', [0] * 4), ('gids', [1000] * 4), ('groups', [1000]),
                         ('capabilities', ['0', '0', '1', '0', '0']), ('noNewPrivs', '0')]:
        bad = copy.deepcopy(row)
        bad[field] = value
        refuses(lambda bad=bad: m.credentials(bad, 1000, 1100), 'KERNEL_PRIVILEGES')
    status, raw_stat, cgroup = proc(1, 1000, 1100, '/writer')
    refuses(lambda: m.process_fields(1, status + 'Uid:\t1000\n', raw_stat, cgroup), 'KERNEL_STATUS')
    refuses(lambda: m.process_fields(1, status, raw_stat.replace('1 (', '2 ('), cgroup), 'KERNEL_STAT')
    refuses(lambda: m.process_fields(1, status.replace('CapEff:\t0000000000000000', 'CapEff:\tx'), raw_stat, cgroup),
            'KERNEL_CAPABILITY')
    control = SimpleNamespace(st_mode=0o100644, st_uid=0, st_gid=0, st_dev=1, st_ino=22)
    check(m.identity_fields(control)['ino'] == 22)
    for mode, uid in [(0o100664, 0), (0o100646, 0), (0o100644, 1000), (0o120777, 0), (0o40755, 0)]:
        bad = SimpleNamespace(**vars(control))
        bad.st_mode, bad.st_uid = mode, uid
        refuses(lambda bad=bad: m.identity_fields(bad), 'KERNEL_CONTROL_OWNER')
    directory = SimpleNamespace(**vars(control))
    directory.st_mode = 0o40755
    check(m.identity_fields(directory, True)['mode'] == 0o40755)
elif group == 'observation':
    view = View()
    result = observe(view)
    check(result['frozen'] == 1 and result['status'] == 'PASS')
    check([row['pid'] for row in result['members']] == [1, 23])
    check(result['binding']['writer'] == {'pid': 1, 'startTime': '456'})
    check(view.children_calls == 2 and view.reads['/sys/fs/cgroup/writer/cgroup.procs'] == 2)
    check(result['binding']['observerCgroup']['path'] == '/observer')
    thaw = View()
    thaw.files['/sys/fs/cgroup/writer/cgroup.events'] = 'frozen 0\npopulated 1\n'
    check(observe(thaw, 0)['binding'] == result['binding'])
    refuses(lambda: observe(observer_uid=1000), 'KERNEL_DISTINCT_OWNER')
    overlap = View()
    overlap.files['/proc/90/cgroup'] = '0::/writer/child\n'
    refuses(lambda: observe(overlap), 'KERNEL_OBSERVER_OVERLAP')
    child = View()
    child.child = True
    refuses(lambda: observe(child), 'KERNEL_DESCENDANT_CGROUP')
    domain = View()
    domain.files['/sys/fs/cgroup/writer/cgroup.type'] = 'domain threaded\n'
    refuses(lambda: observe(domain), 'KERNEL_DOMAIN_REQUIRED')
    owner = View()
    owner.bad_owner = True
    refuses(lambda: observe(owner), 'KERNEL_CONTROL_OWNER')
elif group == 'drift':
    for path, occurrence, value, code in [
        ('/proc/23/stat', 2, proc(23, 1000, 1100, '/writer', '999')[1], 'KERNEL_PROCESS_DRIFT'),
        ('/sys/fs/cgroup/writer/cgroup.procs', 2, '1\n', 'KERNEL_MEMBERSHIP_DRIFT'),
        ('/sys/fs/cgroup/writer/cgroup.events', 2, 'frozen 0\npopulated 1\n', 'KERNEL_FREEZE_DRIFT'),
        ('/proc/90/mountinfo', 2, MOUNT.replace('32 ', '33 ', 1), 'KERNEL_MOUNT_DRIFT'),
        ('/proc/90/stat', 2, proc(90, 2000, 2200, '/observer', '999')[1], 'KERNEL_OBSERVER_DRIFT'),
        ('/proc/1/stat', 2, proc(1, 1000, 1100, '/writer', '999')[1], 'KERNEL_INIT_DRIFT'),
    ]:
        view = View()
        view.mutation = lambda p, n, path=path, occurrence=occurrence, value=value: value if p == path and n == occurrence else None
        refuses(lambda view=view: observe(view), code)
    foreign = View()
    foreign.files['/proc/23/cgroup'] = '0::/other\n'
    refuses(lambda: observe(foreign), 'KERNEL_FOREIGN_MEMBER')
elif group == 'diagnostics':
    row = m.process_fields(1, *proc(1, 1000, 1100, '/writer'))
    for field, value in [('uids', [2000] * 4), ('gids', [2200] * 4), ('groups', [1101]),
                         ('capabilities', ['0', '0', '1', '0', '0']), ('noNewPrivs', '0'),
                         ('noNewPrivs', '')]:
        bad = copy.deepcopy(row)
        bad[field] = value
        try:
            m.credentials(bad, 1000, 1100, 'writer')
        except m.Refusal as error:
            result = m.failure_result(error)
            details = result['credentialRefusal']
            check(result['code'] == 'KERNEL_PRIVILEGES' and result['status'] == 'FAIL'
                  and details['mismatches'] == [field] and details['role'] == 'writer'
                  and details['pid'] == 1 and details['actual'][field] == value
                  and details['expectedOwnerNonroot'] is True
                  and details['expected']['groups'] == {'oneOf': [[], [1100]]}
                  and result['credentialPolicy'] == 'local-primary-group-authority-1')
        else:
            raise AssertionError('credential refusal was weakened')
    for role in ('observer', 'writer', 'member'):
        bad = copy.deepcopy(row)
        bad['noNewPrivs'] = 'unbounded raw status must not appear' * 1000
        try:
            m.credentials(bad, 1000, 1100, role)
        except m.Refusal as error:
            result = m.failure_result(error)
            check(result['credentialRefusal']['role'] == role
                  and result['credentialRefusal']['actual']['noNewPrivs'] == 'invalid'
                  and len(json.dumps(result)) < 1024)
        else:
            raise AssertionError('invalid noNewPrivs accepted')
    check(m.failure_result(OSError('/private/path must not escape')) == {
        'kind': 'local-cgroup-observation-1', 'credentialPolicy': 'local-primary-group-authority-1',
        'status': 'FAIL', 'code': 'KERNEL_READ_UNAVAILABLE'})
    check(m.failure_result(m.Refusal('KERNEL_STATUS')) == {
        'kind': 'local-cgroup-observation-1', 'credentialPolicy': 'local-primary-group-authority-1',
        'status': 'FAIL', 'code': 'KERNEL_STATUS'})
    # A missing status label retains the pre-existing parser refusal; an empty
    # present label reaches the credential diagnostic as tested above.
    status, raw_stat, cgroup = proc(1, 1000, 1100, '/writer')
    refuses(lambda: m.process_fields(1, status.replace('NoNewPrivs:\t1\n', ''), raw_stat, cgroup), 'KERNEL_STATUS')
elif group == 'group-authority':
    for groups in ([], [1100]):
        row = m.process_fields(1, *proc(1, 1000, 1100, '/writer'))
        row['groups'] = groups
        before = copy.deepcopy(row)
        m.credentials(row, 1000, 1100)
        check(row == before)
    for groups in ([0], [1101], [1100, 1101], [1100, 1100], [1101, 1100]):
        row = m.process_fields(1, *proc(1, 1000, 1100, '/writer'))
        row['groups'] = groups
        refuses(lambda row=row: m.credentials(row, 1000, 1100), 'KERNEL_PRIVILEGES')
    # A primary entry cannot mask saved or filesystem GID authority drift.
    row = m.process_fields(1, *proc(1, 1000, 1100, '/writer'))
    row['groups'] = [1100]
    row['gids'][3] = 1101
    refuses(lambda: m.credentials(row, 1000, 1100), 'KERNEL_PRIVILEGES')
    view = View()
    for pid, gid in ((1, 1100), (23, 1100), (90, 2200)):
        path = '/proc/' + str(pid) + '/status'
        view.files[path] = view.files[path].replace('Groups:\t\n', 'Groups:\t' + str(gid) + '\n')
    result = observe(view)
    check(result['credentialPolicy'] == 'local-primary-group-authority-1'
          and [r['groups'] for r in result['members']] == [[1100], [1100]]
          and result['observer']['groups'] == [2200])
    # Both forms are admissible individually; a transition within an observed
    # frozen identity snapshot still refuses and must not be normalized away.
    view = View()
    view.mutation = lambda p, n: (view.files[p].replace('Groups:\t\n', 'Groups:\t1100\n')
                                 if p == '/proc/23/status' and n == 2 else None)
    refuses(lambda: observe(view), 'KERNEL_PROCESS_DRIFT')
elif group == 'bounds':
    refuses(lambda: m.member_values('\n'.join(str(n) for n in range(1, m.MAX_MEMBERS + 2))), 'KERNEL_MEMBER_BOUND')
    refuses(lambda: m.member_values('2147483648'), 'KERNEL_MEMBER_PID')
    refuses(lambda: m.membership('0::/' + 'a' * 4096), 'KERNEL_MEMBERSHIP_PATH')
    view = View()
    view.files['/sys/fs/cgroup/writer/cgroup.procs'] = '23\n'
    refuses(lambda: observe(view), 'KERNEL_WRITER_MEMBERSHIP')
    view = View()
    view.files['/sys/fs/cgroup/writer/cgroup.events'] = 'populated 1\nfrozen 0\n'
    refuses(lambda: observe(view), 'KERNEL_FREEZE_STATE')
    refuses(lambda: observe(writer_uid=0), 'KERNEL_DISTINCT_OWNER')
    refuses(lambda: observe(expected=2), 'KERNEL_EXPECTED_STATE')
else:
    raise AssertionError('unknown fixture selection')

print(json.dumps({'status': 'PASS', 'group': group, 'cases': count, 'kernelExecuted': False}))
