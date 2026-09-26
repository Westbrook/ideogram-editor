import hashlib,json
from pathlib import Path
bundle=Path(__file__).resolve().parent
checkout=bundle.parent.parent
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
load=lambda p:json.loads((bundle/p).read_text())
seals={}
for line in (bundle/'SHA256SUMS').read_text().splitlines():
 digest,path=line.split('  ',1);assert path not in seals and not Path(path).is_absolute() and '..' not in Path(path).parts;assert sha(bundle/path)==digest,path;seals[path]=digest
actual={str(p.relative_to(bundle)) for p in bundle.rglob('*') if p.is_file() and p.name!='SHA256SUMS' and '__pycache__' not in p.parts}
# A copied prior seal is itself sealed in this new additive package.
actual.update(str(p.relative_to(bundle)) for p in bundle.rglob('SHA256SUMS') if p!=bundle/'SHA256SUMS')
assert set(seals)==actual,actual^set(seals)
code=load('CODE-INPUTS.json')
for group in ['runtimeSource','verificationCode']:
 for path,digest in code[group].items():assert sha(checkout/path)==digest,(group,path)
assert hashlib.sha256(json.dumps(code['runtimeSource'],sort_keys=True,separators=(',',':')).encode()).hexdigest()==code['runtimeSourceSHA256']
assert all(not p.endswith('browser.json') for p in code['verificationCode'])
for manifest in ['OBSERVATION-MAPPING.json','BUILD-MAPPING.json']:
 for entry in load(manifest)['entries']:assert seals[entry['packagePath']]==entry['sha256'],(manifest,entry['packagePath'])
prior=load('PRIOR-EVIDENCE.json');assert sha(bundle/'prior-e392/SHA256SUMS')==prior['fullOriginalSealSHA256']
index={line.split('  ',1)[1]:line.split('  ',1)[0] for line in (bundle/'prior-e392/SHA256SUMS').read_text().splitlines()}
for entry in prior['copies']:
 assert sha(bundle/entry['packagePath'])==entry['sha256']
 if entry['originalName']!='SHA256SUMS':assert index[entry['originalName']]==entry['sha256']
assert not load('CREDENTIAL-SCAN.json')['actualLookingValues']
print(json.dumps({'result':'AUTHOR offline integrity PASS; not independent approval','seals':len(seals),'runtimeInputs':len(code['runtimeSource']),'verificationCodeInputs':len(code['verificationCode']),'observationCopies':len(load('OBSERVATION-MAPPING.json')['entries']),'buildCopies':len(load('BUILD-MAPPING.json')['entries']),'runtimeSourceSHA256':code['runtimeSourceSHA256']},indent=2))
