from pathlib import Path
import datetime,hashlib,json,subprocess
root=Path(__file__).resolve().parents[2];out=root/'evidence/p1c3'
product='e070baff7069a319f92a39e6c369378a31424181';checker='a78aa8879291c3bdc938796d64b4aa4926e7df93';base='4b2c82ccc41dd72c3f83480f23481b7b62135d23'
assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()==checker
def digest(p):
 b=p.read_bytes();return {'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()}
def write(name,value):
 with (out/name).open('x') as f:f.write(json.dumps(value,indent=2)+'\n')
first=json.loads((out/'SHA256SUMS.json').read_text())
for name,row in first['files'].items():assert digest(root/name)==row,name
assert subprocess.check_output(['git','show','01de7559f6ae02a0d770be550154da11bf18b865:evidence/p1c3/SHA256SUMS.json'],cwd=root)==(out/'SHA256SUMS.json').read_bytes()
source=json.loads((out/'source-inputs.json').read_text());changed=[]
for path,row in source['files'].items():
 current=digest(root/path)
 if current!=row:changed.append(path)
 source['files'][path]=current
assert sorted(changed)==['tooling/test-vendor.py','tooling/verify-vendor.py'],changed
source.update(productCommit=product,checkerCommit=checker,changesAfterProduct=changed)
write('FINAL-source-inputs.json',source)
gates=[]
for name in ['79-vendor-correction','80-vendor-correction-tests','82-preview-identity-gate','83-preview-roundtrip-gate']:
 r=json.loads((out/name/'receipt.json').read_text());assert r['exitCode']==0
 differences=[p for p,h in r['source'].items() if p in source['files'] and source['files'][p]['sha256']!=h]
 assert not differences,differences
 gates.append({'name':name,**{k:v for k,v in r.items() if k!='source'},'finalSourceDifferences':differences,'receipt':f'evidence/p1c3/{name}/receipt.json','output':f'evidence/p1c3/{name}/output.txt'})
write('FINAL-gates.json',gates)
service=Path('/Users/westbrook/Documents/repos/ideogram-edit-p1c3-preview-e070baff')
effects=json.loads((service/'effects.json').read_text());assert all(x==0 for x in effects.values());write('81-preview-service/effects.json',effects)
preview=json.loads((out/'82-preview-identity/identity.json').read_text());trip=json.loads((out/'83-preview-roundtrip/roundtrip.json').read_text());assert preview['passed'] and trip['passed']
files=subprocess.check_output(['git','diff','--name-only',base,checker,'--','src','server','tests','tooling','vendor',':(exclude)tests/editor/evidence'],cwd=root,text=True).splitlines()
write('FINAL.json',{
 'taskId':'de9a33a4-55cd-4132-a497-3b27095ab0ca','status':'author handoff; independent review required, no acceptance or credit','base':base,'productCommit':product,'firstEvidenceCommit':'01de7559f6ae02a0d770be550154da11bf18b865','checkerCommit':checker,'profile':'sha256:d047f5beee2e3ca7f19d5e0ea7150f884a8063c2296b34fa94fb1ffeff434218','sealedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'authorFunctionalEnd':'2026-09-27T00:45:49.033940+00:00',
 'firstPacket':{'manifest':'SHA256SUMS.json',**digest(out/'SHA256SUMS.json'),'verifiedFiles':len(first['files']),'unchanged':True},
 'sourceFilesTouched':files,'sourceMapping':'FINAL-source-inputs.json records exact product inputs with only two checker/test files changed after product e070. Earlier product gates are reused only for identical owning inputs; no product/profile/native/toolchain/dependency change in checker a78.',
 'productGates':'gates.json (original commands/UTC intervals/source hashes and failures retained)',
 'passingProductResults':{'61-63':'two authoring workflows each, stock Chromium/Firefox/WebKit; all source hashes equal product e070','56-history':'55 PASS; identical product/history inputs, sole later inventory difference is browser-only tests/editor/authoring.spec.ts','64-67':'types, consumer/app/server build and text/raster seals PASS','69':'53 public imports PASS','70-raster':257,'71-protocol-session':28,'72-assets':29,'73-portable':'125, large resource campaign excluded','74':'new current-native fixture build PASS','75-current-native':'3 engines, 8 actual worker closes each, exact retained source hash286ebdc5c061ad1cabb9c96051e0f990c7c2bee937479d2ade2ba59868b1c83c','76-text-state':17,'77-editor-contracts':'8, bounded synthetic oversized read only','78-namespace-browser':4},
 'supplementalGates':'FINAL-gates.json: corrected vendor79 PASS, focused vendor80 PASS17, preview82/83 PASS',
 'vendorDisposition':{'historical68':'FAILED, original bytes retained','68a':'Actual accepted-base inner exit1 reproduced; outer diagnostic PASS was never vendor PASS','79':'PASS only after separately committed checker a78; exact sealed CanvasKit local archive plus negative tests; no dependency policy waiver'},
 'diffCheck':{'source':'Original product-only and later checker-only diffs PASS','wholeEvidence':'Post-first-seal whole-evidence diff --check returned2 for verbatim test-log whitespace and minified built artifacts. Raw sealed evidence intentionally retained. No whole-repository whitespace PASS claim.'},
 'preview':{'url':preview['runtime']['reviewURL'],'service':str(service),'pid':preview['runtime']['pid'],'runtimeSourceSHA256':preview['runtime']['runtimeSourceSHA256'],'buildGate':'65-build','startupCheckedBuildFiles':71,'startupCheckedAdditionalFiles':217,'servedUniquePaths':len(set(r['path'] for r in preview['served'])),'servedResponseObservations':len(preview['served']),'browser':preview['browser'],'unflaggedReturnAbsent':preview['unflaggedReturnAbsent'],'card':{k:trip['review'][k] for k in ['itemId','title','version','contentRevision','observedReportRevision']},'roundtrip':'83-preview-roundtrip/roundtrip.json','scope':trip['scope'],'effects':effects},
 'adoptionInventory':['scope-and-reuse.json','../../tooling/editor-components.json'],
 'firstFailures':'failures.txt plus original gate receipts, unchanged; no supplemental functional gate failed',
 'buildIdentity':'build-files.json with sealed-build bytes; frozen service verified all71 plus217 additional copied files. Earlier browser-build mapping is source qualified, not a retroactive byte snapshot.',
 'reviewedVisuals':['browser-55/authoring-desktop.png','browser-55/mask-controls-320.png','82-preview-identity/paired-preview.png','83-preview-roundtrip/focused-card.png'],
 'limits':['Author evidence only; P1c8/25 until independent coordinator acceptance.','A-R01 OPEN; no resource/native-memory/lifetime/full-envelope campaign or cap waiver.','No physical IME/AT/platform/power-loss qualification.','Mask support hatching is bounding extent, not exact coverage/provider-safe interior; exact hard/effective views separate.','Imported PNG placement native-size whole-pixel; crop/resize with attached document-grid mask requires detach.','Mask plan bounded48000 UTF-8 bytes with whole-operation refusal, no truncation.','All old previews/defaults/services and evidence preserved; only new isolated57855 authorized review service added.','No provider call/publishing/live sibling source edits/report DATA or HTTP writes.','No Git remote, published GitHub PR, or CI run/link configured.','Navigation belongs specifically to report420 product-card revision1. Later evidence commit does not transfer navigation or human acknowledgment.'],
 'reproduction':'FINAL-REPRODUCE.txt; original REPRODUCE.txt retained as historical product-packet instructions'})
manifest={'productCommit':product,'checkerCommit':checker,'firstPacketUnchanged':True,'files':{str(p.relative_to(root)):digest(p) for p in sorted(list(out.rglob('*'))+list((root/'tests/editor/evidence/p1c3').rglob('*'))) if p.is_file() and p.name!='FINAL-SHA256SUMS.json' and '__pycache__' not in p.parts}}
write('FINAL-SHA256SUMS.json',manifest)
print(json.dumps({'files':len(manifest['files']),'bytes':sum(r['bytes'] for r in manifest['files'].values()),'manifest':digest(out/'FINAL-SHA256SUMS.json'),'sealedAt':json.loads((out/'FINAL.json').read_text())['sealedAt'],'sourceFilesTouched':len(files)}))
