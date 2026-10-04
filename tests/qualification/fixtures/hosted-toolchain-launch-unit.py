"""Pure launch admission controls; no root, cgroup, process or network action."""
import hashlib
import importlib.util
import json
import os
import stat
from types import SimpleNamespace
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import sys

spec=importlib.util.spec_from_file_location('reviewed_toolchain_launch',sys.argv[1])
subject=importlib.util.module_from_spec(spec);spec.loader.exec_module(subject)

class Controls(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve()
        self.config={'kind':'hosted-native-controller-config-1','runId':'ie-native-'+'a'*32,'controlRoot':str(self.root),'owner':{'uid':20000,'gid':20000,'groups':[]},'tools':{'python':{'path':'/usr/bin/python3'},'setpriv':{'path':'/usr/bin/setpriv'}}}
        self.group=self.root/('ideogram-toolchain-'+'a'*32+'-'+'b'*32)
    def plan(self):return subject.plan(self.config,self.root/'config.json','c'*64,self.group,3,7)
    def test_exact_original_privilege_drop_and_toolchain_only(self):
        executable,args=self.plan();self.assertEqual(executable,'/usr/bin/setpriv')
        self.assertEqual(args[:7],['--reuid=20000','--regid=20000','--clear-groups','--inh-caps=-all','--ambient-caps=-all','--bounding-set=-all','--no-new-privs'])
        self.assertEqual(args[7:12],['--','/usr/bin/python3','-I','-S','-B']);self.assertEqual(args[-2:],['--action','toolchain']);self.assertNotIn('unshare',args)
    def test_owner_zero_and_groups_refuse(self):
        for field,value in [('uid',0),('gid',0),('uid',True),('groups',[1])]:
            old=self.config['owner'][field];self.config['owner'][field]=value
            with self.assertRaises(ValueError):self.plan()
            self.config['owner'][field]=old
    def test_wrong_run_group_and_identity_refuse(self):
        original=self.group
        for name in ['existing','ideogram-toolchain-'+'d'*32+'-'+'b'*32,original.name+'/child']:
            self.group=self.root/name
            with self.assertRaises(ValueError):self.plan()
        self.group=original
        for dev,ino in [(-1,7),(3,0),(True,7),(3,True)]:
            with self.assertRaises(ValueError):subject.plan(self.config,self.root/'config.json','c'*64,self.group,dev,ino)
    def test_duplicate_or_nonfinite_config_refuses(self):
        for raw in [b'{"a":1,"a":2}',b'{"a":NaN}',b'{"a":Infinity}']:
            with self.assertRaises(ValueError):subject.decode(raw)
    def test_real_read_bound_and_symlink_refusal(self):
        path=self.root/'value';path.write_bytes(b'x'*17)
        self.assertEqual(subject.read(path,17),b'x'*17)
        with self.assertRaises(ValueError):subject.read(path,16)
        link=self.root/'alias';link.symlink_to(path)
        with self.assertRaises(ValueError):subject.read(link,17)
    def test_real_immutable_read_rejects_nonroot_or_writable_ancestry(self):
        path=self.root/'value';path.write_bytes(b'ok')
        with self.assertRaises(ValueError):subject.read(path,2,True)
    def test_privileged_entry_rejects_nonroot_before_read_or_exec(self):
        with patch.object(subject.os,'getuid',return_value=20000),patch.object(subject,'read',side_effect=AssertionError('unexpected read')),patch.object(subject.os,'execve',side_effect=AssertionError('unexpected exec')):
            with self.assertRaises(ValueError):subject.main([])
    def test_actual_main_attaches_and_reports_before_fixed_exec(self):
        class ExecStopped(BaseException):pass
        self.group.mkdir();control=self.group/'cgroup.procs';control.write_bytes(b'');(self.root/'cgroup.procs').write_bytes(b'')
        source=self.root/'tooling/rollback-producer/hosted-toolchain-launch.py';source.parent.mkdir(parents=True);body=Path(sys.argv[1]).read_bytes();source.write_bytes(body)
        self.config['sources']=[{'path':str(source),'bytes':len(body),'sha256':hashlib.sha256(body).hexdigest()}]
        for name in ('python','setpriv'):self.config['tools'][name].update(bytes=1,sha256=hashlib.sha256(b'x').hexdigest())
        raw=json.dumps(self.config).encode();grant=hashlib.sha256(raw).hexdigest();actual_lstat=Path.lstat;events=[]
        def info(path,*args,**kwargs):
            value=actual_lstat(path,*args,**kwargs)
            return SimpleNamespace(st_uid=0,st_mode=value.st_mode&~0o022,st_dev=value.st_dev,st_ino=value.st_ino)
        group_info=actual_lstat(self.group)
        def read(path,maximum,immutable=False):
            path=str(path)
            if path==str(self.root/'config.json'):return raw
            if path==str(source):return body
            if path in ('/usr/bin/python3','/usr/bin/setpriv'):return b'x'
            if path=='/proc/self/cgroup':return ('0::/'+(self.group.name if control.read_bytes() else '')+'\n').encode()
            if path=='/proc/self/mountinfo':return ('1 0 0:1 / '+str(self.root)+' rw - cgroup2 cgroup rw\n').encode()
            if path==str(control):events.append('attached-readback');return control.read_bytes()
            if path=='/proc/self/stat':return b'1 (stub) S 2 0 1 '+b'0 '*15+b'1234\n'
            raise AssertionError('unexpected read')
        class Output:
            def write(self,value):events.append(('ready',json.loads(value)))
            def flush(self):events.append('ready-flush')
        def execute(binary,args,env):
            events.append(('exec',binary,args));raise ExecStopped()
        with patch.object(subject.sys,'platform','linux'),patch.object(subject.os,'getuid',return_value=0),patch.object(subject.os,'geteuid',return_value=0),patch.object(subject,'__file__',str(source)),patch.object(subject,'read',side_effect=read),patch.object(Path,'lstat',info),patch.object(subject.sys,'stdout',Output()),patch.object(subject.os,'execve',side_effect=execute):
            with self.assertRaises(ExecStopped):subject.main(['--config',str(self.root/'config.json'),'--grant',grant,'--group',str(self.group),'--group-dev',str(group_info.st_dev),'--group-ino',str(group_info.st_ino)])
        self.assertEqual(events[0],'attached-readback');self.assertEqual(events[1][0],'ready');self.assertTrue(events[1][1]['attached']);self.assertEqual(events[2],'ready-flush');self.assertEqual(events[3][0],'exec')
        self.assertEqual(events[3][1],'/usr/bin/setpriv');self.assertEqual(events[3][2][-2:],['--action','toolchain']);self.assertEqual(control.read_text(),str(os.getpid())+'\n')

    def test_visible_hierarchy_rejects_subtree_mounts_alternate_mounts_and_aliases(self):
        mount='1 0 0:1 / '+str(self.root)+' rw - cgroup2 cgroup rw\n'
        value=subject.hierarchy('0::/job/sub\n',mount)
        self.assertEqual(value['ancestors'],[self.root/'job/sub',self.root/'job',self.root])
        for membership,raw in [('0::/job/sub\n',mount.replace('0:1 / ','0:1 /job ')),('0::/job/sub\n',mount+'2 0 0:1 /other /else rw - cgroup2 cgroup rw\n'),('0::/job/../sub\n',mount),('0::/job//sub\n',mount)]:
            with self.assertRaises(ValueError):subject.hierarchy(membership,raw)

    def test_nested_parent_does_not_hide_writable_higher_cgroup_control(self):
        lower=self.root/'job';lower.mkdir();upper_control=self.root/'cgroup.procs';upper_control.write_bytes(b'');lower_control=lower/'cgroup.procs';lower_control.write_bytes(b'')
        upper_control.chmod(0o600);lower_control.chmod(0o600)
        layout=subject.hierarchy('0::/job\n','1 0 0:1 / '+str(self.root)+' rw - cgroup2 cgroup rw\n')
        actual=Path.lstat
        def root_owned(path,*args,**kwargs):
            value=actual(path,*args,**kwargs);return SimpleNamespace(st_uid=0,st_mode=value.st_mode)
        with patch.object(Path,'lstat',root_owned):
            subject.authenticate_hierarchy(layout)
            upper_control.chmod(0o622)
            with self.assertRaisesRegex(ValueError,'^LAUNCH_ANCESTOR_CONTROL$'):subject.authenticate_hierarchy(layout)
        self.assertEqual(stat.S_IMODE(upper_control.stat().st_mode),0o622)


suite=unittest.defaultTestLoader.loadTestsFromTestCase(Controls)
result=unittest.TextTestRunner(stream=sys.stderr,verbosity=1).run(suite)
print(json.dumps({'tests':result.testsRun,'failures':len(result.failures),'errors':len(result.errors)}))
raise SystemExit(0 if result.wasSuccessful() else 1)
