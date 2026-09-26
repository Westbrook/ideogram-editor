from pathlib import Path
import hashlib,json
b=Path(__file__).resolve().parent;r=b.parent.parent
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
load=lambda n:json.loads((b/n).read_text())
seals={}
for line in (b/'SHA256SUMS').read_text().splitlines():
 h,p=line.split('  ',1);assert p not in seals and not Path(p).is_absolute() and '..' not in Path(p).parts;assert sha(b/p)==h,p;seals[p]=h
actual={p.relative_to(b).as_posix() for p in b.rglob('*') if p.is_file() and p!=b/'SHA256SUMS' and '__pycache__' not in p.parts};assert actual==set(seals),actual^set(seals)
code=load('CODE-INPUTS.json')
for group in ['runtimeSource','verificationCode']:
 for p,h in code[group].items():assert sha(r/p)==h,(group,p)
assert hashlib.sha256(json.dumps(code['runtimeSource'],sort_keys=True,separators=(',',':')).encode()).hexdigest()==code['runtimeSourceSHA256']
assert all(not p.endswith('browser.json') for p in code['verificationCode'])
for x in load('OBSERVATION-MAPPING.json')['entries']:assert seals[x['packagePath']]==x['sha256']
for x in load('BUILD-REUSE.json')['entries']:assert sha(r/x['checkoutPath'])==x['sha256']
p=load('PRIOR-EVIDENCE.json');assert sha(b/'prior-ecc/SHA256SUMS')==p['sealSHA256'];idx={s.split('  ',1)[1]:s.split('  ',1)[0] for s in (b/'prior-ecc/SHA256SUMS').read_text().splitlines()}
assert len(idx)==p['fullSealedFileCount']
for name in p['selected']:
 if name!='SHA256SUMS':assert sha(b/'prior-ecc'/name)==idx[name]
assert not load('CREDENTIAL-SCAN.json')['actualLookingValues']
# E1 proof for all three final gates, independent of reporter PASS counts.
for name in ['10-webkit-full','11-chromium-affected','12-firefox-affected']:
 ledger=load('receipts/'+name+'/e1-storage.json')['ledger'];assert ledger[0]['initialCookieCount']==0
 pre=[e for e in ledger if e['phase']=='preflight'];ad=[e for e in ledger if e['phase']=='admitted'];created=[e for e in ledger if e['phase']=='created'];removed=[e for e in ledger if e['phase']=='removed']
 assert len(pre)==len(ad)==len(created)==len(removed)==3
 assert len({e['origin'] for e in ad})==3
 assert all(e['entries']==[] and e['localStorage']==0 and e['cookies']==0 and e['indexedDB']==[] for e in pre)
 assert {(e['origin'],e['name']) for e in created}=={(e['origin'],e['name']) for e in removed}
 assert all(e['exactHandle'] and e['absent'] for e in removed)
 assert all(e['phase']!='cleanup-incomplete' and (e['phase']!='cleanup' or e['remaining']==[]) for e in ledger)
print(json.dumps({'result':'AUTHOR offline integrity PASS; not independent approval','seals':len(seals),'runtimeInputs':len(code['runtimeSource']),'verificationCodeInputs':len(code['verificationCode']),'observations':len(load('OBSERVATION-MAPPING.json')['entries']),'reusedBuildFiles':len(load('BUILD-REUSE.json')['entries']),'sourceCommit':code['sourceCommit'],'runtimeSourceSHA256':code['runtimeSourceSHA256']},indent=2))
