#!/usr/bin/env python3
"""Pure boundary controls. No cgroup/process experiment is run by this fixture."""
import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('probe_boundary',sys.argv[1]);probe=importlib.util.module_from_spec(spec);spec.loader.exec_module(probe)
MOUNT='41 24 0:37 / /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime - cgroup2 cgroup rw\n'
class Boundaries(unittest.TestCase):
    def test_unified_route(self):self.assertEqual(probe.locate_cgroup('0::/job\n',MOUNT),'/sys/fs/cgroup/job')
    def test_v1_refused(self):
        with self.assertRaises(probe.Refusal):probe.locate_cgroup('2:cpu:/job\n',MOUNT)
    def test_readonly_refused(self):
        with self.assertRaises(probe.Refusal):probe.locate_cgroup('0::/job\n',MOUNT.replace('rw,nosuid','ro,nosuid'))
    def test_ambiguous_mount_refused(self):
        with self.assertRaises(probe.Refusal):probe.locate_cgroup('0::/job\n',MOUNT+MOUNT)
    def test_path_escape_refused(self):
        for path in ['0::/../job\n','0::/job//other\n','0:://job\n','0::/job\\040other\n']:
            with self.subTest(path=path),self.assertRaises(probe.Refusal):probe.locate_cgroup(path,MOUNT)
    def test_mount_root_prefix_bound(self):
        mount=MOUNT.replace(' / /sys/',' /job /sys/')
        self.assertEqual(probe.locate_cgroup('0::/job/child\n',mount),'/sys/fs/cgroup/child')
        with self.assertRaises(probe.Refusal):probe.locate_cgroup('0::/job-other\n',mount)
    def test_event_shape(self):
        self.assertEqual(probe.event_values('populated 1\nfrozen 0\n'),{'populated':1,'frozen':0})
        for raw in ['populated 1\n','populated 1\nfrozen 2\n','populated 1\nfrozen 1\nfrozen 0\n']:
            with self.subTest(raw=raw),self.assertRaises(probe.Refusal):probe.event_values(raw)
    def test_capability_identity(self):
        good={'uids':[20000]*4,'gids':[20000]*4,'groups':[],'capabilities':{k:0 for k in ('CapInh','CapPrm','CapEff','CapBnd','CapAmb')},'noNewPrivs':1}
        self.assertEqual(probe.owned_identity(good),good)
        for change in [{'uids':[0]*4},{'groups':[0]},{'capabilities':{'CapBnd':1}},{'noNewPrivs':0}]:
            with self.subTest(change=change),self.assertRaises(probe.Refusal):probe.owned_identity({**good,**change})
    def test_name_collision_never_reused(self):
        with patch.object(probe,'immutable_directory'),patch.object(probe.os,'mkdir',side_effect=FileExistsError),patch.object(probe.os,'open') as opened:
            with self.assertRaises(FileExistsError):probe.PrivateGroup('/fixed','ideogram-probe-1-1-'+'a'*32)
            opened.assert_not_called()
    def test_bounded_read_rejects_overflow(self):
        with tempfile.TemporaryDirectory() as directory:
            p=Path(directory)/'data';p.write_bytes(b'abcd')
            self.assertEqual(probe.read_bytes(p,4),b'abcd')
            with self.assertRaises(probe.Refusal):probe.read_bytes(p,3)
    def test_registration_requires_real_denial(self):
        for value in [0,True,999]:
            read,write=os.pipe()
            try:
                os.write(write,probe.encoded({'type':'ready','role':'writer','pid':123,'escapeErrno':value}));os.close(write);write=None
                with self.assertRaises(probe.Refusal):probe.Progress(read).drain()
            finally:
                os.close(read)
                if write is not None:os.close(write)
    def test_control_write_allowlist(self):
        group=object.__new__(probe.PrivateGroup)
        for name,value in [('cgroup.subtree_control','+memory'),('memory.max','0'),('cgroup.procs',True),('cgroup.procs',0),('cgroup.freeze','2'),('cgroup.kill','0')]:
            with self.subTest(name=name,value=value),self.assertRaises(probe.Refusal):group.write(name,value)
    def test_tick_before_registration_refused(self):
        read,write=os.pipe()
        try:
            os.write(write,probe.encoded({'type':'tick','role':'writer'}));os.close(write);write=None
            with self.assertRaises(probe.Refusal):probe.Progress(read).drain()
        finally:
            os.close(read)
            if write is not None:os.close(write)
    def test_duplicate_registration_refused(self):
        read,write=os.pipe()
        try:
            row=probe.encoded({'type':'ready','role':'writer','pid':123,'escapeErrno':13});os.write(write,row+row);os.close(write);write=None
            with self.assertRaises(probe.Refusal):probe.Progress(read).drain()
        finally:
            os.close(read)
            if write is not None:os.close(write)
    def test_initialization_cleanup_failure_not_hidden(self):
        original=probe.Refusal('PRIVATE_CONTROL_OWNER')
        stamp=type('Stamp',(),{'st_uid':0,'st_mode':0o40755})()
        with patch.object(probe,'immutable_directory'),patch.object(probe.os,'mkdir'),patch.object(probe.os,'open',return_value=123),patch.object(probe.os,'fstat',return_value=stamp),patch.object(probe.os,'stat',side_effect=original),patch.object(probe.os,'rmdir',side_effect=OSError(16,'busy')):
            with self.assertRaises(probe.Refusal) as found:probe.PrivateGroup('/fixed','ideogram-probe-1-1-'+'a'*32)
        self.assertIs(found.exception,original);self.assertTrue(found.exception.probe_group.created);self.assertEqual(found.exception.probe_cleanup_errno,16)

    def test_actual_process_status_empty_groups_stays_on_its_line(self):
        status=(b'Name:\twriter\xff\nUid:\t20000\t20000\t20000\t20000\nGid:\t20000\t20000\t20000\t20000\nGroups:\t\nNStgid:\t123\nCapInh:\t00000000\nCapPrm:\t00000000\nCapEff:\t00000000\nCapBnd:\t00000000\nCapAmb:\t00000000\nNoNewPrivs:\t1\n')
        tail=['S','42','123','123']+['0']*15+['9876']
        process_stat=b'123 (writer\xff)inner) '+(' '.join(tail)).encode()
        with patch.object(probe,'read_bytes',side_effect=[status,process_stat]):
            value=probe.owned_identity(probe.process_status(123))
        self.assertEqual(value['groups'],[]);self.assertEqual(value['parent'],42);self.assertEqual(value['start'],'9876')
    def test_process_enumeration_stops_before_excess_status_read(self):
        class Entries:
            consumed=0;closed=False
            def __enter__(self):return self
            def __exit__(self,*args):self.closed=True
            def __iter__(self):
                for i in range(1,5000):
                    self.consumed+=1;yield type('Entry',(),{'name':str(i)})()
        entries=Entries()
        with patch.object(probe.os,'scandir',return_value=entries),patch.object(probe,'process_status',return_value=None) as read:
            with self.assertRaises(probe.Refusal) as error:probe.uid_processes()
        self.assertEqual(error.exception.code,'PROCESS_CENSUS_BOUND');self.assertEqual(read.call_count,4096);self.assertEqual(entries.consumed,4097);self.assertTrue(entries.closed)

    def test_failure_cannot_be_promoted_by_clean_teardown(self):
        # Root refusal occurs before any filesystem/process operation; no probe is
        # executed, and a mocked successful census cannot turn it into capability.
        with patch.object(probe.os,'getuid',return_value=1000),patch.object(probe,'uid_processes',return_value=set()):
            result=probe.experiment(b'fixture',Path('/never-created'),1,1,'a'*40)
        self.assertEqual(result['status'],'UNAVAILABLE');self.assertEqual(result['failure']['code'],'ROOT_LINUX_ONLY');self.assertTrue(result['cleanup']['complete']);self.assertFalse(result['qualification'])

if __name__=='__main__':
    suite=unittest.defaultTestLoader.loadTestsFromTestCase(Boundaries);stream=io.StringIO();result=unittest.TextTestRunner(stream=stream,verbosity=2).run(suite)
    print(json.dumps({'tests':result.testsRun,'failures':len(result.failures),'errors':len(result.errors)}));sys.stderr.write(stream.getvalue());sys.exit(0 if result.wasSuccessful() else 1)
