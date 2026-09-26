#!/usr/bin/env python3
"""Read-only checker regression probes in isolated temporary document copies."""
from pathlib import Path
import tempfile,shutil,json,subprocess,datetime,re
source=Path(__file__).resolve().parents[1];results=[]
cases=[
 ('missing REQ-READY','traceability.json','json',lambda d:d['requirements'].pop(), 'requirements ID coverage'),
 ('missing audit disposition','readiness-contracts.json','json',lambda d:d['findings'].pop(), 'A3 disposition coverage'),
 ('changed candidate decision','readiness-contracts.json','json',lambda d:d['profiles']['DR-1'].update(candidateDeletion='release-bytes'), 'DR-1 contract candidateDeletion'),
 ('enabled spend cap by default','readiness-contracts.json','json',lambda d:d['profiles']['SG-1'].update(enabledByDefault=True), 'SG-1 contract enabledByDefault'),
 ('media credentials leak','readiness-contracts.json','json',lambda d:d['profiles']['EF-1'].update(mediaCredentials=True), 'EF-1 contract mediaCredentials'),
 ('removed local route','readiness-contracts.json','json',lambda d:d['routes'].pop(), 'LP-1 route inventory'),
 ('missing new consumer case','testing.md','text',lambda s:s.replace('| DELETE01 /','| REMOVED01 /',1),'readiness test row DELETE01'),
 ('changed original typed contract','architecture.md','text',lambda s:s.replace('type Seq = string;','type Seq = number;',1),'original contracts not preserved'),
 ('changed original performance budget','performance.md','text',lambda s:re.sub(r'^\| R01\b','| R99',s,count=1,flags=re.M),'60 PERF budget rows changed'),
 ('changed history','history/spec.md','text',lambda s:s+'\nChanged seal\n','input hash spec'),
 ('undeclared contract prose','architecture.md','text',lambda s:s.replace('Media redirects are rejected (zero hops)','Media redirects are accepted (five hops)',1),'A3 undeclared change: architecture')]
with tempfile.TemporaryDirectory(prefix='spec-a3-checker-') as folder:
 root=Path(folder)/'spec';shutil.copytree(source,root)
 for label,path,kind,mutate,expected in cases:
  p=root/path;original=p.read_text()
  if kind=='json':d=json.loads(original);mutate(d);p.write_text(json.dumps(d))
  else:
   mutated=mutate(original);assert mutated!=original,label+' probe made no change';p.write_text(mutated)
  result=subprocess.run(['python3',str(root/'tools/check_spec.py')],capture_output=True,text=True)
  data=json.loads(result.stdout);matched=any(expected in e for e in data['errors']);assert result.returncode==1 and matched,(label,data)
  results.append({'probe':label,'result':'PASS: checker rejected mutation','expectedFailure':expected});p.write_text(original)
r={'executedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'scope':'Isolated temporary documentation copies only; original files and notes unchanged','cases':results}
print(json.dumps(r,indent=2))
