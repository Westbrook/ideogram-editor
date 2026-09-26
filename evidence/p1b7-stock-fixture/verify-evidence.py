from pathlib import Path
import hashlib,json,sys
base=Path(__file__).resolve().parent;repo=base.parent.parent
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
load=lambda p:json.loads(p.read_text())
seals={}
for line in (base/'SHA256SUMS').read_text().splitlines():
 h,p=line.split('  ',1);assert p not in seals and not Path(p).is_absolute() and '..' not in Path(p).parts;assert sha(base/p)==h,p;seals[p]=h
actual={p.relative_to(base).as_posix() for p in base.rglob('*') if p.is_file() and p.name!='SHA256SUMS' and '__pycache__' not in p.parts};assert actual==set(seals),actual^set(seals)
code=load(base/'CODE-INPUTS.json')
for group in ['runtimeSource','verificationCode']:
 for p,h in code[group].items():assert sha(repo/p)==h,(group,p)
assert hashlib.sha256(json.dumps(code['runtimeSource'],sort_keys=True,separators=(',',':')).encode()).hexdigest()==code['runtimeSourceSHA256']
assert not any(p.endswith('browser.json') for p in code['verificationCode'])
entries=load(base/'ARTIFACT-MAPPING.json')['entries'];mapping={e['logicalPath']:e for e in entries};assert len(mapping)==len(entries)
for e in entries:
 assert seals[e['object']]==e['sha256'];assert (base/e['object']).stat().st_size==e['bytes'];assert e['object']=='objects/'+e['sha256']
assert {e['object'] for e in entries}=={p for p in seals if p.startswith('objects/')}
def artifact(name):return base/mapping[name]['object']
assert not load(base/'CREDENTIAL-SCAN.json')['actualLookingValues']
for name in ['25-webkit-combined','26-chromium-combined','27-firefox-combined']:
 command=load(artifact('stock-reset-author/'+name+'/command.json'));assert command['exit']==0;assert command['source']['src/state/destination.ts']==code['runtimeSource']['src/state/destination.ts']
 for f in ['owned-opfs.ts','portable.spec.ts','error-monitor.ts','error-monitor.spec.ts','shutdown-console.ts']:
  p='tests/editor/'+f;assert command['source'][p]==code['verificationCode'][p]
 ledger=load(artifact('stock-reset-author/'+name+'/e1-storage.json'))['ledger']
 assert ledger[0]['contract']=='controlled-origin-v2'
 assert len([e for e in ledger if e['phase']=='admitted'])==3
 assert [e for e in ledger if e['phase']=='initial-cookies'][0]['count']==0
 assert len([e for e in ledger if e['phase']=='public-reset'])==1
 post=[e for e in ledger if e['phase']=='post-reset'];assert len(post)==3
 assert all(e['entries']==[] and e['localStorage']==0 and e['indexedDB']==[] and e['serviceWorkers']==0 for e in post)
 assert ledger[-1]['phase']=='cleanup-complete' and not any(e['phase']=='refused' for e in ledger)
 assert [e for e in ledger if e['phase']=='post-reset-cookies'][0]['count']==0
 e1=load(artifact('stock-reset-author/'+name+'/e1.json'));assert e1['exactPixels'] and e1['externalDestination']=='unconfirmed' and all(v==0 for v in e1['providerEffects'].values())
 errors=load(artifact('stock-reset-author/'+name+'/e1-console.json'));assert errors['domErrors']==[];assert all(e['expected'] for e in errors['pageErrors']);assert all(e['expected'] for e in errors['observations'])
for name in ['29-chromium-cleanup-entry','31-webkit-destination-final','32-firefox-destination-final']:
 assert load(artifact('stock-reset-author/'+name+'/command.json'))['exit']==0
 result=load(artifact('stock-reset-author/'+name+'/native-destination.json'));assert result['errors']==result['domErrors']==[];assert result['ledger'][-1]['phase']=='cleanup-complete'
life=load(artifact('stock-blob-lifetime-author/v2/observations.json'));assert life['pass']==False and len(life['cases'])==3 and all(c['pass']==False for c in life['cases'])
prior=(artifact('prior-4fe/SHA256SUMS')).read_text();idx={s.split('  ',1)[1]:s.split('  ',1)[0] for s in prior.splitlines()};assert len(idx)==72
for e in entries:
 if e['logicalPath'].startswith('prior-4fe/') and e['logicalPath'].split('/')[-1] not in ['SHA256SUMS','closing-receipt.json']:assert e['sha256']==idx[e['logicalPath'].split('/')[-1]]
if len(sys.argv)>1:
 if sys.argv[1]=='--list':print('\n'.join(mapping));sys.exit()
 if sys.argv[1]=='--show':sys.stdout.buffer.write(artifact(sys.argv[2]).read_bytes());sys.exit()
 if sys.argv[1]=='--extract':
  with Path(sys.argv[3]).open('xb') as f:f.write(artifact(sys.argv[2]).read_bytes())
  sys.exit()
 raise SystemExit('Use --list, --show LOGICAL_PATH, or --extract LOGICAL_PATH NEW_FILE')
print(json.dumps({'result':'AUTHOR offline integrity and receipt-consistency PASS; not independent functional approval','seals':len(seals),'mappedFiles':len(entries),'objects':len({e['object'] for e in entries}),'runtimeInputs':len(code['runtimeSource']),'verificationCodeInputs':len(code['verificationCode']),'sourceCommit':code['sourceCommit'],'runtimeSourceSHA256':code['runtimeSourceSHA256']},indent=2))
