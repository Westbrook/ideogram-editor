import json,subprocess,hashlib,datetime
from pathlib import Path
root=Path(__file__).resolve().parent;source=root/'source';main=Path('/Users/westbrook/Documents/repos/ideogram-edit');base='648a35abce7c2a91e90c132c38b6868f2790e5a1';foundation='dcd5f11dbd57cd7ed00c8ddf410857ce4700440e';head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=main,text=True).strip()
sha=lambda b:hashlib.sha256(b).hexdigest()
def git(ref,path):return subprocess.check_output(['git','show',ref+':'+path],cwd=main)
files=subprocess.check_output(['git','ls-files'],cwd=main,text=True).splitlines()
inputs=[f for f in files if f.startswith(('src/','server/','tests/','tooling/')) or f in ['package.json','package-lock.json'] or f.startswith('tsconfig')]
checked={}
for f in inputs:
 b=(main/f).read_bytes();assert b==git(head,f),('uncommitted source',f);assert b==(source/f).read_bytes(),('tested source differs',f);checked[f]={'bytes':len(b),'sha256':sha(b)}
profile=json.loads((main/'src/text/profile.json').read_text())
reusePaths=[f for f in files if f.startswith('vendor/text/') and f not in ['vendor/text/FILES.json','vendor/text/manifest.json']]+['package-lock.json','tooling/text/source-closure.json','tooling/text/configure-source.py','tooling/text/canvaskit-source.patch','tooling/text/rebuild.py','tooling/text/MEMORY.txt','tooling/text/PREPARED-CONTRACT.txt','src/text/worker.ts','src/text/memory.ts','src/text/admission.ts','src/text/contracts.ts','src/text/font.ts','src/text/bidi.ts','src/text/bidi-data.json','tooling/raster/codecs.json']
reuse=[]
for f in reusePaths:
 b=(main/f).read_bytes();old=git(foundation,f);assert old==b,('changed native input',f);reuse.append({'path':f,'foundationSHA256':sha(old),'currentSHA256':sha(b),'bytes':len(b)})
for key,path in [('js','node_modules/canvaskit-wasm/bin/canvaskit.js'),('wasm','node_modules/canvaskit-wasm/bin/canvaskit.wasm')]:
 for repo in [source,main]:
  b=(repo/path).read_bytes();assert sha(b)==profile['engine'][key]['sha256'];assert len(b)==profile['engine'][key]['bytes']
old=git(base,'src/text/engine.ts').decode();assert old==git(foundation,'src/text/engine.ts').decode()
start=old.index('export async function createTextEngine');end=old.index('function finite',start);loader=old[start:end].strip()
assert (main/'src/text/engine.ts').read_text().split('export async function createTextEngine',1)[1].strip()==loader.split('export async function createTextEngine',1)[1].strip()
expected=(old[:start]+old[end:]).replace("import CanvasKitInit from 'canvaskit-wasm';\n",'').replace("import wasmUrl from 'canvaskit-wasm/bin/canvaskit.wasm?url';\n",'').replace('LIMITS, readSealedAsset','LIMITS').replace('type Kit =','export type Kit =').replace('prepareText(request: TextRequest, ck: Kit):','prepareText(request: TextRequest, ck: Kit, rendererProfile = profile.id):').replace('rendererProfile: profile.id,','rendererProfile,')
assert expected==(main/'src/text/core.ts').read_text(),'unexpected core algorithm change'
for name,ref in [('c19791ae',foundation),('b89503d3',base)]:assert (main/('src/text/retained-profiles/'+name+'.json')).read_bytes()==git(ref,'src/text/profile.json')
prior=json.loads((source/'package-lock.json').read_text());assert sha((source/'package-lock.json').read_bytes())==sha(git(foundation,'package-lock.json'))
report={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':'AUTHOR audit PASS, independent review pending','sourceCommit':head,'rejectedBase':base,'foundation':foundation,'profile':profile['id'],'testedCheckoutExactInputs':checked,'nativeReuse':reuse,'installedJSAndWASM':profile['engine'],'coreExtraction':{'original':sha(old.encode()),'sharedCore':sha(expected.encode()),'browserLoaderUnchanged':True,'allowedEdits':['separate browser loader/imports','export Kit type','parameterize only renderer profile identity in dependency hash and result'],'algorithmOtherwiseExact':True},'retainedProfileFilesExact':True,'limits':['Original native reproduction reused, not rerun; no new native binary or toolchain','Shared core, server host, admission and writer/import integration qualify only through fresh recorded gates','No physical RSS, full-envelope or P3 qualification; A-R01 remains open','Historical intermediate snapshots are hashes; not all intermediate source contents archived']}
(root/'final-source-reuse.json').write_text(json.dumps(report,indent=2));print(json.dumps({'sourceCommit':head,'inputs':len(checked),'reuseFiles':len(reuse),'profile':profile['id'],'audit':'PASS'}))
