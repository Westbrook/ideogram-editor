import datetime,hashlib,json,pathlib,platform,shutil,subprocess
root=pathlib.Path(__file__).resolve().parents[2];out=root/'evidence/p1c3'
def digest(p):
 b=p.read_bytes();return {'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()}
def write(name,value):(out/name).write_text(json.dumps(value,indent=2)+'\n')
source='e070baff7069a319f92a39e6c369378a31424181';base='4b2c82ccc41dd72c3f83480f23481b7b62135d23'
assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()==source
assert not subprocess.check_output(['git','diff','--name-only'],cwd=root,text=True).strip()
paths=subprocess.check_output(['git','ls-files'],cwd=root,text=True).splitlines()
inputs={p:digest(root/p) for p in paths if p.startswith(('src/','server/','tests/','tooling/','vendor/')) and not p.startswith(('tests/editor/evidence/','tests/editor/artifacts/','tests/text/artifacts/','tests/text-state/artifacts/')) and (root/p).is_file()}
write('source-inputs.json',{'base':base,'sourceCommit':source,'files':inputs})
for part in ['app','local']:
 shutil.copytree(root/'dist'/part,out/'sealed-build'/part)
write('build-files.json',{'sourceCommit':source,'buildGate':'65-build','files':{str(p.relative_to(root)):digest(p) for p in sorted((out/'sealed-build').rglob('*')) if p.is_file()}})
a=json.loads(subprocess.check_output(['git','show',base+':src/text/profile.json'],cwd=root));b=json.loads((root/'src/text/profile.json').read_text())
assert a['engine']==b['engine'] and a['fonts']==b['fonts'] and a['adapterSources']==b['adapterSources']
assert subprocess.check_output(['git','show',base+':src/text/profile.json'],cwd=root)==(root/'src/text/retained-profiles/6e8a481e.json').read_bytes()
write('native-reuse.json',{'base':base,'sourceCommit':source,'oldProfile':a['id'],'newProfile':b['id'],'unchanged':['engine','fonts','adapterSources'],'changedSourceRecipe':[x for x in b['sourceRecipe'] if x not in a['sourceRecipe']],'engine':b['engine'],'fonts':b['fonts'],'retainedPriorExactBytes':True,'qualification':'Identity-qualified native/font/toolchain reuse, not new native builds or memory/platform qualification'})
gates=[]
for p in sorted(out.glob('*/receipt.json')):
 r=json.loads(p.read_text());mismatch=[k for k,v in r['source'].items() if k in inputs and inputs[k]['sha256']!=v]
 gates.append({'name':p.parent.name,**{k:v for k,v in r.items() if k!='source'},'finalSourceDifferences':mismatch,'receipt':str(p.relative_to(root)),'output':str((p.parent/'output.txt').relative_to(root))})
write('gates.json',gates)
required=['61-browser-final-chromium','62-browser-final-firefox','63-browser-final-webkit','56-history']+[p.parent.name for p in out.glob('*/receipt.json') if p.parent.name[:2].isdigit() and 64<=int(p.parent.name[:2])<=78 and p.parent.name not in ['68-vendor','68a-base-vendor']]
assert all(next(g for g in gates if g['name']==n)['exitCode']==0 for n in required)
assert all(any(g['name'].startswith(str(n)+'-') and g['exitCode']==0 for g in gates) for n in [64,65,66,67,69,70,71,72,73,74,75,76,77,78])
write('summary.json',{'taskId':'de9a33a4-55cd-4132-a497-3b27095ab0ca','status':'review_required; author evidence, no independent acceptance','base':base,'sourceCommit':source,'profile':b['id'],'sealedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'requiredPassingGates':required,'knownFailedGate':{'name':'68-vendor','actualBaseReproduction':'68a-base-vendor','qualification':'Diagnostic success proves identical actual-base failure; vendor gate remains failed.'},'firstFailures':'failures.txt','scopeAndAdoption':['scope-and-reuse.json','../../tooling/editor-components.json'],'sourceMap':'source-inputs.json','gateMap':'gates.json','buildMap':'build-files.json','nativeReuse':'native-reuse.json','host':platform.platform(),'node':subprocess.check_output([str(root/'.toolchain/bin/node'),'--version'],text=True).strip(),'npm':subprocess.check_output([str(root/'.toolchain/bin/node'),str(root/'.toolchain/lib/node_modules/npm/bin/npm-cli.js'),'--version'],text=True).strip() if (root/'.toolchain/lib/node_modules/npm/bin/npm-cli.js').exists() else '12.1.0 (pinned packageManager; see package.json)','browserEvidence':['browser-61','browser-62','browser-63'],'additionalFirstAttemptEvidence':['tests/editor/evidence/p1c3/browser-10/browser.json','tests/editor/evidence/p1c3/browser-13/browser.json'],'reviewedVisuals':['browser-55/authoring-desktop.png','browser-55/mask-controls-320.png'],'qualification':'Stock serial functional checks; no performance/native-memory/physical IME/AT/platform qualification. A-R01 open. Existing services/evidence retained. No provider calls or publishing.'})
write('SHA256SUMS.json',{'sourceCommit':source,'files':{str(p.relative_to(root)):digest(p) for p in sorted(list(out.rglob('*'))+list((root/'tests/editor/evidence/p1c3').rglob('*'))) if p.is_file() and p.name!='SHA256SUMS.json' and '__pycache__' not in p.parts}})
print(json.dumps({'sourceCommit':source,'files':len(json.loads((out/'SHA256SUMS.json').read_text())['files']),'sealedAt':json.loads((out/'summary.json').read_text())['sealedAt']}))
