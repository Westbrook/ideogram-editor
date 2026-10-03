#!/usr/bin/env python3
"""Fixed unit controls / unprivileged Linux smoke. Never contacts a destination."""
import ctypes
import errno
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile

ROOT=Path(__file__).resolve().parents[3]
def load(name):
    path=ROOT/'tooling/rollback-producer'/name
    spec=importlib.util.spec_from_file_location('test_'+name.replace('.','_'),path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

def must_fail(action):
    try:action()
    except ValueError:return
    raise AssertionError('Expected refusal')

def controls():
    worker=load('hosted-worker.py'); exporter=load('hosted-export.py')
    worker.admit_descriptor_targets([(0,'/dev/null'),(1,'socket:[11]'),(2,'socket:[12]'),(3,'pipe:[13]')])
    must_fail(lambda:worker.admit_descriptor_targets([(0,'/dev/null'),(3,'socket:[14]')]))
    must_fail(lambda:worker.admit_descriptor_targets([(4,'socket:[15]')]))
    must_fail(lambda:worker.admit_descriptor_targets([(1,'pipe:[11]'),(1,'pipe:[12]')]))
    ref=lambda name:{'path':'/data/'+name,'hash':'sha256:'+'a'*64,'byteLength':'1'}
    draft={'sourceArchive':ref('source.tar.gz'),'sourceManifest':ref('source.json'),'sourceInput':ref('source-input.json'),'compiledClosures':[{'archive':ref('runtime.tar.gz'),'manifest':ref('runtime.json')}],'seedClosure':{'archive':ref('seed.tar.gz'),'manifest':ref('seed.json')},'commands':[{'log':ref('build.log'),'receipt':ref('build.log.receipt.json')}],'seedObservation':ref('seed-observation.json')}
    draft_ref={'path':'/data/outputs/build16/draft.json','bytes':123,'sha256':'a'*64}
    assert exporter.carried_draft_refs({'carried':{'drafts':{'16':draft_ref},'packets':{}}})==[draft_ref]
    refs=exporter.document_refs(draft);assert len(refs)==10 and {Path(x['path']).name for x in refs}=={'source.tar.gz','source.json','source-input.json','runtime.tar.gz','runtime.json','seed.tar.gz','seed.json','build.log','build.log.receipt.json','seed-observation.json'}
    content={'path':'sha256/aa/'+'a'*64,'hash':'sha256:'+'a'*64,'byteLength':'1'}
    assert exporter.document_refs({'retained':{'objects':[content]}})==[]
    must_fail(lambda:exporter.document_refs({'wrong':[content]}))
    must_fail(lambda:exporter.document_refs({'bad':ref('../escape')}))
    with tempfile.TemporaryDirectory(prefix='hosted-export-selection-') as temp:
        root=Path(temp); (root/'logs').mkdir();(root/'source').mkdir();(root/'mutable-workspace').mkdir()
        for name in ('logs/typecheck.log','logs/typecheck.log.control.json','logs/typecheck.log.receipt.json','failure-'+'a'*32+'.json','source/payload.tar.gz','source/manifest.json','mutable-workspace/not-selected.txt'):(root/name).write_text('retained')
        actual={str(path.relative_to(root)) for path in exporter.diagnostic_members(root,'build16')}
        assert actual=={'logs/typecheck.log','logs/typecheck.log.control.json','logs/typecheck.log.receipt.json','failure-'+'a'*32+'.json','source/payload.tar.gz','source/manifest.json'}
        (root/'logs/unexpected-socket').symlink_to('/dev/null');must_fail(lambda:exporter.diagnostic_members(root,'build16'))
    setup={'run':11,'attempt':2,'controlHead':'b'*40};config={'controlRoot':'/opt/control','exportRoot':'/opt/ideogram-native-export-11-2/ie-native-'+'a'*32}
    allowed={'first-step-original.json':'/opt/ideogram-native-job-11-2.json',**{name:'/opt/control/meta/'+name for name in exporter.SETUP_METADATA},**{'commands/'+label+suffix:'/opt/control/meta/setup-commands/'+label+suffix for label in exporter.SETUP_LABELS for suffix in ('.json','.stdout','.stderr')}}
    rows=[{'source':{'path':origin,'bytes':1,'sha256':'c'*64},'copy':{'path':'/opt/ideogram-native-export-11-2/setup/'+name,'bytes':1,'sha256':'c'*64}} for name,origin in allowed.items()]
    inventory={'kind':'hosted-native-unmeasured-setup-export-1','run':11,'attempt':2,'head':'b'*40,'setupSuccessful':True,'setupOwnedProcessGroupsAbsent':True,'setupMeasured':False,'qualification':False,'payloadFilesCopied':False,'originalsChanged':False,'maximumBytes':64*1024**2,'regularBytes':len(rows),'files':rows,'omitted':[]}
    assert exporter.setup_export_entries(inventory,setup,config)==rows
    for change in ('identity','path','hash','bytes','extra'):
        bad=json.loads(json.dumps(inventory))
        if change=='identity':bad['head']='d'*40
        elif change=='path':bad['files'][0]['copy']['path']='/elsewhere/setup/first-step-original.json'
        elif change=='hash':bad['files'][0]['copy']['sha256']='d'*64
        elif change=='bytes':bad['regularBytes']+=1
        else:bad['files'].append(bad['files'][0])
        must_fail(lambda:exporter.setup_export_entries(bad,setup,config))
    print(json.dumps({'descriptorControls':True,'draftBeforeVerifySelected':True,'failedBuildDiagnosticsSelected':True,'workspaceExcluded':True,'setupAggregateBinding':True}))

def prctl(option,arg=0):
    libc=ctypes.CDLL(None,use_errno=True);call=libc.prctl;call.argtypes=[ctypes.c_int,ctypes.c_ulong,ctypes.c_ulong,ctypes.c_ulong,ctypes.c_ulong];call.restype=ctypes.c_int
    result=call(option,arg,0,0,0);assert result>=0;return result

def denied_socket(family):
    try:
        value=socket.socket(family,socket.SOCK_STREAM);value.close()
    except OSError as error:assert error.errno==errno.EPERM;return
    raise AssertionError('Socket unexpectedly admitted')

def observed_denials():
    assert prctl(39)==1 and prctl(21)==2
    denied_socket(socket.AF_INET);denied_socket(socket.AF_UNIX)
    libc=ctypes.CDLL(None,use_errno=True);libc.syscall.restype=ctypes.c_long
    # Invalid/no destination arguments: seccomp must deny before the syscall.
    for number in (42,425,426,427):
        ctypes.set_errno(0);result=libc.syscall(ctypes.c_long(number),ctypes.c_long(-1),ctypes.c_long(0),ctypes.c_long(0),ctypes.c_long(0),ctypes.c_long(0),ctypes.c_long(0))
        assert result==-1 and ctypes.get_errno()==errno.EPERM,(number,result,ctypes.get_errno())
    left,right=socket.socketpair(socket.AF_UNIX,socket.SOCK_STREAM,0)
    try:left.sendall(b'fixed-local-ipc');assert right.recv(64)==b'fixed-local-ipc'
    finally:left.close();right.close()
    try:
        left,right=socket.socketpair(socket.AF_UNIX,socket.SOCK_DGRAM,0);left.close();right.close()
    except OSError as error:assert error.errno==errno.EPERM
    else:raise AssertionError('Readdressable datagram pair admitted')

def smoke(inherited=False):
    assert sys.platform=='linux' and os.getuid()!=0,'Unprivileged Linux smoke required'
    if not inherited:
        assert prctl(38,1)==0;installed=load('hosted-offline.py').install();assert installed['installed'] is True
    observed_denials()
    if not inherited:
        child=subprocess.run([sys.executable,'-I','-S','-B',str(Path(__file__).resolve()),'--inherited'],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=10,check=False)
        assert child.returncode==0,child.stderr.decode();assert json.loads(child.stdout)['inheritedExecVerified'] is True
    print(json.dumps({'kernelFilterInstalled':not inherited,'inheritedExecVerified':inherited,'socketDenials':True,'anonymousStreamIPC':True,'externalDestinationsUsed':0}))

assert sys.flags.isolated and sys.flags.no_site and sys.dont_write_bytecode and not sys.flags.optimize
if sys.argv[1:]==['--controls']:controls()
elif sys.argv[1:]==['--smoke']:smoke()
elif sys.argv[1:]==['--inherited']:smoke(True)
else:raise ValueError('Fixed test action required')
