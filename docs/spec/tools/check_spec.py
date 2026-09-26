#!/usr/bin/env python3
"""Standard-library documentation checks; never executes app/provider code."""
import hashlib,json,pathlib,re,sys,urllib.parse,collections
ROOT=pathlib.Path(__file__).resolve().parents[1]
errors=[];checks={}
def need(ok,msg):
 if not ok: errors.append(msg)
def digest(b):return hashlib.sha256(b).hexdigest()
def read(p):return p.read_text(encoding='utf-8')
def slug(s):
 s=re.sub(r'<[^>]+>','',s);s=re.sub(r'\[([^\]]+)\]\([^)]*\)',r'\1',s)
 s=re.sub(r'[^\w\- ]','',s.lower());return s.replace(' ','-')
def anchors(s):
 out=set(re.findall(r'<a id="([^"]+)"',s));seen=collections.Counter()
 for l in s.splitlines():
  if re.match(r'^#{1,6} ',l):
   a=slug(re.sub(r'^#+ ','',l));n=seen[a];seen[a]+=1;out.add(a+(('-'+str(n)) if n else ''))
 return out
names=['index','api','design-system','ux','architecture','testing','performance']
current={n:read(ROOT/(n+'.md')) for n in names}
# Current documents must be readable without history; historical snapshots intentionally preserve original formatting.
link_count=table_count=json_count=0
for name,s in current.items():
 fence=None;json_body=[];table_width=None
 for number,line in enumerate(s.splitlines(),1):
  f=re.match(r'^(`{3,}|~{3,})(.*)$',line)
  if f:
   if fence:
    if f[1][0]==fence[0] and len(f[1])>=len(fence):
     if language=='json':
      try:json.loads('\n'.join(json_body));json_count+=1
      except Exception as e:errors.append(f'{name}:{number} JSON: {e}')
     fence=None;json_body=[]
   else:fence=f[1];language=f[2].strip();json_body=[]
   table_width=None;continue
  if fence:
   json_body.append(line);continue
  if line.startswith('|'):
   width=len(re.split(r'(?<!\\)\|',line))-2
   if table_width is None:table_width=width;table_count+=1
   need(width==table_width,f'{name}:{number} table width {width}, expected {table_width}')
  else:table_width=None
 need(fence is None,f'{name}: unclosed fence')
 for m in re.finditer(r'\]\(([^\n)]+)\)',s):
  target=m[1].strip('<>');u=urllib.parse.urlsplit(target)
  if u.scheme:continue
  local=(ROOT/urllib.parse.unquote(u.path)).resolve() if u.path else ROOT/(name+'.md')
  need(local.exists(),f'{name}: missing local target {target}');link_count+=1
  if local.exists() and u.fragment and local.suffix=='.md':need(urllib.parse.unquote(u.fragment) in anchors(read(local)),f'{name}: missing anchor {target}')
 # Old task state must not masquerade as current; technical state constants and future qualification are legitimate.
 for bad in ['Tasks5/7 remain unstarted','Original Task4 remains review_required','Original Task5 remains review_required','independent performance approval remains required','full approval remains withheld']:
  need(bad not in s,f'{name}: obsolete status {bad}')
# History preserves original syntax, but every portable relative link must still resolve.
for p in (ROOT/'history').glob('*.md'):
 for m in re.finditer(r'\]\(([^\n)]+)\)',read(p)):
  target=m[1].strip('<>');u=urllib.parse.urlsplit(target)
  if u.scheme:continue
  local=(p.parent/urllib.parse.unquote(u.path)).resolve() if u.path else p
  need(local.exists(),f'{p.name}: missing historical relative target {target}');link_count+=1
  if local.exists() and u.fragment and local.suffix=='.md':need(urllib.parse.unquote(u.fragment) in anchors(read(local)),f'{p.name}: missing historical anchor {target}')
checks.update(current_documents=7,relative_links=link_count,markdown_tables=table_count,json_examples=json_count)
trace=json.loads(read(ROOT/'traceability.json'))
expected_req={'REQ-API','REQ-CAP','REQ-OPS','REQ-UX','REQ-STATE','REQ-DS','REQ-TEST','REQ-PERF','REQ-TRAIN','REQ-LOCAL','REQ-DOCS'}
for family,expected in [('requirements',expected_req),('decisions',{f'DEC-{n:02}' for n in range(1,27)}),('capabilities',{f'CAP-{n:02}' for n in range(1,25)})]:
 rows=trace[family];need({r['id'] for r in rows}==expected and len(rows)==len(expected),family+' ID coverage')
 for row in rows:
  for k in ['requirement','evidence','capability','ux','state','test','performance','phase']:need(bool(row.get(k)),row['id']+' missing '+k)
  line=next((x for x in current['index'].splitlines() if x.startswith('| '+row['id']+' |')),None)
  need(line is not None,row['id']+' absent from index')
  if line:
   actual=[re.sub(r'\[([^\]]+)\]\([^)]*\)',r'\1',x.strip()).replace('\\|','|') for x in re.split(r'(?<!\\)\|',line)[1:-1]]
   expected=[row[k] for k in ['id','requirement','evidence','capability','ux','state','test','performance','phase']]
   need(actual==expected,row['id']+' trace JSON/Markdown mismatch')
 checks[family]=len(rows)
for family,n,prefix in [('qualificationIds',27,'Q'),('planningReviewIds',20,'R')]:
 need(set(trace[family])=={f'{prefix}{i:02}' for i in range(1,n+1)},family+' coverage')
 for id in trace[family]:need('| '+id in current['index'],id+' absent from index')
checks.update(qualifications=27,planning_findings=20)
# All artifacts carrying JSON must parse, including manifests/receipts.
for p in ROOT.rglob('*.json'):
 try:json.loads(read(p))
 except Exception as e:errors.append(str(p.relative_to(ROOT))+': '+str(e))
# Inspect exact historical inputs and outputs if final manifest is present.
mp=ROOT/'sync-manifest.json'
if mp.exists():
 manifest=json.loads(read(mp));checks['input_snapshots']=len(manifest['inputs'])
 known_notes={x['noteId'] for x in manifest['inputs']}|{x['noteId'] for x in manifest['noteParity']}
 note_links=0
 for p in ROOT.rglob('*.md'):
  for target in re.findall(r'\]\((intent://[^)]+)\)',read(p)):
   m=re.search(r'/(?:note|task)/([^/#]+)',target)
   if m:need(m[1] in known_notes,'unknown note link '+target);note_links+=1
 checks['resolved_note_references']=note_links
 for row in manifest['inputs']:
  p=ROOT/row['snapshotPath'];need(p.exists() and digest(p.read_bytes())==row['sha256'],'input hash '+row['noteId'])
 for row in manifest['outputs']:
  p=ROOT/row['path'];need(p.exists(),'missing output '+row['path'])
  if 'sha256' in row:need(digest(p.read_bytes())==row['sha256'],'output hash '+row['path'])
 for row in manifest['noteParity']:
  p=ROOT/row['path'];need(digest(p.read_bytes())==row['normalizedReadbackSha256'],'note normalized parity '+row['path'])
  need(row['sentRawSha256']==row['readbackRawSha256'],'note raw readback '+row['noteId'])
 checks['synchronized_notes']=len(manifest['noteParity'])
 # Match substantive contract blocks exactly. Omitted historical arithmetic blocks are explicitly outside this comparison.
 for name,id in [('api','2728dafd-4209-4558-a762-3a0192e0610f'),('architecture','c0689bcd-8dca-4ce6-bccb-e538e0a45477')]:
  original=read(ROOT/'history'/(id+'.md'))
  blocks=lambda s:[(m[1],m[2]) for m in re.finditer(r'^```(json|ts|typescript)\n(.*?)^```',s,re.M|re.S)]
  need(blocks(original)==blocks(current[name]),name+' substantive typed/JSON contracts changed')
  checks[name+'_contract_blocks']=len(blocks(current[name]))
 original=read(ROOT/'history'/'1b7b659d-d577-4257-b677-4850bbf86143.md')
 budget=lambda s:{m[1]:m[0] for m in re.finditer(r'^\| ((?:R\d{2}|T\d{2}|D\d{2}))\b[^\n]*',s,re.M)}
 a,b=budget(original),budget(current['performance']);need(len(a)==60 and a==b,'60 PERF budget rows changed');checks['unchanged_budget_rows']=len(b)
 # Pin the complete numerical campaign/workload tables, not just headline budget rows.
 tables=lambda s:[m[0] for m in re.finditer(r'(?:^\|[^\n]*\n)+',s,re.M)]
 normalize=lambda t:re.sub(r'PERF-[4-7]|ARCH-1\.3|UX-2\.1',lambda m:'PERF-8' if m[0].startswith('PERF') else ('ARCH-1.4' if m[0].startswith('ARCH') else 'UX-2.2'),t)
 source_main=original.split('## 10. Draft audit and handoff')[0]
 # FA-01 allows exactly one declared WT wording correction; every other table byte remains pinned.
 fa01_old='≤201 MiB ZIP including captions/manifest.'
 fa01_new='≤201 MiB provider ZIP containing only validated image/caption pairs; the app manifest is prepared and persisted separately as a durable sidecar. Manifest preparation/storage remains included in the existing workload and timing/resource accounting.'
 need(source_main.count(fa01_old)==1 and current['performance'].count(fa01_new)==1,'FA-01 exact WT wording occurrence')
 need(re.findall(r'\d+(?:\.\d+)?',fa01_old)==re.findall(r'\d+(?:\.\d+)?',fa01_new),'FA-01 WT numerical preservation')
 permitted=[normalize(x).replace(fa01_old,fa01_new) for x in tables(source_main)]
 need(permitted==tables(current['performance']), 'PERF main tables/campaign inventory changed outside FA-01 wording')
 checks['performance_tables_preserved_with_exact_FA01_wording']=len(permitted)
 api_original=read(ROOT/'history'/'2728dafd-4209-4558-a762-3a0192e0610f.md')
 extract=lambda s:s[s.index('## Appendix A'):s.index('## Appendix C')]
 noanchors=lambda s:re.sub(r'<a id="[^"]+"></a>\n\n','',s)
 need(noanchors(extract(current['api']))==extract(api_original),'API A/B full schema appendices changed')
 checks['api_schema_appendices']=len(re.findall(r'^### A\d{2}\.',current['api'],re.M))
# SHA256SUMS is an outer seal; it necessarily excludes itself.
seal=ROOT/'SHA256SUMS'
if seal.exists():
 count=0
 for l in read(seal).splitlines():
  h,path=l.split('  ',1);p=ROOT/path;need(p.exists() and digest(p.read_bytes())==h,'outer seal '+path);count+=1
 checks['sealed_files']=count
print(json.dumps({'status':'PASS' if not errors else 'FAIL','checks':checks,'errors':errors,'limits':['Documentation/source/parity checks only; no application tests, benchmarks, provider or live external-link checks.','Stored note hashes attest to the recorded readback; a future live note edit requires a fresh synchronization readback.']},ensure_ascii=False,indent=2))
sys.exit(1 if errors else 0)
