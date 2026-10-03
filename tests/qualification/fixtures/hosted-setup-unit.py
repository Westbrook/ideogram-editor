"""Pure setup admission and real filesystem refusals; never invokes setup."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('hosted_setup_test_subject', sys.argv.pop())
subject = importlib.util.module_from_spec(spec); spec.loader.exec_module(subject)
HEAD = 'b'*40
FIRST = subject.utc_ms('2026-10-03T12:00:01Z')

def job_response():
    return {'total_count':1,'jobs':[{'name':'native-prerequisites','run_id':123,'run_attempt':2,'head_sha':HEAD,'status':'in_progress','conclusion':None,'id':999,'started_at':'2026-10-03T12:00:00Z'}]}

def closed(phase, outcome='PASS', released=True):
    return {'kind':'hosted-native-phase-finalization-1','phase':phase,'effectiveOutcome':outcome,'timingLockReleased':released}

class Boundaries(unittest.TestCase):
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
