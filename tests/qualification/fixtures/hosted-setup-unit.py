"""Pure setup admission and real filesystem refusals; never invokes setup."""
import copy
import base64
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
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('hosted_setup_test_subject', sys.argv.pop())
subject = importlib.util.module_from_spec(spec); spec.loader.exec_module(subject)
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



def diagnostic_fixture(root, grant='c'*64):
    config = {'runId':'ie-native-'+'d'*32, '_evidenceRoot':str(root)}
    directory = root/config['runId']/'toolchain'; directory.parent.mkdir(mode=0o700); directory.mkdir(mode=0o700)
    def save(name, value):
        path = directory/name; path.write_text(json.dumps(value)); path.chmod(0o600)
        return subject.identity(path)
    command = {'kind':'hosted-native-command-1', 'action':'toolchain', 'argv':['--grant',grant], 'environment':{'unselected':'never-publish'}, 'result':{'code':1,'signal':None,'timedOut':False,'interrupted':False,'timeoutMs':600000}, 'failure':None, 'stdoutBase64':base64.b64encode(b'').decode(), 'stderrBase64':base64.b64encode(('ValueError: toolchain detail '+grant+'\n').encode()).decode()}
    receipt = {'kind':'hosted-native-phase-1','phase':'toolchain','runId':config['runId'],'config':{'sha256':grant},'outcome':'FAIL','commands':[save('001-toolchain.json',command)],'failure':{'name':'Error','message':'Unsuccessful fixed child: toolchain'}}
    final = {'kind':'hosted-native-phase-finalization-1','phase':'toolchain','config':{'sha256':grant},'effectiveOutcome':'FAIL','timingLockReleased':False,'receipt':save('receipt.json',receipt),'failure':{'name':'Error','message':'Unsuccessful fixed child: toolchain'},'dataSummary':{'status':'PASS'},'dataReplay':{'status':'PASS'},'hostAudit':{'status':'PASS'},'hostReplay':{'status':'PASS'}}
    save('finalization.json',final)
    return config,directory,command,receipt,final,save

@contextlib.contextmanager
def diagnostic_files_as_controller():
    # Real ordinary files, fd stamps, modes, link counts, hashes and bytes. Only
    # root ownership/immutable shared ancestors are substituted for portable CI.
    original_admit,original_read=subject.diagnostic_private_member,subject.read
    def admit(path,info,directory=False):
        return original_admit(path,types.SimpleNamespace(st_uid=0,st_mode=info.st_mode,st_nlink=info.st_nlink),directory)
    with mock.patch.object(subject,'diagnostic_private_member',side_effect=admit), mock.patch.object(subject,'require_immutable_directory'), mock.patch.object(subject,'read',side_effect=lambda path,maximum=4*1024**2,root_owned=False:original_read(path,maximum,False)):
        yield

def observation_fixture(root, count=1):
    config,directory,command,receipt,final,save=diagnostic_fixture(root)
    config.update(_dataRoot='/fixed-owned-data',dataRootIdentity={'dev':1,'ino':99},owner={'uid':20000,'gid':20000})
    request={'kind':'capsule-volume-request-1','mode':'sample','ownerUid':20000,'ownerGid':20000,'rootIdentity':config['dataRootIdentity'],'policyId':'capsule-allocated-inodes-1'}
    canonical=lambda value:json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=True).encode()
    digest=lambda value:'sha256:'+hashlib.sha256(canonical(value)).hexdigest()
    attempt={'sequence':0,'previous':None,'startMonotonicUs':10,'endMonotonicUs':20,'startWallUs':100,'endWallUs':110,'rootBefore':None,'rootAfter':None,'status':'unknown','drained':True,'counts':None,'errors':[{'code':'FILESYSTEM_ERROR','path':'/capsule/toolchain','errno':13}]};attempt['hash']=digest(attempt)
    worker={'kind':'capsule-volume-observation-1','request':request,'requestHash':digest(request),'policyId':'capsule-allocated-inodes-1','bounds':{'maxEntries':1000000,'maxDepth':128,'maxAttempts':3,'maxWindowUs':1000000},'windowStartMonotonicUs':10,'windowEndMonotonicUs':21,'windowStartWallUs':100,'windowEndWallUs':111,'attempts':[attempt],'selectedAttempt':None,'status':'unknown','drained':True}
    rows=[];previous=None
    for index in range(count):
        rows.append({'kind':'hosted-native-observation-command-1','action':'observe','binary':'/fixed-controller-python','argv':['--grant','c'*64],'startedMs':index*10+1,'endedMs':index*10+2,'result':{'code':1,'signal':None,'timedOut':False,'interrupted':False,'timeoutMs':2000},'failure':None,'stdoutBase64':base64.b64encode(canonical(worker)+b'\n').decode(),'stderrBase64':base64.b64encode(('worker detail '+'c'*64).encode()).decode(),'root':config['_dataRoot'],'rootIdentity':config['dataRootIdentity']})
        row={'sequence':index,'previous':previous,'key':'producer-data','boundary':'initial' if index==0 else 'final','startedMs':index*10,'endedMs':index*10+3,'bytes':None,'observation':None,'error':{'name':'Error','message':'Unsuccessful fixed child: observe'}}
        row['hash']=hashlib.sha256(json.dumps(row,separators=(',',':')).encode()).hexdigest();previous=row['hash'];rows.append(row)
    scopes=[]
    for key in ('host-journal-watchdog','producer-data'):
        scopes.append({'key':key,'status':'INCONCLUSIVE','coverageComplete':False,'maximumStartGapMs':None,'maximumPossibleObservationStartGapMs':None,'peakBytes':None,'capacityBytes':1 if key=='host-journal-watchdog' else 32*1024**3,'samples':0 if key=='host-journal-watchdog' else count,'unknownSamples':0 if key=='host-journal-watchdog' else count,'targetPercent':80,'ceilingPercent':90})
    summary={'kind':'hosted-native-data-observation-1','status':'FAIL','scopes':scopes,'records':count,'journalHead':previous,'intervalMs':2000,'maxSuccessfulStartGapMs':4000,'physicalQualification':False}
    replay={'status':'FAIL','scopes':scopes,'records':count,'journalHead':previous}
    def commit_rows(changed=rows):
        path=directory/'data-observations.jsonl';path.write_bytes(b''.join(json.dumps(row,separators=(',',':')).encode()+b'\n' for row in changed));path.chmod(0o600)
        receipt['dataStorage']={'summary':summary,'journal':subject.identity(path),'replay':replay}
        final.update(dataSummary=summary,dataReplay=replay,receipt=save('receipt.json',receipt));save('finalization.json',final)
    commit_rows()
    return config,directory,receipt,final,rows,worker,commit_rows,save

# Independent encoders used only by the successor boundary fixtures. They do not
# call the projector's hash/parser helpers or adjust the field under test.
def observation_test_json(value):
    return json.dumps(value,separators=(',',':'),ensure_ascii=True).encode('ascii')

def observation_test_reseal_sample(row):
    result={key:value for key,value in row.items() if key!='hash'}
    result['hash']=hashlib.sha256(observation_test_json(result)).hexdigest()
    return result

def observation_test_reseal_worker(value):
    result=copy.deepcopy(value)
    def digest(body):
        encoded=json.dumps(body,sort_keys=True,separators=(',',':'),ensure_ascii=True).encode('ascii')
        return 'sha256:'+hashlib.sha256(encoded).hexdigest()
    result['requestHash']=digest(result['request'])
    for attempt in result['attempts']:
        attempt['hash']=digest({key:value for key,value in attempt.items() if key!='hash'})
    return result

def observation_test_bind_summaries(final, rows):
    samples=[row for row in rows if row.get('kind')!='hosted-native-observation-command-1']
    for summary in (final['dataSummary'],final['dataReplay']):
        summary.update(records=len(samples),journalHead=samples[-1]['hash'] if samples else None)

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

    def test_setup_directory_guard_refuses_unsafe_ancestors(self):
        class Member:
            def __init__(self,name):
                self.name=name;self.parents=[];self.info=types.SimpleNamespace(st_uid=0,st_gid=0,st_mode=stat.S_IFDIR|0o755)
            def __str__(self):return self.name
            def is_absolute(self):return True
            def resolve(self,strict):return self
            def lstat(self):return self.info
        root,var,leaf=(Member(name) for name in ('/','/var','/var/lib'));leaf.parents=[var,root]
        with mock.patch.object(subject,'canonical',return_value=leaf):
            for guard in (subject.require_immutable_directory,):
                guard(leaf)
                for member in (leaf,var,root):
                    original=member.info
                    for uid,mode in ((1001,stat.S_IFDIR|0o755),(0,stat.S_IFDIR|0o777),(0,stat.S_IFDIR|0o775),(0,stat.S_IFDIR|0o757),(0,stat.S_IFREG|0o755),(0,stat.S_IFLNK|0o777)):
                        member.info=types.SimpleNamespace(st_uid=uid,st_gid=0,st_mode=mode)
                        with self.assertRaises(ValueError):guard(leaf)
                    member.info=original
        with tempfile.TemporaryDirectory() as raw:
            parent=Path(raw).resolve();alias=parent/'alias';alias.symlink_to(parent,target_is_directory=True)
            with self.assertRaisesRegex(ValueError,'Path alias'):subject.require_immutable_directory(alias)

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


    def test_failed_unclosed_diagnostic_keeps_failure_and_actual_error_without_grant(self):
        with tempfile.TemporaryDirectory() as raw, diagnostic_files_as_controller():
            config,directory,command,receipt,final,save=diagnostic_fixture(Path(raw).resolve())
            value=subject.phase_diagnostic(config,'toolchain','c'*64,{'bytes':0})
            self.assertEqual(value['effectiveOutcome'],'FAIL');self.assertFalse(value['timingLockReleased'])
            self.assertFalse(value['closureVerified']);self.assertFalse(value['qualification'])
            self.assertEqual(value['source']['sha256'],subject.identity(directory/'finalization.json')['sha256'])
            self.assertEqual(value['receipt']['source']['sha256'],subject.identity(directory/'receipt.json')['sha256'])
            entry=value['commands'][0];self.assertEqual(entry['action'],'toolchain');self.assertEqual(entry['result']['code'],1);self.assertEqual(entry['result']['timeoutMs'],600000)
            self.assertEqual(entry['source']['sha256'],receipt['commands'][0]['sha256'])
            self.assertIn('ValueError: toolchain detail',entry['stderr']['text']);self.assertTrue(entry['stderr']['redacted'])
            serialized=json.dumps(value)
            for secret in ('c'*64,'never-publish','--grant','stdoutBase64','stderrBase64','environment','argv','"config"'):self.assertNotIn(secret,serialized)

    def test_diagnostic_stream_tail_is_bounded_and_redacts_before_truncation(self):
        grant='c'*64;raw=(b'x'*70000)+grant.encode()+b' END'
        value=subject.diagnostic_stream(base64.b64encode(raw).decode(),grant)
        self.assertEqual(value['originalBytes'],len(raw));self.assertEqual(value['retainedBytes'],65536);self.assertTrue(value['truncated'])
        self.assertTrue(value['redacted']);self.assertNotIn(grant,value['text']);self.assertTrue(value['text'].endswith('<redacted-controller-grant> END'))
        for encoded in ('***','a',base64.b64encode(b'x'*(16*1024**2+1)).decode()):
            with self.assertRaises(ValueError):subject.diagnostic_stream(encoded,grant)

    def test_diagnostic_private_metadata_refuses_wrong_owner_modes_links_and_types(self):
        def info(uid=0,mode=stat.S_IFREG|0o600,nlink=1):return types.SimpleNamespace(st_uid=uid,st_mode=mode,st_nlink=nlink)
        subject.diagnostic_private_member(Path('/record'),info())
        subject.diagnostic_private_member(Path('/phase'),info(mode=stat.S_IFDIR|0o700,nlink=2),True)
        for value in (info(uid=1001),info(mode=stat.S_IFREG|0o644),info(nlink=2),info(mode=stat.S_IFLNK|0o600),info(mode=stat.S_IFIFO|0o600),info(mode=stat.S_IFDIR|0o600)):
            with self.assertRaises(ValueError):subject.diagnostic_private_member(Path('/record'),value)
        for value in (info(uid=1001,mode=stat.S_IFDIR|0o700),info(mode=stat.S_IFDIR|0o755),info(mode=stat.S_IFREG|0o700)):
            with self.assertRaises(ValueError):subject.diagnostic_private_member(Path('/phase'),value,True)

    def test_real_diagnostic_file_refuses_alias_hardlink_overflow_and_wrong_mode(self):
        with tempfile.TemporaryDirectory() as raw, diagnostic_files_as_controller():
            root=Path(raw).resolve();path=root/'record';path.write_bytes(b'abc');path.chmod(0o600)
            budget={'bytes':0};self.assertEqual(subject.diagnostic_read(path,3,budget),b'abc');self.assertEqual(budget['bytes'],3)
            for limit,budget in ((2,{'bytes':0}),(3,{'bytes':subject.DIAGNOSTIC_READ_LIMIT-2})):
                with self.assertRaises(ValueError):subject.diagnostic_read(path,limit,budget)
            path.chmod(0o644)
            with self.assertRaises(ValueError):subject.diagnostic_read(path,3,{'bytes':0})
            path.chmod(0o600);alias=root/'alias';alias.symlink_to(path)
            with self.assertRaises(ValueError):subject.diagnostic_read(alias,3,{'bytes':0})
            hard=root/'hard';os.link(path,hard)
            with self.assertRaises(ValueError):subject.diagnostic_read(path,3,{'bytes':0})

    def test_diagnostic_terminal_binds_exact_phase_grant_outcome_and_release_type(self):
        with tempfile.TemporaryDirectory() as raw, diagnostic_files_as_controller():
            config,directory,command,receipt,final,save=diagnostic_fixture(Path(raw).resolve())
            for key,value in [('kind','other'),('phase','inputs'),('config',{'sha256':'e'*64}),('effectiveOutcome','SUCCESS'),('timingLockReleased','false')]:
                changed=copy.deepcopy(final);changed[key]=value;save('finalization.json',changed)
                with self.assertRaises(ValueError):subject.phase_diagnostic(config,'toolchain','c'*64,{'bytes':0})

    def test_diagnostic_receipt_refuses_other_paths_bad_hash_and_run_identity(self):
        with tempfile.TemporaryDirectory() as raw, diagnostic_files_as_controller():
            config,directory,command,receipt,final,save=diagnostic_fixture(Path(raw).resolve())
            for key,value in [('path',str(directory/'../receipt.json')),('path',str(directory/'../../data/receipt.json')),('sha256','e'*64),('bytes',1)]:
                changed=copy.deepcopy(final);changed['receipt'][key]=value;save('finalization.json',changed)
                with self.assertRaises(ValueError):subject.phase_diagnostic(config,'toolchain','c'*64,{'bytes':0})
            receipt['runId']='ie-native-'+'e'*32;final['receipt']=save('receipt.json',receipt);save('finalization.json',final)
            with self.assertRaises(ValueError):subject.phase_diagnostic(config,'toolchain','c'*64,{'bytes':0})

    def test_diagnostic_command_allowlist_rejects_payload_paths_actions_ordinals_and_duplicates(self):
        with tempfile.TemporaryDirectory() as raw, diagnostic_files_as_controller():
            config,directory,command,receipt,final,save=diagnostic_fixture(Path(raw).resolve())
            original=copy.deepcopy(receipt['commands'])
            for path in (str(directory/'../001-toolchain.json'),str(directory/'001-observe.json'),str(directory/'002-toolchain.json'),str(directory/'001-build16.json'),str(directory/'001-toolchain.json/child')):
                receipt['commands']=[{**original[0],'path':path}];final['receipt']=save('receipt.json',receipt);save('finalization.json',final)
                with self.assertRaises(ValueError):subject.phase_diagnostic(config,'toolchain','c'*64,{'bytes':0})
            for refs in (original*2,original*9):
                receipt['commands']=refs;final['receipt']=save('receipt.json',receipt);save('finalization.json',final)
                with self.assertRaises(ValueError):subject.phase_diagnostic(config,'toolchain','c'*64,{'bytes':0})

    def test_diagnostic_command_hash_and_raw_stream_validation_precede_publication(self):
        with tempfile.TemporaryDirectory() as raw, diagnostic_files_as_controller():
            config,directory,command,receipt,final,save=diagnostic_fixture(Path(raw).resolve())
            command['stderrBase64']='unretained replacement';save('001-toolchain.json',command)
            with self.assertRaisesRegex(ValueError,'command diagnostic differs'):subject.phase_diagnostic(config,'toolchain','c'*64,{'bytes':0})
            command['stderrBase64']='***';receipt['commands']=[save('001-toolchain.json',command)];final['receipt']=save('receipt.json',receipt);save('finalization.json',final)
            with self.assertRaises(ValueError):subject.phase_diagnostic(config,'toolchain','c'*64,{'bytes':0})

    def test_diagnostic_missing_terminal_is_explicit_and_does_not_read_payload(self):
        with tempfile.TemporaryDirectory() as raw, diagnostic_files_as_controller():
            root=Path(raw).resolve();config={'runId':'ie-native-'+'d'*32,'_evidenceRoot':str(root)}
            with mock.patch.object(subject,'diagnostic_read') as read:
                self.assertEqual(subject.phase_diagnostic(config,'toolchain','c'*64,{'bytes':0}),{'phase':'toolchain','status':'not-created'})
                directory=root/config['runId']/'toolchain';directory.parent.mkdir(mode=0o700);directory.mkdir(mode=0o700)
                self.assertEqual(subject.phase_diagnostic(config,'toolchain','c'*64,{'bytes':0}),{'phase':'toolchain','status':'finalization-absent'})
                for phase in ('../data','export','build19'):
                    with self.assertRaises(ValueError):subject.phase_diagnostic(config,phase,'c'*64,{'bytes':0})
                read.assert_not_called()

    def test_real_diagnostic_read_refuses_mid_read_mutation(self):
        with tempfile.TemporaryDirectory() as raw, diagnostic_files_as_controller():
            path=Path(raw).resolve()/'record';path.write_bytes(b'abc');path.chmod(0o600);original=subject.os.read;changed=False
            def mutate(fd,size):
                nonlocal changed
                block=original(fd,size)
                if block and not changed:
                    changed=True;path.write_bytes(b'xyz')
                return block
            budget={'bytes':0}
            with mock.patch.object(subject.os,'read',side_effect=mutate):
                with self.assertRaisesRegex(ValueError,'changed during read'):subject.diagnostic_read(path,3,budget)
            self.assertEqual(budget['bytes'],3)

    def test_diagnostic_cli_refuses_nonroot_before_reading_any_grant_or_config(self):
        args=types.SimpleNamespace(attempted='toolchain',config='/unselected')
        with mock.patch.object(subject.os,'getuid',return_value=1001),mock.patch.object(subject.os,'geteuid',return_value=1001),mock.patch.object(subject,'read') as read:
            with self.assertRaises(ValueError):subject.retain_phase_diagnostics(args)
            read.assert_not_called()

    def test_observation_diagnostic_projects_actual_failed_child_and_worker_errno_without_authority(self):
        with tempfile.TemporaryDirectory() as raw, diagnostic_files_as_controller():
            config,directory,receipt,final,rows,worker,commit,save=observation_fixture(Path(raw).resolve())
            budget={'bytes':0};value=subject.phase_diagnostic(config,'toolchain','c'*64,budget);detail=value['accounting'];journal=detail['journal']
            self.assertEqual(detail['summary']['scopes'][1]['unknownSamples'],1);self.assertEqual(detail['replay']['declaredStatus'],'FAIL')
            self.assertEqual((journal['status'],journal['records'],journal['retainedObservations'],journal['omittedObservations']),('projected',1,1,0))
            observed=journal['observations'][0];self.assertEqual(observed['error']['message'],'Unsuccessful fixed child: observe')
            self.assertEqual(observed['observationCommand']['result']['code'],1)
            self.assertEqual(observed['observationCommand']['worker']['attempts'][0]['errors'],[{'code':'FILESYSTEM_ERROR','errno':13,'member':'/capsule/toolchain'}])
            self.assertIn('<redacted-controller-grant>',observed['observationCommand']['stderr']['text'])
            self.assertEqual(journal['source']['sha256'],receipt['dataStorage']['journal']['sha256']);self.assertFalse(journal['rawStorageVerified']);self.assertFalse(value['timingLockReleased'])
            text=json.dumps(value)
            for forbidden in ('c'*64,'--grant','"argv"','"environment"','"config"','stdoutBase64','/fixed-owned-data'):self.assertNotIn(forbidden,text)
            self.assertGreaterEqual(budget['bytes'],receipt['dataStorage']['journal']['bytes'])

    def test_observation_diagnostic_preserves_explicit_missing_and_refused_detail(self):
        with tempfile.TemporaryDirectory() as raw, diagnostic_files_as_controller():
            config,directory,command,receipt,final,save=diagnostic_fixture(Path(raw).resolve())
            value=subject.phase_diagnostic(config,'toolchain','c'*64,{'bytes':0})
            self.assertEqual(value['accounting']['journal']['status'],'not-recorded');self.assertIsNone(value['accounting']['journal']['omittedObservations'])
            final['dataSummary']={'status':'FAIL','unknownField':'never-copy'};save('finalization.json',final)
            value=subject.phase_diagnostic(config,'toolchain','c'*64,{'bytes':0})
            self.assertEqual(value['accounting']['refusals'],1);self.assertEqual(value['commands'][0]['result']['code'],1);self.assertNotIn('never-copy',json.dumps(value))

    def test_observation_diagnostic_refuses_wrong_journal_reference_before_any_external_read(self):
        with tempfile.TemporaryDirectory() as raw, diagnostic_files_as_controller():
            config,directory,receipt,final,rows,worker,commit,save=observation_fixture(Path(raw).resolve())
            ref=copy.deepcopy(receipt['dataStorage']['journal']);original=subject.diagnostic_read
            for path in (str(directory/'../data-observations.jsonl'),'/fixed-owned-data/payload','/tmp/timing.lock'):
                receipt['dataStorage']['journal']={**ref,'path':path};final['receipt']=save('receipt.json',receipt);save('finalization.json',final)
                with mock.patch.object(subject,'diagnostic_read',wraps=original) as read:
                    value=subject.phase_diagnostic(config,'toolchain','c'*64,{'bytes':0})
                    self.assertEqual(value['accounting']['status'],'diagnostic-refused');self.assertNotIn(path,[str(call.args[0]) for call in read.call_args_list])

    def test_observation_diagnostic_refuses_changed_bytes_hash_and_summary_binding(self):
        with tempfile.TemporaryDirectory() as raw, diagnostic_files_as_controller():
            config,directory,receipt,final,rows,worker,commit,save=observation_fixture(Path(raw).resolve())
            path=directory/'data-observations.jsonl';path.write_bytes(path.read_bytes()+b' ')
            self.assertEqual(subject.phase_diagnostic(config,'toolchain','c'*64,{'bytes':0})['accounting']['status'],'diagnostic-refused')
            commit();receipt['dataStorage']['summary']={**final['dataSummary'],'records':99};final['receipt']=save('receipt.json',receipt);save('finalization.json',final)
            self.assertEqual(subject.phase_diagnostic(config,'toolchain','c'*64,{'bytes':0})['accounting']['status'],'diagnostic-refused')

    def test_observation_diagnostic_refuses_unknown_duplicate_or_unpaired_journal_grammar(self):
        with tempfile.TemporaryDirectory() as raw, diagnostic_files_as_controller():
            config,directory,receipt,final,rows,worker,commit,save=observation_fixture(Path(raw).resolve())
            variants=[[{'kind':'other','path':'/do-not-read'}],rows[:1],rows+rows[:1],[rows[0],rows[0],rows[1]],[{**rows[0],'environment':{}},rows[1]],[{**rows[0],'root':'/another-root'},rows[1]],[rows[0],{**rows[1],'hash':'f'*64}]]
            for changed in variants:
                commit(changed);value=subject.phase_diagnostic(config,'toolchain','c'*64,{'bytes':0});self.assertEqual(value['accounting']['status'],'diagnostic-refused')
            with self.assertRaisesRegex(ValueError,'Duplicate'):subject.diagnostic_json(b'{"x":1,"x":2}')
            with self.assertRaises(ValueError):subject.diagnostic_json(b'{"x":NaN}')

    def test_observation_diagnostic_binds_worker_request_attempt_hash_and_error_grammar(self):
        with tempfile.TemporaryDirectory() as raw, diagnostic_files_as_controller():
            config,directory,receipt,final,rows,worker,commit,save=observation_fixture(Path(raw).resolve())
            mutations=[('policyId','different'),('selectedAttempt',True),('attempts',[]),('unexpected','no')]
            for key,value in mutations:
                changed=copy.deepcopy(worker);changed[key]=value
                with self.assertRaises(ValueError):subject.diagnostic_worker(json.dumps(changed).encode(),config,'c'*64)
            changed=copy.deepcopy(worker);changed['attempts'][0]['errors'][0]['errno']=5
            with self.assertRaisesRegex(ValueError,'chain'):subject.diagnostic_worker(json.dumps(changed).encode(),config,'c'*64)
            for payload in (b'',b'not JSON'):
                self.assertIn('detailStatus',subject.diagnostic_worker(payload,config,'c'*64))
            with self.assertRaises(ValueError):subject.diagnostic_worker(b'{"kind":"unknown"}',config,'c'*64)

    def test_observation_diagnostic_caps_selected_rows_and_counts_omissions(self):
        with tempfile.TemporaryDirectory() as raw, diagnostic_files_as_controller():
            config,directory,receipt,final,rows,worker,commit,save=observation_fixture(Path(raw).resolve(),34)
            value=subject.phase_diagnostic(config,'toolchain','c'*64,{'bytes':0})['accounting']['journal']
            self.assertEqual((value['records'],value['eligibleObservations'],value['retainedObservations'],value['omittedObservations']),(34,34,32,2))
            self.assertEqual(value['observations'][-1]['sequence'],31);self.assertEqual(value['source']['bytes'],receipt['dataStorage']['journal']['bytes'])

    def test_observation_diagnostic_keeps_fixed_read_limits_and_charges_failed_attempts(self):
        with tempfile.TemporaryDirectory() as raw, diagnostic_files_as_controller():
            config,directory,receipt,final,rows,worker,commit,save=observation_fixture(Path(raw).resolve())
            self.assertEqual(subject.DIAGNOSTIC_READ_LIMIT,64*1024**2);self.assertEqual(subject.DIAGNOSTIC_JOURNAL_LIMIT,8*1024**2)
            storage=receipt['dataStorage'];budget={'bytes':subject.DIAGNOSTIC_READ_LIMIT-storage['journal']['bytes']+1}
            with self.assertRaisesRegex(ValueError,'read bound'):subject.diagnostic_journal(config,directory,storage,final['dataSummary'],final['dataReplay'],'c'*64,budget)
            path=directory/'data-observations.jsonl';path.write_bytes(path.read_bytes().replace(b'Unsuccessful',b'UnsuccessfuL'))
            budget={'bytes':0}
            with self.assertRaises(ValueError):subject.diagnostic_journal(config,directory,storage,final['dataSummary'],final['dataReplay'],'c'*64,budget)
            self.assertEqual(budget['bytes'],path.stat().st_size)

    def test_observation_diagnostic_real_links_and_modes_refuse_without_lease_access(self):
        with tempfile.TemporaryDirectory() as raw, diagnostic_files_as_controller():
            config,directory,receipt,final,rows,worker,commit,save=observation_fixture(Path(raw).resolve())
            path=directory/'data-observations.jsonl';alias=directory/'original-journal';path.rename(alias);path.symlink_to(alias)
            self.assertEqual(subject.phase_diagnostic(config,'toolchain','c'*64,{'bytes':0})['accounting']['status'],'diagnostic-refused')
            path.unlink();alias.rename(path);path.chmod(0o644)
            self.assertEqual(subject.phase_diagnostic(config,'toolchain','c'*64,{'bytes':0})['accounting']['status'],'diagnostic-refused')
            path.chmod(0o600);os.link(path,alias)
            self.assertEqual(subject.phase_diagnostic(config,'toolchain','c'*64,{'bytes':0})['accounting']['status'],'diagnostic-refused')

    def test_observation_diagnostic_deadline_propagates_instead_of_swallowing_timeout(self):
        with tempfile.TemporaryDirectory() as raw, diagnostic_files_as_controller():
            config,directory,receipt,final,rows,worker,commit,save=observation_fixture(Path(raw).resolve())
            with mock.patch.object(subject,'diagnostic_journal',side_effect=TimeoutError('deadline')):
                with self.assertRaises(TimeoutError):subject.phase_diagnostic(config,'toolchain','c'*64,{'bytes':0})

    def test_observation_diagnostic_successful_and_watchdog_rows_do_not_invent_failure(self):
        with tempfile.TemporaryDirectory() as raw, diagnostic_files_as_controller():
            config,directory,receipt,final,rows,worker,commit,save=observation_fixture(Path(raw).resolve())
            canonical=lambda value:json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=True).encode()
            attempt=worker['attempts'][0];attempt.update(status='complete',errors=[],counts={'entries':1,'uniqueInodes':1,'directories':1,'regularFiles':0,'symlinks':0,'allocatedBytes':4096,'regularLogicalBytes':0,'symlinkAllocatedBytes':0})
            stamp={'dev':1,'ino':99,'mode':16832,'uid':20000,'gid':20000,'nlink':2,'size':4096,'blocks':8,'mtimeNs':1,'ctimeNs':1};attempt.update(rootBefore=stamp,rootAfter=stamp)
            attempt['hash']='sha256:'+hashlib.sha256(canonical({k:v for k,v in attempt.items() if k!='hash'})).hexdigest();worker.update(status='complete',selectedAttempt=0)
            rows[0]['result']['code']=0;rows[0]['stdoutBase64']=base64.b64encode(canonical(worker)+b'\n').decode();rows[0]['stderrBase64']=''
            sample=rows[1];sample.update(error=None,bytes=4096,observation={'bytes':4096,'rootIdentity':config['dataRootIdentity'],'result':worker,'pointInTime':True});sample.pop('hash');sample['hash']=hashlib.sha256(json.dumps(sample,separators=(',',':')).encode()).hexdigest()
            watchdog={'sequence':1,'previous':sample['hash'],'key':'host-journal-watchdog','boundary':'final','startedMs':10,'endedMs':11,'bytes':0,'observation':{'bytes':0,'meaning':'Journal watchdog only; actual host audit owns accounting'},'error':None};watchdog['hash']=hashlib.sha256(json.dumps(watchdog,separators=(',',':')).encode()).hexdigest()
            for summary in (final['dataSummary'],final['dataReplay']):
                summary.update(records=2,journalHead=watchdog['hash'])
                for scope in summary['scopes']:scope.update(samples=1,unknownSamples=0,peakBytes=0 if scope['key']=='host-journal-watchdog' else 4096)
            commit(rows+[watchdog]);value=subject.phase_diagnostic(config,'toolchain','c'*64,{'bytes':0})['accounting']['journal']
            self.assertEqual((value['records'],value['observationCommands'],value['eligibleObservations'],value['retainedObservations'],value['omittedObservations']),(2,1,0,0,0));self.assertFalse(value['rawStorageVerified'])

    def test_observation_source_manifest_admits_exact_projector_bytes(self):
        source_path=producer_root/'hosted-sources.json';raw=source_path.read_bytes()
        selected=json.loads(raw)['files'];pins=[row for row in selected if row['path']=='tooling/rollback-producer/hosted-setup.py']
        self.assertEqual(len(pins),1);projector=Path(subject.__file__).read_bytes()
        self.assertEqual((pins[0]['bytes'],pins[0]['sha256']),(len(projector),hashlib.sha256(projector).hexdigest()))

    def test_observation_journal_resealed_sequence_and_previous_mismatches_reach_chain_guard(self):
        with tempfile.TemporaryDirectory() as raw, diagnostic_files_as_controller():
            config,directory,receipt,final,rows,worker,commit,save=observation_fixture(Path(raw).resolve(),2)
            for field in ('sequence','previous'):
                with self.subTest(field=field):
                    changed=copy.deepcopy(rows)
                    if field=='sequence':
                        changed[1]['sequence']=7;changed[1]=observation_test_reseal_sample(changed[1]);changed[3]['previous']=changed[1]['hash']
                    else:changed[3]['previous']='e'*64
                    changed[3]=observation_test_reseal_sample(changed[3]);observation_test_bind_summaries(final,changed);commit(changed)
                    storage=receipt['dataStorage'];self.assertEqual(storage['journal'],subject.identity(directory/'data-observations.jsonl'))
                    for sample in (changed[1],changed[3]):self.assertEqual(sample['hash'],observation_test_reseal_sample(sample)['hash'])
                    with self.assertRaisesRegex(ValueError,'^Accounting journal chain differs$'):
                        subject.diagnostic_journal(config,directory,storage,final['dataSummary'],final['dataReplay'],'c'*64,{'bytes':0})

    def test_observation_journal_resealed_summary_and_replay_count_head_mismatches_reach_closure_guard(self):
        with tempfile.TemporaryDirectory() as raw, diagnostic_files_as_controller():
            config,directory,receipt,final,rows,worker,commit,save=observation_fixture(Path(raw).resolve(),2)
            expected=subject.identity(directory/'data-observations.jsonl')
            for summary_name in ('dataSummary','dataReplay'):
                for field,value in (('records',3),('journalHead','e'*64)):
                    with self.subTest(summary=summary_name,field=field):
                        observation_test_bind_summaries(final,rows);final[summary_name][field]=value;commit(rows)
                        storage=receipt['dataStorage'];self.assertEqual(storage['journal'],expected)
                        self.assertEqual(storage['summary'],final['dataSummary']);self.assertEqual(storage['replay'],final['dataReplay'])
                        with self.assertRaisesRegex(ValueError,'^Diagnostic journal closure differs$'):
                            subject.diagnostic_journal(config,directory,storage,final['dataSummary'],final['dataReplay'],'c'*64,{'bytes':0})

    def test_observation_worker_resealed_request_identity_mismatches_reach_provenance_guard(self):
        with tempfile.TemporaryDirectory() as raw:
            config,directory,receipt,final,rows,worker,commit,save=observation_fixture(Path(raw).resolve())
            for field,value in (('kind','other-request'),('mode','initial-empty'),('ownerUid',20001),('ownerGid',20001),('rootIdentity',{'dev':1,'ino':100}),('rootIdentity',{'dev':2,'ino':99}),('rootIdentity',None),('policyId','other-policy')):
                with self.subTest(field=field,value=value):
                    changed=copy.deepcopy(worker);changed['request'][field]=value;changed=observation_test_reseal_worker(changed)
                    self.assertNotEqual(changed['requestHash'],worker['requestHash'])
                    with self.assertRaisesRegex(ValueError,'^Worker diagnostic provenance differs$'):
                        subject.diagnostic_worker(observation_test_json(changed),config,'c'*64)

    def test_observation_worker_resealed_error_scalar_and_member_mismatches_reach_grammar_guards(self):
        with tempfile.TemporaryDirectory() as raw:
            config,directory,receipt,final,rows,worker,commit,save=observation_fixture(Path(raw).resolve())
            cases=[('errno','13','Worker error grammar differs'),('errno',-1,'Worker error grammar differs'),('errno',65536,'Worker error grammar differs'),('errno',True,'Worker error grammar differs'),('code','lowercase','Worker error grammar differs'),('code',None,'Worker error grammar differs'),('extra','unselected','Worker error grammar differs'),('path','/private/member','Logical scanner error member differs'),('path','/capsulex/member','Logical scanner error member differs'),('path','/capsule/'+('x'*56),'Logical scanner error member differs'),('path','/capsule/\nmember','Logical scanner error member differs')]
            for field,value,message in cases:
                with self.subTest(field=field,value=value):
                    changed=copy.deepcopy(worker);changed['attempts'][0]['errors'][0][field]=value;changed=observation_test_reseal_worker(changed)
                    self.assertNotEqual(changed['attempts'][0]['hash'],worker['attempts'][0]['hash'])
                    with self.assertRaisesRegex(ValueError,'^'+message+'$'):
                        subject.diagnostic_worker(observation_test_json(changed),config,'c'*64)

    def test_observation_journal_accepts_exact_eight_mib_and_refuses_one_more_before_read(self):
        with tempfile.TemporaryDirectory() as raw, diagnostic_files_as_controller():
            config,directory,receipt,final,rows,worker,commit,save=observation_fixture(Path(raw).resolve(),34)
            limit=8*1024**2;commands=[row for row in rows if row.get('kind')=='hosted-native-observation-command-1']
            remaining=limit-sum(len(observation_test_json(row))+1 for row in rows);each,extra=divmod(remaining,len(commands))
            for index,command in enumerate(commands):command['binary']+='p'*(each+(index<extra))
            self.assertTrue(all(len(observation_test_json(row))<=256*1024 for row in rows));commit(rows)
            storage=receipt['dataStorage'];self.assertEqual(storage['journal']['bytes'],limit);budget={'bytes':0}
            result=subject.diagnostic_journal(config,directory,storage,final['dataSummary'],final['dataReplay'],'c'*64,budget)
            self.assertEqual((result['status'],result['records'],result['omittedObservations'],budget['bytes']),('projected',34,2,limit));self.assertFalse(result['rawStorageVerified'])
            self.assertNotIn('pppppp',json.dumps(result))
            commands[-1]['binary']+='p';commit(rows);self.assertEqual(receipt['dataStorage']['journal']['bytes'],limit+1)
            with mock.patch.object(subject,'diagnostic_read') as read:
                with self.assertRaisesRegex(ValueError,'^Exact controller diagnostic reference required$'):
                    subject.diagnostic_journal(config,directory,receipt['dataStorage'],final['dataSummary'],final['dataReplay'],'c'*64,{'bytes':0})
                read.assert_not_called()

    def test_observation_journal_accepts_exact_line_limit_and_refuses_one_more_after_pinned_read(self):
        with tempfile.TemporaryDirectory() as raw, diagnostic_files_as_controller():
            config,directory,receipt,final,rows,worker,commit,save=observation_fixture(Path(raw).resolve())
            limit=256*1024;rows[0]['binary']+='p'*(limit-len(observation_test_json(rows[0])));self.assertEqual(len(observation_test_json(rows[0])),limit);commit(rows)
            result=subject.diagnostic_journal(config,directory,receipt['dataStorage'],final['dataSummary'],final['dataReplay'],'c'*64,{'bytes':0})
            self.assertEqual(result['status'],'projected');self.assertEqual(result['records'],1);self.assertNotIn('pppppp',json.dumps(result))
            rows[0]['binary']+='p';commit(rows);self.assertEqual(len(observation_test_json(rows[0])),limit+1);budget={'bytes':0}
            with self.assertRaisesRegex(ValueError,'^Diagnostic journal line bound$'):
                subject.diagnostic_journal(config,directory,receipt['dataStorage'],final['dataSummary'],final['dataReplay'],'c'*64,budget)
            self.assertEqual(budget['bytes'],receipt['dataStorage']['journal']['bytes'])

    def test_observation_journal_accepts_exact_row_limit_and_refuses_one_more_after_pinned_read(self):
        with tempfile.TemporaryDirectory() as raw, diagnostic_files_as_controller():
            config,directory,receipt,final,unused,worker,commit,save=observation_fixture(Path(raw).resolve())
            rows=[];previous=None
            for sequence in range(8193):
                row={'sequence':sequence,'previous':previous,'key':'host-journal-watchdog','boundary':'initial' if sequence==0 else 'periodic','startedMs':sequence*2,'endedMs':sequence*2+1,'bytes':0,'observation':{'bytes':0,'meaning':'Journal watchdog only; actual host audit owns accounting'},'error':None}
                row=observation_test_reseal_sample(row);previous=row['hash'];rows.append(row)
            for count in (8192,8193):
                changed=copy.deepcopy(rows[:count]);changed[-1]['boundary']='final';changed[-1]=observation_test_reseal_sample(changed[-1]);observation_test_bind_summaries(final,changed)
                final['dataSummary']['status']='INCONCLUSIVE';final['dataReplay']['status']='FAIL'
                for summary in (final['dataSummary'],final['dataReplay']):
                    for scope in summary['scopes']:
                        if scope['key']=='host-journal-watchdog':scope.update(status='PASS',coverageComplete=True,maximumStartGapMs=2,maximumPossibleObservationStartGapMs=3,peakBytes=0,samples=count,unknownSamples=0)
                        else:scope.update(status='INCONCLUSIVE',coverageComplete=False,maximumStartGapMs=None,maximumPossibleObservationStartGapMs=None,peakBytes=None,samples=0,unknownSamples=0)
                commit(changed)
                storage=receipt['dataStorage'];self.assertLess(storage['journal']['bytes'],8*1024**2);self.assertEqual((directory/'data-observations.jsonl').read_bytes().count(b'\n'),count);budget={'bytes':0}
                if count==8192:
                    result=subject.diagnostic_journal(config,directory,storage,final['dataSummary'],final['dataReplay'],'c'*64,budget)
                    self.assertEqual((result['status'],result['records'],result['eligibleObservations']),('projected',8192,0));self.assertFalse(result['rawStorageVerified'])
                else:
                    with self.assertRaisesRegex(ValueError,'^Diagnostic journal framing/row bound$'):
                        subject.diagnostic_journal(config,directory,storage,final['dataSummary'],final['dataReplay'],'c'*64,budget)
                self.assertEqual(budget['bytes'],storage['journal']['bytes'])

    def test_observation_stream_exact_limits_and_one_byte_refusals_precede_worker_parsing(self):
        with tempfile.TemporaryDirectory() as raw:
            config,directory,receipt,final,rows,worker,commit,save=observation_fixture(Path(raw).resolve())
            original=subject.diagnostic_worker
            for stream,limit in (('stdoutBase64',65536),('stderrBase64',16384)):
                with self.subTest(stream=stream):
                    command=copy.deepcopy(rows[0]);payload=observation_test_json(worker) if stream=='stdoutBase64' else b'S'
                    payload+=b' '*(limit-len(payload));command[stream]=base64.b64encode(payload).decode()
                    with mock.patch.object(subject,'diagnostic_worker',wraps=original) as parse:
                        result=subject.diagnostic_observation(command,config,'c'*64);self.assertEqual(parse.call_count,1)
                    self.assertEqual(result['worker']['attempts'][0]['errors'][0]['errno'],13)
                    if stream=='stderrBase64':self.assertEqual(result['stderr']['retainedBytes'],16384)
                    command[stream]=base64.b64encode(payload+b' ').decode()
                    with mock.patch.object(subject,'diagnostic_worker',wraps=original) as parse:
                        with self.assertRaisesRegex(ValueError,'^Observation stream bounds differ$'):subject.diagnostic_observation(command,config,'c'*64)
                        parse.assert_not_called()


    def test_mutation_diagnostic_flows_through_exact_failed_journal_without_raw_authority(self):
        with tempfile.TemporaryDirectory() as raw, diagnostic_files_as_controller():
            config,directory,receipt,final,rows,worker,commit,save=observation_fixture(Path(raw).resolve())
            detail={'category':'child-after-walk-stat','statChanges':[{'field':'st_size','before':'1','after':'2'},{'field':'st_ctime_ns','before':'-9223372036854775808','after':'9223372036854775807'}]}
            worker['attempts'][0]['errors'][0].update(code='EVIDENCE_MUTATION',errno=None,mutation=detail)
            worker=observation_test_reseal_worker(worker);rows[0]['stdoutBase64']=base64.b64encode(observation_test_json(worker)+b'\n').decode();commit(rows)
            budget={'bytes':0};value=subject.phase_diagnostic(config,'toolchain','c'*64,budget)
            journal=value['accounting']['journal'];actual=journal['observations'][0]['observationCommand']['worker']['attempts'][0]['errors'][0]
            self.assertEqual(actual,{'code':'EVIDENCE_MUTATION','errno':None,'member':'/capsule/toolchain','mutation':detail})
            self.assertEqual((journal['retainedObservations'],journal['omittedObservations'],journal['refusals']),(1,0,0))
            self.assertFalse(journal['rawStorageVerified']);self.assertFalse(value['timingLockReleased']);self.assertEqual(value['accounting']['summary']['declaredStatus'],'FAIL')
            self.assertGreaterEqual(budget['bytes'],receipt['dataStorage']['journal']['bytes'])
            for forbidden in ('c'*64,'--grant','"argv"','"environment"','/fixed-owned-data','stdoutBase64'):self.assertNotIn(forbidden,json.dumps(value))

    def test_mutation_projection_distinguishes_absent_and_unavailable_differences(self):
        with tempfile.TemporaryDirectory() as raw:
            config,directory,receipt,final,rows,worker,commit,save=observation_fixture(Path(raw).resolve())
            legacy=subject.diagnostic_worker(observation_test_json(worker),config,'c'*64)
            self.assertNotIn('mutation',legacy['attempts'][0]['errors'][0])
            for category in ('filesystem-operation','directory-enumeration','duplicate-directory-name','directory-membership','directory-children-digest'):
                changed=copy.deepcopy(worker);changed['attempts'][0]['errors'][0].update(code='EVIDENCE_MUTATION',mutation={'category':category,'statChanges':None})
                changed=observation_test_reseal_worker(changed);value=subject.diagnostic_worker(observation_test_json(changed),config,'c'*64)
                self.assertEqual(value['attempts'][0]['errors'][0]['mutation'],{'category':category,'statChanges':None})
                changed['attempts'][0]['errors'][0]['mutation']['statChanges']=[];changed=observation_test_reseal_worker(changed)
                with self.assertRaisesRegex(ValueError,'^Mutation diagnostic unavailable differences required$'):subject.diagnostic_worker(observation_test_json(changed),config,'c'*64)

    def test_mutation_projection_rejects_unknown_category_extra_fields_and_nonmutation(self):
        with tempfile.TemporaryDirectory() as raw:
            config,directory,receipt,final,rows,worker,commit,save=observation_fixture(Path(raw).resolve())
            details=[{'category':'c'*64,'statChanges':None},{'category':'directory-membership','statChanges':None,'path':'/private/secret'},{'category':None,'statChanges':None}]
            for detail in details:
                changed=copy.deepcopy(worker);changed['attempts'][0]['errors'][0].update(code='EVIDENCE_MUTATION',mutation=detail);changed=observation_test_reseal_worker(changed)
                with self.assertRaisesRegex(ValueError,'^Mutation diagnostic category differs$'):subject.diagnostic_worker(observation_test_json(changed),config,'c'*64)
            changed=copy.deepcopy(worker);changed['attempts'][0]['errors'][0]['mutation']={'category':'directory-membership','statChanges':None};changed=observation_test_reseal_worker(changed)
            with self.assertRaisesRegex(ValueError,'^Mutation diagnostic on nonmutation error$'):subject.diagnostic_worker(observation_test_json(changed),config,'c'*64)

    def test_mutation_projection_numeric_bounds_and_no_opaque_stat_content(self):
        with tempfile.TemporaryDirectory() as raw:
            config,directory,receipt,final,rows,worker,commit,save=observation_fixture(Path(raw).resolve())
            valid={'field':'st_size','before':'1','after':'2'}
            rows_to_reject=[{**valid,'after':'c'*64},{**valid,'after':2},{**valid,'after':'02'},{**valid,'after':'-0'},{**valid,'after':'-1'},{**valid,'after':'9007199254740992'},{**valid,'after':'1'},{**valid,'field':'/private/secret'},{**valid,'path':'/private/secret'},{'field':'st_ctime_ns','before':'0','after':'9223372036854775808'},{'field':'st_mtime_ns','before':'0','after':'-9223372036854775809'}]
            for bad in rows_to_reject:
                with self.subTest(bad=bad):
                    changed=copy.deepcopy(worker);changed['attempts'][0]['errors'][0].update(code='EVIDENCE_MUTATION',mutation={'category':'child-after-walk-stat','statChanges':[bad]});changed=observation_test_reseal_worker(changed)
                    with self.assertRaisesRegex(ValueError,'^Mutation diagnostic (integer differs|integer range|unchanged field|field differs)$'):subject.diagnostic_worker(observation_test_json(changed),config,'c'*64)

    def test_mutation_projection_rejects_empty_duplicate_out_of_order_and_oversized_fields(self):
        with tempfile.TemporaryDirectory() as raw:
            config,directory,receipt,final,rows,worker,commit,save=observation_fixture(Path(raw).resolve())
            row={'field':'st_size','before':'1','after':'2'};later={'field':'st_blocks','before':'1','after':'2'}
            for changes in (None,[],[row,row],[later,row],[row]*11):
                changed=copy.deepcopy(worker);changed['attempts'][0]['errors'][0].update(code='EVIDENCE_MUTATION',mutation={'category':'child-after-walk-stat','statChanges':changes});changed=observation_test_reseal_worker(changed)
                with self.assertRaisesRegex(ValueError,'^Mutation diagnostic (differences bound|fields unordered)$'):subject.diagnostic_worker(observation_test_json(changed),config,'c'*64)


    def synchronization_fixture(self):
        return {'policy':'hosted-toolchain-quiescent-inodes-1','groupIdentity':{'dev':3,'ino':7},'startedMs':0,'freezeRequestedMs':0.2,'frozenMs':0.4,'scanStartedMs':0.5,'scanEndedMs':2.1,'thawRequestedMs':2.2,'thawedMs':2.4,'endedMs':2.5,'members':[{'pid':100+i,'start':str(1000+i)} for i in range(20)],'frozenEvents':{'populated':1,'frozen':1},'afterScanEvents':{'populated':1,'frozen':1},'thawedEvents':{'populated':1,'frozen':0},'failure':{'code':'FREEZER_WINDOW_EXCEEDED'},'cleanupFailure':None}

    def test_toolchain_synchronization_failure_projects_through_real_retained_journal(self):
        with tempfile.TemporaryDirectory() as raw, diagnostic_files_as_controller():
            config,directory,receipt,final,rows,worker,commit,save=observation_fixture(Path(raw).resolve())
            rows[0]['synchronization']=self.synchronization_fixture();rows[0]['result']['timeoutMs']=1990;commit(rows)
            value=subject.phase_diagnostic(config,'toolchain','c'*64,{'bytes':0})
            command=value['accounting']['journal']['observations'][0]['observationCommand'];detail=command['synchronization']
            self.assertEqual(command['result']['timeoutMs'],1990);self.assertEqual(detail['membersCount'],20);self.assertEqual(len(detail['members']),16);self.assertEqual(detail['omittedMembers'],4)
            self.assertEqual(detail['failure'],{'code':'FREEZER_WINDOW_EXCEEDED'});self.assertFalse(detail['qualification']);self.assertFalse(value['timingLockReleased'])
            for forbidden in ('c'*64,'--grant','"argv"','"environment"','/fixed-owned-data','stdoutBase64'):self.assertNotIn(forbidden,json.dumps(value))

    def test_toolchain_synchronization_projection_preserves_unobserved_fields_and_old_timeout_contract(self):
        value=self.synchronization_fixture();value.update(members=None,frozenEvents=None,afterScanEvents=None,thawedEvents=None,frozenMs=None,scanStartedMs=None,scanEndedMs=None,thawRequestedMs=None,thawedMs=None)
        projected=subject.diagnostic_synchronization(value);self.assertIsNone(projected['members']);self.assertIsNone(projected['membersCount']);self.assertIsNone(projected['omittedMembers']);self.assertIsNone(projected['thawedMs'])
        with tempfile.TemporaryDirectory() as raw:
            config,directory,receipt,final,rows,worker,commit,save=observation_fixture(Path(raw).resolve());command=rows[0]
            self.assertNotIn('synchronization',subject.diagnostic_observation(command,config,'c'*64))
            command['result']['timeoutMs']=1990
            with self.assertRaisesRegex(ValueError,'^Observation timeout differs$'):subject.diagnostic_observation(command,config,'c'*64)
            command['synchronization']=value
            for timeout in (0,2001,True):
                command['result']['timeoutMs']=timeout
                with self.assertRaisesRegex(ValueError,'^Observation timeout differs$'):subject.diagnostic_observation(command,config,'c'*64)

    def test_toolchain_synchronization_projection_refuses_opaque_fields_unbounded_members_and_false_zero(self):
        changes=[('path','/private/secret'),('policy','other'),('failure',{'code':'c'*64}),('cleanupFailure',{'code':'X','path':'/private/secret'}),('startedMs',float('nan')),('groupIdentity',{'dev':True,'ino':7}),('members',[{'pid':1,'start':'2'}]*4097),('members',[{'pid':1,'start':'2'},{'pid':1,'start':'3'}]),('members',[{'pid':1,'start':'x'*21}]),('frozenEvents',{'populated':False,'frozen':1})]
        for key,changed in changes:
            value=self.synchronization_fixture();value[key]=changed
            with self.assertRaises(ValueError):subject.diagnostic_synchronization(value)


suite=unittest.defaultTestLoader.loadTestsFromTestCase(Boundaries)
result=unittest.TextTestRunner(verbosity=2).run(suite)
print(json.dumps({'tests':result.testsRun,'failures':len(result.failures),'errors':len(result.errors)}))
sys.exit(0 if result.wasSuccessful() else 1)
