"""Pure setup admission and real filesystem refusals; never invokes setup."""
import copy
import ast
import contextlib
import importlib.util
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import stat
import struct
import tempfile
import types
import textwrap
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('hosted_setup_test_subject', sys.argv.pop())
subject = importlib.util.module_from_spec(spec); spec.loader.exec_module(subject)
workflow = (Path(__file__).resolve().parents[3]/'.github/workflows/hosted-native.yml').read_text()
first_step = ast.parse(textwrap.dedent(workflow.split("<<'PY'\n",1)[1].split('\n          PY',1)[0]))
marker_guard = next(node for node in first_step.body if isinstance(node,ast.FunctionDef) and node.name=='require_marker_parent')
marker_namespace = {'json':json,'stat':stat}
# Exercise only the actual guard function, never the marker-writing workflow.
exec(compile(ast.Module(body=[marker_guard],type_ignores=[]),'workflow-marker-guard','exec'),marker_namespace)
require_marker_parent = marker_namespace['require_marker_parent']
def load_host_module(name, path):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
producer_root=Path(subject.__file__).parent
host_diagnostics=load_host_module('hosted_host_diagnostics_subject',producer_root/'hosted-host.py')
sealed_host=load_host_module('unchanged_sealed_elf_parser',producer_root/'schema18/linux_host.py')

def refused_elf(path):
    # A 256-byte inert ELF64 fixture declares a DT_STRSZ one byte over the
    # unchanged parser bound. No compiler, system executable or library runs.
    header=b'\x7fELF\x02\x01\x01'+bytes(9)+struct.pack('<HHIQQQIHHHHHH',3,62,1,0,64,0,0,64,56,2,0,0,0)
    load=struct.pack('<IIQQQQQQ',1,5,0,0,0,256,256,4096)
    dynamic=struct.pack('<IIQQQQQQ',2,6,176,176,176,64,64,8)
    tags=b''.join(struct.pack('<qQ',tag,value) for tag,value in ((5,240),(10,1048577),(1,1),(0,0)))
    path.write_bytes(header+load+dynamic+tags+bytes(16))
    try:sealed_host.read_elf(path,62,page_size=4096)
    except sealed_host.LinuxHostError as error:return error
    raise AssertionError('Unchanged sealed parser must refuse oversized DT_STRSZ')

def fixture_identity(path):
    raw=path.read_bytes();return {'sha256':'sha256:'+hashlib.sha256(raw).hexdigest(),'byteLength':str(len(raw))}
HEAD = 'b'*40
FIRST = subject.utc_ms('2026-10-03T12:00:01Z')

def job_response():
    return {'total_count':1,'jobs':[{'name':'native-prerequisites','run_id':123,'run_attempt':2,'head_sha':HEAD,'status':'in_progress','conclusion':None,'id':999,'started_at':'2026-10-03T12:00:00Z'}]}

def closed(phase, outcome='PASS', released=True):
    return {'kind':'hosted-native-phase-finalization-1','phase':phase,'effectiveOutcome':outcome,'timingLockReleased':released}

class Boundaries(unittest.TestCase):
    def test_host_discovery_uses_only_fixed_gcc11_drivers_and_matching_program_queries(self):
        authenticated=[];commands=[]
        class StopAtParser(RuntimeError):pass
        def command(argv,environment):
            commands.append(argv)
            if argv==['/usr/sbin/ldconfig','-p']:return {'stdout':''}
            if argv in (['/usr/bin/gcc-11','-dumpversion'],['/usr/bin/g++-11','-dumpversion']):return {'stdout':'11\n'}
            self.assertEqual(len(argv),2);self.assertTrue(argv[1].startswith('-print-prog-name='))
            name=argv[1].split('=',1)[1]
            self.assertEqual(argv[0],'/usr/bin/g++-11' if name=='cc1plus' else '/usr/bin/gcc-11')
            return {'stdout':name if name in ('as','ld') else '/usr/lib/gcc/x86_64-linux-gnu/11/'+name}
        def stop(*_):raise StopAtParser()
        host=types.SimpleNamespace(system_file=lambda value:authenticated.append(value),command=command,read_elf=stop)
        with mock.patch.object(Path,'resolve',lambda path,strict:path):
            with self.assertRaises(StopAtParser):host_diagnostics.select(host,{'PATH':'/unselected','HOME':'/private/home','TMPDIR':'/private/tmp'})
        self.assertEqual([row['requestedPath'] for row in authenticated[:5]],['/usr/bin/gcc-11','/usr/bin/g++-11','/usr/bin/make','/usr/bin/python3','/usr/bin/getconf'])
        self.assertEqual(len(commands),8)
        self.assertEqual({name for name in subject.PACKAGES if name.startswith(('gcc-','g++-'))},{'gcc-11','g++-11'})
        self.assertNotIn('/usr/bin/gcc',[argv[0] for argv in commands]);self.assertNotIn('/usr/bin/g++',[argv[0] for argv in commands])

    def test_missing_selected_gcc11_driver_refuses_before_commands_without_default_fallback(self):
        for missing in ('/usr/bin/gcc-11','/usr/bin/g++-11'):
            resolved=[];host=types.SimpleNamespace(system_file=mock.Mock(),command=mock.Mock())
            def resolve(path,strict):
                resolved.append(str(path))
                if str(path)==missing:raise FileNotFoundError('selected driver missing')
                return path
            with mock.patch.object(Path,'resolve',resolve):
                with self.assertRaises(FileNotFoundError):host_diagnostics.select(host,{'PATH':'/usr/bin','HOME':'/private/home','TMPDIR':'/private/tmp'})
            host.system_file.assert_not_called();host.command.assert_not_called()
            self.assertNotIn('/usr/bin/gcc',resolved);self.assertNotIn('/usr/bin/g++',resolved)

    def test_different_driver_major_refuses_before_compiler_program_discovery(self):
        host=types.SimpleNamespace(system_file=mock.Mock(),command=mock.Mock(return_value={'stdout':'12\n'}))
        with mock.patch.object(Path,'resolve',lambda path,strict:path):
            with self.assertRaisesRegex(ValueError,'compiler major differs'):host_diagnostics.select(host,{'PATH':'/usr/bin','HOME':'/private/home','TMPDIR':'/private/tmp'})
        host.command.assert_called_once_with(['/usr/bin/gcc-11','-dumpversion'],{'PATH':'/usr/bin','HOME':'/private/home','TMPDIR':'/private/tmp'})

    def test_elf_refusal_context_binds_actual_sealed_frame_and_file_identity(self):
        with tempfile.TemporaryDirectory() as raw:
            path=Path(raw).resolve()/'selected';error=refused_elf(path)
            self.assertEqual(str(error),'ELF string table exceeds bound')
            with mock.patch.object(sealed_host,'system_file',return_value=fixture_identity(path)) as authenticate:
                value=host_diagnostics.elf_failure_context(sealed_host,error)
            authenticate.assert_called_once_with({'requestedPath':str(path),'path':str(path)})
            self.assertEqual(value['path'],str(path));self.assertEqual(value['parserFileStat']['size'],256)
            self.assertEqual(value['elf']['stringTableBytes'],[1048577]);self.assertEqual(value['elf']['neededEntryCount'],1)
            self.assertEqual(value['elf']['observedMachine'],62);self.assertFalse(value['elf']['dependencyNamesReported'])
            self.assertEqual(value['reauthenticatedFile'],{**fixture_identity(path),'sameFileStatAsRefusedRead':True})

    def test_elf_refusal_diagnostic_does_not_bind_replaced_bytes_to_old_read(self):
        with tempfile.TemporaryDirectory() as raw:
            path=Path(raw).resolve()/'selected';error=refused_elf(path)
            def replace(_):
                path.write_bytes(path.read_bytes()+b'\0');return fixture_identity(path)
            with mock.patch.object(sealed_host,'system_file',side_effect=replace):value=host_diagnostics.elf_failure_context(sealed_host,error)
            self.assertEqual(value['parserFileStat']['size'],256);self.assertEqual(value['reauthenticatedFile']['byteLength'],'257')
            self.assertFalse(value['reauthenticatedFile']['sameFileStatAsRefusedRead'])

    def test_elf_identity_refusal_retains_metadata_without_inventing_hash(self):
        with tempfile.TemporaryDirectory() as raw:
            path=Path(raw).resolve()/'selected';error=refused_elf(path)
            with mock.patch.object(sealed_host,'system_file',side_effect=ValueError('private secondary text')):value=host_diagnostics.elf_failure_context(sealed_host,error)
            self.assertEqual(value['elf']['stringTableBytes'],[1048577]);self.assertIsNone(value['reauthenticatedFile'])
            self.assertEqual(value['reauthenticationErrorType'],'ValueError');self.assertNotIn('private secondary text',json.dumps(value))

    def test_elf_diagnostic_failure_cannot_mask_primary_or_dump_arbitrary_text(self):
        original=ValueError('original host failure');output=io.StringIO()
        with mock.patch.object(host_diagnostics,'elf_failure_context',side_effect=RuntimeError('private secondary text')):
            with contextlib.redirect_stderr(output):
                with self.assertRaises(ValueError) as caught:host_diagnostics.preserve_host_failure(sealed_host,original,'dependency-selection','a'*64,'sha256:'+'b'*64)
        self.assertIs(caught.exception,original);value=json.loads(output.getvalue())
        self.assertTrue(value['primaryExceptionPreserved']);self.assertIsNone(value['elfContext']);self.assertEqual(value['diagnosticErrorType'],'RuntimeError')
        self.assertFalse(value['qualification']);self.assertLess(len(output.getvalue().encode()),8192)
        self.assertNotIn('private secondary text',output.getvalue())
        self.assertIsNone(host_diagnostics.elf_failure_context(sealed_host,original))

    def test_marker_and_setup_directory_guards_refuse_unsafe_ancestors(self):
        class Member:
            def __init__(self,name):
                self.name=name;self.parents=[];self.info=types.SimpleNamespace(st_uid=0,st_gid=0,st_mode=stat.S_IFDIR|0o755)
            def __str__(self):return self.name
            def is_absolute(self):return True
            def resolve(self,strict):return self
            def lstat(self):return self.info
        root,var,leaf=(Member(name) for name in ('/','/var','/var/lib'));leaf.parents=[var,root]
        with mock.patch.object(subject,'canonical',return_value=leaf):
            for guard in (require_marker_parent,subject.require_immutable_directory):
                guard(leaf)
                for member in (leaf,var,root):
                    original=member.info
                    for uid,mode in ((1001,stat.S_IFDIR|0o755),(0,stat.S_IFDIR|0o777),(0,stat.S_IFDIR|0o775),(0,stat.S_IFDIR|0o757),(0,stat.S_IFREG|0o755),(0,stat.S_IFLNK|0o777)):
                        member.info=types.SimpleNamespace(st_uid=uid,st_gid=0,st_mode=mode)
                        with self.assertRaises(ValueError):guard(leaf)
                    member.info=original
        with tempfile.TemporaryDirectory() as raw:
            parent=Path(raw).resolve();alias=parent/'alias';alias.symlink_to(parent,target_is_directory=True)
            with self.assertRaisesRegex(ValueError,'Canonical native marker parent'):require_marker_parent(alias)
            with self.assertRaisesRegex(ValueError,'Path alias'):subject.require_immutable_directory(alias)

    def test_first_marker_write_is_preceded_by_actual_ancestry_admission(self):
        calls=[]
        for index,node in enumerate(first_step.body):
            if isinstance(node,ast.FunctionDef):continue
            for child in ast.walk(node):
                if isinstance(child,ast.Call):calls.append((index,ast.unparse(child.func),child))
        guards=[(index,call) for index,name,call in calls if name=='require_marker_parent']
        writes=[index for index,name,call in calls if name=='os.open']
        self.assertEqual(len(guards),1);self.assertEqual(len(writes),1)
        self.assertLess(guards[0][0],writes[0]);self.assertEqual(ast.unparse(guards[0][1].args[0]),'path.parent')
        self.assertIn("path = Path('/var/lib')",workflow)

    def test_fresh_root_refusal_occurs_before_creation_without_ancestor_repair(self):
        root=Path('/var/lib/ideogram-native-control-123-2')
        with mock.patch.object(subject,'require_immutable_directory',side_effect=ValueError('unsafe ancestry')) as guard, mock.patch.object(subject,'fresh_directory') as create:
            with self.assertRaisesRegex(ValueError,'unsafe ancestry'):subject.fresh_control_root(root)
            guard.assert_called_once_with(root.parent);create.assert_not_called()
        with mock.patch.object(subject,'require_immutable_directory') as guard, mock.patch.object(subject,'fresh_directory',return_value=root) as create:
            self.assertEqual(subject.fresh_control_root(root),root)
            guard.assert_called_once_with(root.parent);create.assert_called_once_with(root)

    def test_immutable_owner_and_write_guard_is_unchanged(self):
        info=lambda uid,mode:types.SimpleNamespace(st_uid=uid,st_gid=999,st_mode=stat.S_IFREG|mode)
        for mode in (0o444,0o644,0o555,0o755,0o700): subject.require_immutable_member(Path('/selected'),info(0,mode),0)
        for uid,mode in ((1001,0o444),(0,0o664),(0,0o646),(0,0o777),(1001,0o700)):
            with self.assertRaises(subject.ImmutablePathRefusal):subject.require_immutable_member(Path('/opt'),info(uid,mode),1)

    def test_permission_refusal_reports_fixed_component_metadata_without_contents(self):
        info=types.SimpleNamespace(st_uid=1001,st_gid=1002,st_mode=stat.S_IFDIR|0o775)
        with self.assertRaises(subject.ImmutablePathRefusal) as caught: subject.require_immutable_member(Path('/opt'),info,1)
        value=caught.exception.observation
        self.assertEqual({k:value[k] for k in ('member','position','uid','gid','mode','type','contentsRead')},{'member':'/opt','position':1,'uid':1001,'gid':1002,'mode':'0775','type':'directory','contentsRead':False})
        self.assertLess(len(str(caught.exception)),1024)

    def test_unlisted_permission_path_is_redacted(self):
        info=types.SimpleNamespace(st_uid=1001,st_gid=1001,st_mode=stat.S_IFREG|0o600)
        error=subject.ImmutablePathRefusal(Path('/private/example-secret-value'),info,0)
        self.assertEqual(error.observation['member'],'<selected-input-component>')
        self.assertNotIn('example-secret-value',str(error))

    def test_retention_failure_cannot_mask_original_setup_exception(self):
        original=ValueError('original setup refusal'); retained=subject.retain_setup_diagnostics
        def fail(*_):raise RuntimeError('secondary must not be published as arbitrary text')
        subject.retain_setup_diagnostics=fail; output=io.StringIO()
        try:
            with contextlib.redirect_stderr(output):
                with self.assertRaises(ValueError) as caught:subject.preserve_setup_failure(None,original)
            self.assertIs(caught.exception,original);value=json.loads(output.getvalue())
            self.assertTrue(value['primaryExceptionPreserved']);self.assertEqual(value['errorType'],'RuntimeError')
            self.assertNotIn('secondary must not',output.getvalue())
        finally:subject.retain_setup_diagnostics=retained

    def test_actual_api_start_precedes_setup_and_controls_six_hour_deadline(self):
        value = subject.select_job(job_response(),123,2,HEAD,FIRST)
        self.assertEqual(value['startedEpochMs'],FIRST-1000)
        self.assertEqual(value['deadlineEpochMs'],FIRST-1000+21600000)
        self.assertEqual(value['jobId'],999)

    def test_partial_and_ambiguous_api_responses_refuse(self):
        for response in [{'total_count':2,'jobs':job_response()['jobs']}, {'total_count':2,'jobs':job_response()['jobs']*2}, {'total_count':0,'jobs':[]}]:
            with self.assertRaises(ValueError): subject.select_job(response,123,2,HEAD,FIRST)

    def test_other_run_attempt_revision_and_named_job_refuse(self):
        for key,value in [('run_id',124),('run_attempt',1),('head_sha','a'*40),('name','arbitrary-job')]:
            response=job_response();response['jobs'][0][key]=value
            with self.assertRaises(ValueError): subject.select_job(response,123,2,HEAD,FIRST)

    def test_completed_queued_null_future_and_malformed_job_start_refuse(self):
        for key,value in [('status','completed'),('status','queued'),('conclusion','success'),('started_at',None),('started_at','2026-10-03T12:00:02Z'),('started_at','2026-10-03 12:00:00')]:
            response=job_response();response['jobs'][0][key]=value
            with self.assertRaises(ValueError): subject.select_job(response,123,2,HEAD,FIRST)

    def test_source_path_escape_alias_conflict_and_identity_bounds_refuse(self):
        base={'kind':'hosted-native-workflow-source-selection-1','files':[{'path':'tooling/a.py','bytes':1,'sha256':'a'*64}]}
        self.assertEqual(subject.source_rows(base),base['files'])
        for path in ['/root/a','../a','a/../b','a//b','a\\b','a\nb']:
            value=copy.deepcopy(base);value['files'][0]['path']=path
            with self.assertRaises(ValueError): subject.source_rows(value)
        for row in [dict(base['files'][0]),{'path':'tooling/a.py/child','bytes':1,'sha256':'a'*64}]:
            value=copy.deepcopy(base);value['files'].append(row)
            with self.assertRaises(ValueError): subject.source_rows(value)
        value=copy.deepcopy(base);value['files'][0]['bytes']=256*1024**2+1
        with self.assertRaises(ValueError): subject.source_rows(value)

    def test_real_read_rejects_links_hardlinks_and_oversized_files(self):
        with tempfile.TemporaryDirectory() as raw:
            root=Path(raw).resolve(); source=root/'source';source.write_bytes(b'abc')
            self.assertEqual(subject.read(source,3),b'abc')
            with self.assertRaises(ValueError): subject.read(source,2)
            link=root/'alias';link.symlink_to(source)
            with self.assertRaises(ValueError): subject.read(link,3)
            hard=root/'hard';os.link(source,hard)
            with self.assertRaises(ValueError): subject.read(source,3)

    def test_setup_child_environment_excludes_credentials_and_injection(self):
        old=os.environ.copy()
        try:
            os.environ.update(IE_SETUP_TOKEN='secret',GITHUB_TOKEN='secret',NODE_OPTIONS='--require=bad',PYTHONPATH='/bad',LD_PRELOAD='/bad',HTTPS_PROXY='https://bad')
            env=subject.clean_environment('/private/home','/private/tmp')
            self.assertEqual(set(env),{'PATH','HOME','TMPDIR','LANG','LC_ALL','TZ','DEBIAN_FRONTEND','PYTHONDONTWRITEBYTECODE','PYTHONNOUSERSITE','PYTHONSAFEPATH'})
            self.assertEqual(env['HOME'],'/private/home');self.assertEqual(env['TMPDIR'],'/private/tmp')
            self.assertNotIn('secret',json.dumps(env))
        finally: os.environ.clear();os.environ.update(old)

    def test_real_export_collision_and_later_extra_members_refuse_publication(self):
        with tempfile.TemporaryDirectory() as raw:
            parent=Path(raw).resolve(); subject.require_directory_members(parent,set())
            unrelated=parent/'unrelated';unrelated.write_bytes(b'not selected for publication')
            with self.assertRaises(ValueError): subject.require_directory_members(parent,set())
            setup=parent/'setup';setup.mkdir()
            with self.assertRaises(ValueError): subject.require_directory_members(parent,{'setup'})
            unrelated.unlink();subject.require_directory_members(parent,{'setup'})
            (setup/'inventory.json').write_text('{}')
            subject.require_directory_members(setup,{'inventory.json'})
            (setup/'extra').write_bytes(b'unselected')
            with self.assertRaises(ValueError): subject.require_directory_members(setup,{'inventory.json'})
            (setup/'extra').unlink();(setup/'inventory.json').unlink();(setup/'inventory.json').symlink_to(parent/'missing')
            with self.assertRaises(ValueError): subject.require_directory_members(setup,{'inventory.json'})

    def test_closed_failed_attempt_is_exportable_without_success_credit(self):
        records={'inputs':closed('inputs'),'toolchain':closed('toolchain','FAIL')}
        self.assertEqual(subject.choose_export_phase('toolchain',records),'toolchain')
        self.assertEqual(records['toolchain']['effectiveOutcome'],'FAIL')

    def test_pre_directory_refusal_exports_only_actual_closed_predecessor(self):
        self.assertEqual(subject.choose_export_phase('toolchain',{'inputs':closed('inputs'),'toolchain':None}),'inputs')
        with self.assertRaises(ValueError): subject.choose_export_phase('inputs',{'inputs':None})

    def test_unclosed_or_wrong_phase_cannot_fall_back(self):
        for final in [closed('toolchain',released=False),closed('build16'),{}]:
            with self.assertRaises(ValueError): subject.choose_export_phase('toolchain',{'inputs':closed('inputs'),'toolchain':final})

    def test_missing_or_failed_predecessor_cannot_be_skipped(self):
        for previous in [None,closed('inputs','FAIL'),closed('inputs','INCONCLUSIVE')]:
            with self.assertRaises(ValueError): subject.choose_export_phase('toolchain',{'inputs':previous,'toolchain':closed('toolchain')})

    def test_unknown_phase_cannot_select_arbitrary_output(self):
        for phase in ['../outside','build19','export','']:
            with self.assertRaises(ValueError): subject.choose_export_phase(phase,{})

suite=unittest.defaultTestLoader.loadTestsFromTestCase(Boundaries)
result=unittest.TextTestRunner(verbosity=2).run(suite)
print(json.dumps({'tests':result.testsRun,'failures':len(result.failures),'errors':len(result.errors)}))
sys.exit(0 if result.wasSuccessful() else 1)
