import json,hashlib,shutil,base64,datetime,subprocess
from pathlib import Path
root=Path(__file__).resolve().parent;repo=Path('/Users/westbrook/Documents/repos/ideogram-edit');source=root/'source';out=repo/'evidence/p1c2-text-verifier-final';out.mkdir()
sha=lambda b:hashlib.sha256(b).hexdigest()
def save(name,obj):(out/name).write_text(json.dumps(obj,indent=2)+'\n')
def cp(src,name):
 p=out/name;p.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(src,p)
receipts=[]
for f in sorted(root.glob('*.receipt.json')):
 if 24<=int(f.name[:2])<=44:
  cp(f,f.name);cp(f.with_name(f.name.replace('.receipt.json','.log')),f.name.replace('.receipt.json','.log'));receipts.append(json.loads(f.read_text()))
for f in ['audit-final-v1.py','assemble-final-v1.py','run.py','final-source-reuse.json','controls-v1.mjs','controls-correction-v2.mjs','controls-additive-v2.mjs','compatibility-v1.mjs','compatibility-text-v1.mjs','legacy-text-fixture-v1.py']:cp(root/f,f)
for directory in ['equivalence-webkit-v1','equivalence-firefox-v1','equivalence-chromium-v2','controls-final-chromium','controls-additive-final-chromium','compatibility','compatibility-text-v1']:
 for f in (root/directory).glob('*.json'):cp(f,'results/'+directory+'/'+f.name)
cp(root/'legacy-text-v1/controls-chromium/all-history.ideogram-project','historical/valid-b895.ideogram-project')
cp(root/'legacy-text-v1/controls-chromium/plain-candidate.json','historical/plain-b895-candidate.json')
cp(root/'legacy-text-v1/controls-chromium/results.json','historical/fixture-results.json')
cp(root/'legacy-text-v1/source-inputs.json','historical/source-inputs.json')
cp(root/'legacy-text-v1/valid-fixture-v1.mjs','historical/valid-fixture-v1.mjs')
cp(Path('/Users/westbrook/Documents/repos/ideogram-edit-p1c2-review-648a35a-20260926T222408Z/controls-chromium/all-history.ideogram-project'),'historical/rejected-648-malformed.ideogram-project')
cp(root/'compatibility-text-v1/b895-reexport.ideogram-project','historical/current-b895-reexport.ideogram-project')
cp(source/'artifacts/correction-stock-01/receipt/results.json','stock-results.json')
stock=json.loads((out/'stock-results.json').read_text());clean=[]
def walk(v):
 if isinstance(v,dict):
  if v.get('name')=='native-worker-cleanup':clean.append(json.loads(base64.b64decode(v['body'])))
  else:
   for x in v.values():walk(x)
 elif isinstance(v,list):
  for x in v:walk(x)
walk(stock);assert len(clean)==3
for x in clean:assert x['outcome']=='clean' and all(w['closed'] for w in x['workers']) and len([v for v in x['ledger'] if v['phase']=='public-reset'])==1
save('stock-cleanup-decoded.json',clean)
artifacts={}
for directory in ['dist','artifacts/p1c2/app','artifacts/correction-stock-01/artifacts/p1c1/app']:
 for f in (source/directory).rglob('*'):
  if f.is_file():artifacts[str(f.relative_to(source))]={'bytes':f.stat().st_size,'sha256':sha(f.read_bytes())}
save('built-artifacts.json',artifacts)
inputs=json.loads((root/'final-source-reuse.json').read_text())['testedCheckoutExactInputs'];bindings={}
for f in sorted(root.glob('*.sources.json')):
 if 24<=int(f.name[:2])<=44:
  hashes=json.loads(f.read_text());mismatch=[p for p,v in inputs.items() if p in hashes and hashes[p]!=v['sha256']]
  bindings[f.name]={'fullExternalInventory':str(f),'fullInventorySHA256':sha(f.read_bytes()),'presentInputs':len([p for p in inputs if p in hashes]),'differentFromFinalInputs':mismatch,'absentFinalInputs':[p for p in inputs if p not in hashes],'changedInputs':{p:hashes[p] for p in mismatch}}
save('gate-source-bindings.json',bindings)
save('command-ledger.json',receipts)
helper=(root/'compatibility-text-v1.mjs').read_text().replace("resolve('../compatibility-text-v1')","resolve('../compatibility-text-reverify-v2')").replace("'../legacy-text-v1/controls-chromium/all-history.ideogram-project'","'evidence/p1c2-text-verifier-final/historical/valid-b895.ideogram-project'").replace("'../legacy-text-v1/controls-chromium/plain-candidate.json'","'evidence/p1c2-text-verifier-final/historical/plain-b895-candidate.json'").replace("'/Users/westbrook/Documents/repos/ideogram-edit-p1c2-review-648a35a-20260926T222408Z/controls-chromium/all-history.ideogram-project'","'evidence/p1c2-text-verifier-final/historical/rejected-648-malformed.ideogram-project'")
(out/'compatibility-text-reverify-v2.mjs').write_text(helper)
result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':'AUTHOR_COMPLETE_FOR_INDEPENDENT_REVIEW','task':'51dd7267-8759-49f3-8fa0-cc7414a05ecd','branch':'ideogram-editor-p1','sourceCommit':'e9ff85681c6ae2ff71a8c094ca237059d685d8dd','rejectedBase':'648a35abce7c2a91e90c132c38b6868f2790e5a1','partialCheckpoint':'f8f936dc9195c3c32c8f6dff77110fdd5fa8c6c6','profile':json.loads((repo/'src/text/profile.json').read_text())['id'],'externalRoot':str(root),'gates':{'26-28':'Each11 exact differential PASS WebKit/Firefox/Chromium including mixed scripts/FEFF; each11 close/11 exit/0 reset and11 pre-worker excess refusals','31':'Admission/supervisor4 PASS, actual decision operands with synthetic excess-owner controls explicitly labeled','32':'Full durable native3 PASS; each8 actual browser workers/8 closes','33':'Original reviewer7 unchanged-meaning controls PASS','34':'Additive8 PASS including same-fill consistent substitution; distinct invocation not15 unique cases','35-38':'Types, full build, text and CP-1 seals PASS','39':'Actual648 valid historical b895 fixture produced from exact archived source, plain/NFD only; not reapproval of648','40':'Valid b895 full-history import/reexport/reopen exact source/appearance; original malformed648 archive refused','41':'Actual dcd PF2 import/current PF3 reexport PASS; copied helper old target literal is preserved but does NOT identify executed current source','42':'Unchanged stock42 PASS; actual cleanup decoded separately','43':'Exact affected44-file command519 PASS','44':'453 Git/disk/tested inputs equal;48 native/recipe/font/contract dependencies unchanged from accepted foundation; browser loader unchanged; shared algorithm exact after documented identity parameter/extraction'},'retainedFailures':['Original648 criterion3 rejection and independent seal untouched','Partial01-23 receipts and failures06/15/19/22/23 retained in prior evidence directory','29 admission test fixture lacked assets.id;30 fixture failed private path checks;31 corrected test-only setup passes','Original unknown marker/profile and no-reset failures preserved; later passes are not causal proof'],'limits':['AUTHOR only; independent re-review, acceptance and credit pending','Native reproduction reused from approved dcd; changed host/core/admission/storage freshly tested, not inherited approval','No cap increase, GC or RSS refund, new toolchain/service/UI/downstream change; A-R01 open','Full source hashes per gate remain external; not all intermediate source file contents archived','Reverify-v2 historical helper only changes archived input/output paths, is supplied for fresh re-verification and was not separately executed','No GitHub remote, PR URL/number or CI runs; no pre-existing CI failure invented'],'sourceInputCount':len(inputs),'builtArtifactCount':len(artifacts)}
save('FINAL.json',result)
print(json.dumps({'evidence':str(out),'receipts':len(receipts),'inputs':len(inputs),'artifacts':len(artifacts),'bindingDifferences':{k:v['differentFromFinalInputs'] for k,v in bindings.items() if v['differentFromFinalInputs']}}))
