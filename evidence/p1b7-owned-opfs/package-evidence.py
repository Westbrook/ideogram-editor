from pathlib import Path
import hashlib,json,shutil,subprocess,re
repo=Path('/Users/westbrook/Documents/repos/ideogram-edit');ext=Path(__file__).parent;bundle=repo/'evidence/p1b7-owned-opfs';bundle.mkdir(exist_ok=True)
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
write=lambda name,obj:(bundle/name).write_text(json.dumps(obj,indent=2)+'\n')
code=json.loads((ext/'09-final-source/CODE-INPUTS.json').read_text());code['sourceCommit']=subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip()
for group in ['runtimeSource','verificationCode']:
 for f,h in code[group].items():assert sha(repo/f)==h,f
write('CODE-INPUTS.json',code)
obs=[]
def copy(path,alias,category):
 target=bundle/alias;target.parent.mkdir(exist_ok=True,parents=True);shutil.copyfile(path,target);obs.append({'originalPath':str(path),'packagePath':alias,'sha256':sha(path),'category':category})
for p in sorted(ext.rglob('*')):
 if not p.is_file() or p.is_symlink() or any(x in p.parts for x in ['__pycache__']):continue
 if p.name in ['package-evidence.py','verify-evidence.py']:continue
 rel=p.relative_to(ext).as_posix();alias=rel+('.txt' if p.suffix in ['.md','.log'] else '')
 copy(p,'receipts/'+alias,'observed browser/command/control metadata' if not p.suffix in ['.py','.ts','.mjs'] else 'historical verification code; not current code input')
prior=repo.parent/'ideogram-edit-verification/ecc5262-independent';index={s.split('  ',1)[1]:s.split('  ',1)[0] for s in (prior/'SHA256SUMS').read_text().splitlines()}
selected=['SHA256SUMS','VERDICT.txt','REVERIFY.txt','commands.jsonl']+[s+e for s in ['environment-oracle','profile-isolation-diagnostic','cleanup-owned-marker'] for e in ['.mjs','.json','.log.txt']]
for name in selected:
 if name!='SHA256SUMS':assert sha(prior/name)==index[name]
 copy(prior/name,'prior-ecc/'+name,'verbatim sealed rejected-target observation or independent source')
write('PRIOR-EVIDENCE.json',{'target':code['base'],'sealSHA256':sha(prior/'SHA256SUMS'),'fullSealedFileCount':len(index),'selected':selected,'limitation':'Original first six-byte marker origin was not recorded; cleanup remains unclaimed. No unknown stores searched or erased. Original rejected seal and verdict are unchanged.'})
write('OBSERVATION-MAPPING.json',{'meaning':'Historical code and browser JSON are separately attributed observations. Current code inputs exclude reporter metadata. No private profile/pairing/SQLite/network trace copied.','entries':obs})
old=json.loads((repo/'evidence/p1b7-webkit-rail/BUILD-MAPPING.json').read_text());build=[]
for x in old['entries']:
 path='evidence/p1b7-webkit-rail/'+x['packagePath'];assert sha(repo/path)==x['sha256'] and sha(repo/x['originalPath'])==x['sha256'];build.append({'checkoutPath':path,'originalEmittedPath':x['originalPath'],'sha256':x['sha256']})
write('BUILD-REUSE.json',{'runtimeSourceSHA256':code['runtimeSourceSHA256'],'entries':build,'meaning':'Existing tracked frozen files are reused, not copied again; current07 build independently matches all61. No ignored/dist file is needed by offline verification.'})
write('GATE-MATRIX.json',{'sourceCommit':code['sourceCommit'],'commands':[json.loads(s) for s in (ext/'commands.jsonl').read_text().splitlines()],'attribution':'AUTHOR functional observations, overlapping checks, not timing/resource qualification.01/03 intermediate sources were not independently frozen before further fixture-only additions;02 candidate and09 final sources are frozen.04 CLI error is retained;05 is the corrected invocation.02 strict error failure remains failed.'})
(bundle/'SOURCE-DIFF.patch').write_bytes(subprocess.check_output(['git','diff',code['base'],code['sourceCommit']],cwd=repo))
write('SOURCE-CHANGES.json',{'base':code['base'],'sourceCommit':code['sourceCommit'],'files':subprocess.check_output(['git','diff','--name-only',code['base'],code['sourceCommit']],cwd=repo,text=True).splitlines()})
findings=[]
for p in bundle.rglob('*'):
 if not p.is_file() or p.suffix in ['.png']:continue
 t=p.read_text(errors='replace')
 for k,pattern in [('pairing',r'(?:[#?&]pairing=)[A-Za-z0-9_-]{24,}'),('cookie',r'"(?:cookie|Cookie)"\s*:\s*"[^"\n]{24,}"'),('csrf',r'"[Xx]-[Aa]pp-[Cc][Ss][Rr][Ff]"\s*:\s*"[A-Za-z0-9_-]{24,}"')]:
  if re.search(pattern,t):findings.append({'path':str(p.relative_to(bundle)),'kind':k})
write('CREDENTIAL-SCAN.json',{'actualLookingValues':findings,'scope':'Bounded scan plus selected safe artifacts; not a universal privacy guarantee.'});assert not findings,findings
shutil.copyfile(__file__,bundle/'package-evidence.py');shutil.copyfile(ext/'verify-evidence.py',bundle/'verify-evidence.py')
print(json.dumps({'observationCopies':len(obs),'codeInputs':len(code['verificationCode']),'runtimeInputs':len(code['runtimeSource']),'reusedEmittedFiles':len(build),'sourceCommit':code['sourceCommit']}))
