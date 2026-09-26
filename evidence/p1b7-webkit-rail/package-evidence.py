from pathlib import Path
import hashlib,json,shutil,subprocess,re
repo=Path('/Users/westbrook/Documents/repos/ideogram-edit');external=Path(__file__).resolve().parent;bundle=repo/'evidence/p1b7-webkit-rail';bundle.mkdir(parents=True,exist_ok=True)
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
write=lambda name,value:(bundle/name).write_text(json.dumps(value,indent=2)+'\n')
code=json.loads((external/'20-final-source/CODE-INPUTS.json').read_text())
for group in ['runtimeSource','verificationCode']:
 for path,digest in code[group].items():assert sha(repo/path)==digest,path
code['sourceCommit']='bbb00ab5d43dc7910912e9e67653925e5b86e83d';code['baseCommit']='e392bef587b976b74106e9fadad3fe4c9d4a96a7';write('CODE-INPUTS.json',code)
observations=[]
def copy(source,name,category):
 target=bundle/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,target);observations.append({'originalPath':str(source),'packagePath':name,'sha256':sha(source),'category':category})
for path in sorted(external.rglob('*')):
 if not path.is_file() or path.is_symlink() or any(x in path.parts for x in ['node_modules','__pycache__']):continue
 rel=path.relative_to(external)
 if rel.parts[0]=='07-build-frozen':continue
 if rel.name in ['package-evidence.py','verify-current-package.log','final-archive-receipt.json']:continue
 copy(path,'receipts/'+rel.as_posix()+('.txt' if path.suffix=='.log' else ''),'historical verification source' if any('source' in x for x in rel.parts) or path.suffix in ['.py','.mjs','.ts'] else 'observed browser/build/command metadata or visual')
for name in ['source.json','runtime.json','run.mjs','effects.json']:
 path=repo.parent/'ideogram-edit-webkit-rail-preview-ccdfab3b'/name
 if path.exists():copy(path,'runtime/'+name,'isolated preview identity/control source; no credentials')
for original,label in [('image-1790435558120-1.png','user-current.png'),('image-1790435558132-2.png','user-desired.png')]:copy(repo/'.intent/attachments/webkit-rail'/original,'references/'+label,'original user comparison image')
copy(repo/'tooling/editor-components.json','COMPONENTS.json','current public component/ownership inventory')
prior=repo.parent/'ideogram-edit-verification/e392bef-independent'
prior_names=['SHA256SUMS','VERDICT.txt','REVERIFY.txt','editor-webkit.log.txt','editor-webkit/browser.json','attachment-mapping.json']
prior_names+=['editor-webkit/browser/'+p.relative_to(prior/'editor-webkit/browser').as_posix() for p in (prior/'editor-webkit/browser').rglob('*') if p.is_file()]
prior_seal={line.split('  ',1)[1]:line.split('  ',1)[0] for line in (prior/'SHA256SUMS').read_text().splitlines()}
prior_copies=[]
for name in prior_names:
 p=prior/name
 if not p.exists():continue
 if name!='SHA256SUMS':assert sha(p)==prior_seal[name],name
 copy(p,'prior-e392/'+name,'unchanged independently sealed rejected-target evidence')
 prior_copies.append({'originalName':name,'packagePath':'prior-e392/'+name,'sha256':sha(p)})
write('PRIOR-EVIDENCE.json',{'fullOriginalSealedCount':132,'fullOriginalSealSHA256':sha(prior/'SHA256SUMS'),'copies':prior_copies,'scope':'Selected verbatim original failing WebKit evidence plus verdict, reverify and full seal index; original full bundle unchanged.'})
build=[]
for path,digest in json.loads((external/'07-build-frozen/files.json').read_text()).items():
 source=external/'07-build-frozen'/path;assert sha(source)==digest and sha(repo/path)==digest,path
 alias=path.replace('dist/app/','emitted/browser-static/').replace('dist/local/','emitted/local-runtime/')
 target=bundle/alias;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,target);build.append({'originalPath':path,'packagePath':alias,'sha256':digest})
write('BUILD-MAPPING.json',{'sourceCommit':code['sourceCommit'],'runtimeSourceSHA256':code['runtimeSourceSHA256'],'entries':build})
write('OBSERVATION-MAPPING.json',{'classification':'Browser reporter JSON and historical captures are observations, not live verification code inputs. No ignored original observation is required outside this package. Symlinked node_modules and private profiles/pairing files are deliberately excluded.','entries':observations})
changed=subprocess.check_output(['git','diff','--name-only',code['baseCommit'],code['sourceCommit']],cwd=repo,text=True).splitlines();write('SOURCE-CHANGES.json',{'base':code['baseCommit'],'head':code['sourceCommit'],'files':changed});(bundle/'SOURCE-DIFF.patch').write_bytes(subprocess.check_output(['git','diff',code['baseCommit'],code['sourceCommit']],cwd=repo))
# Scan only for actual-looking credentials, never print candidate values.
findings=[]
for path in bundle.rglob('*'):
 if not path.is_file() or path.suffix.lower() in ['.png','.jpg']:continue
 text=path.read_text(errors='replace')
 for kind,pattern in [('pairing-token',r'(?:[#?&]pairing=)[A-Za-z0-9_-]{24,}'),('cookie-header',r'"(?:cookie|Cookie)"\s*:\s*"[^"\n]{24,}"'),('csrf-value',r'"[Xx]-[Aa]pp-[Cc][Ss][Rr][Ff]"\s*:\s*"[A-Za-z0-9_-]{24,}"')]:
  if re.search(pattern,text):findings.append({'path':str(path.relative_to(bundle)),'kind':kind})
write('CREDENTIAL-SCAN.json',{'actualLookingValues':findings,'notes':'No private pairing/profile/SQLite data or network trace copied; scan lists paths/kinds only. Source examples and filenames are not credential values.'});assert not findings,findings
print(json.dumps({'observations':len(observations),'build':len(build),'code':len(code['verificationCode']),'runtime':len(code['runtimeSource']),'priorCopies':len(prior_copies)}))
