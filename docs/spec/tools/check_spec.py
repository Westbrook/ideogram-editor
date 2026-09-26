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
expected_req={'REQ-API','REQ-CAP','REQ-OPS','REQ-UX','REQ-STATE','REQ-DS','REQ-TEST','REQ-PERF','REQ-TRAIN','REQ-LOCAL','REQ-DOCS','REQ-READY'}
for family,expected in [('requirements',expected_req),('decisions',{f'DEC-{n:02}' for n in range(1,31)}),('capabilities',{f'CAP-{n:02}' for n in range(1,25)})]:
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
# SPEC-A3 exact authorized changes: reverse to the pinned A2 documents, then retain
# every original preservation check against that baseline. No wildcard exemption.
ledger=json.loads(read(ROOT/'editorial-transformations.json'))
a3=ledger['readinessRevision']
BASE_HASHES = {'index': 'bc1e80f1a65274f66db15c7bbe7d7996c1ebd95e2797a1d1f08fdbd3a96f1e15', 'api': 'c0df4cb8df78e3ba04117b72821ffb8a4d69cf59828510306c7ee9f433a641de', 'design-system': 'b374c55f33e43eff89138c890706a15a91586fb71f7268f90d78a08e326b253a', 'ux': '03a84bd6fbfdd930068cce8d6ebaec64f106c59afed65c74f23d605c6a5d8af6', 'architecture': '951258ff76456d0a1dbff355f29c69184b91dbd3c0191768d7fc25a1980476db', 'testing': '2118b75a7f3cfa63288444c93e5217cc2f09f93114d92b09cfd11836f521aee5', 'performance': '4296f2b93db5f9be9ef8892f56f43bd6471802bdc2f27390b621cc297e0e06ee'}
need(a3['baseCommit']=='86701416fa966b92353a1cff062a81a27a1786b9','A3 base commit')
need(a3['baseDocumentSha256']==BASE_HASHES,'A3 baseline hashes changed')
need(a3['numericBudgetChanges']==[],'A3 numeric budget change not authorized')
expected_findings={f'8A-F{i:02}' for i in range(1,8)}|{f'8B-{i:02}' for i in range(1,12)}|{'8C-01','8C-02'}
preserved=dict(current)
for op in reversed(a3['operations']):
 name=op['section'];need(name in names,'A3 operation unknown section')
 need(op['kind']=='exact-replace' and op['count']==1,'A3 non-exact transformation')
 need(bool(op['findings']) and set(op['findings'])<=expected_findings,'A3 operation lacks approved finding')
 need(preserved[name].count(op['new'])==1,'A3 exact new clause missing/duplicated: '+name)
 preserved[name]=preserved[name].replace(op['new'],op['old'],1)
for name in names:
 need(digest(preserved[name].encode())==BASE_HASHES[name],'A3 undeclared change: '+name)
 structure=a3['declaredStructuralChanges'][name]
 typed=lambda s:[m[0] for m in re.finditer(r'^```(?:ts|typescript|json)\n.*?^```',s,re.M|re.S)]
 table_blocks=lambda s:[m[0] for m in re.finditer(r'(?:^\|[^\n]*\n)+',s,re.M)]
 for extractor,label,key in [(typed,'typedBlocks','currentTypedBlockSha256'),(table_blocks,'tables','currentTableSha256')]:
  need(len(extractor(preserved[name]))==structure[label+'Before'],'A3 old structural count: '+name)
  actual=extractor(current[name]);need(len(actual)==structure[label+'After'],'A3 new structural count: '+name)
  need([digest(x.encode()) for x in actual]==structure[key],'A3 undeclared exact table/typed contract: '+name)
contracts=json.loads(read(ROOT/'readiness-contracts.json'))
need(set(contracts['findingIds'])==expected_findings and len(contracts['findingIds'])==20,'A3 finding coverage')
need({f['id'] for f in contracts['findings']}==expected_findings and len(contracts['findings'])==20,'A3 disposition coverage')
for finding in contracts['findings']:
 need(finding['status']=='author-resolved' and finding['independentReview']=='pending Task 10','A3 false independent approval')
 need(bool(finding['ownerAndVerification']) and '| '+finding['id']+' | '+finding['disposition']+' | '+finding['ownerAndVerification']+' |' in current['index'],'A3 finding/index mismatch '+finding['id'])
need(contracts['readinessGate']=={'requirement':'REQ-READY','owner':'Coordinator','verifierTask':'45decaa2-2459-4100-8461-d7680076c4d3','status':'pending-independent-verification'},'REQ-READY premature closure or wrong owner')
need(contracts['numericBudgetChanges']==[],'readiness budget delta')
profiles=contracts['profiles']
need(set(profiles)=={'LP-1','LS-1','EF-1','PF-1','RP-1','TP-1','DR-1','SG-1'},'readiness profile inventory')
# Decision-critical values are pinned independently of the transformation ledger.
critical={
 'LP-1':{'protocolVersion':1,'commandResults':['receipt','pending','unknown'],'domainRejectionCodes':['STALE_REVISION','INVALID_INPUT','MISSING_ASSET','CAPACITY','INCOMPATIBLE'],'sameIdDifferentBody':409,'unknownReceipt':404,'pending':202,'retryPaidPost':False},
 'LS-1':{'exactHostOrigin':True,'sensitiveReadsAuthenticated':True,'nullOriginAllowed':False,'tokenBits':256,'pairingTTLSeconds':300,'sessionAbsoluteSeconds':43200,'sessionIdleSeconds':1800},
 'EF-1':{'queueOrigin':'https://queue.fal.run:443','mediaCredentials':False,'mediaRedirectHops':0,'hostProfileGate':'Q09','productionEmulatorAllowed':False,'connectTimeoutSeconds':10,'idleTimeoutSeconds':30},
 'PF-1':{'formatVersion':1,'container':'ZIP64','compression':'STORE','hard4GiBCap':False},
 'RP-1':{'storeIO':'0','default':'minimum-retention-most-private-compatible','unsupported':'block or explicit disclosed fallback','endpointQualification':'Q09','localDeletionImpliesRemoteDeletion':False},
 'TP-1':{'backendClass':'backend-transport','backendExport':'never','portableClass':'portable-provider'},
 'DR-1':{'candidateDeletion':'tombstone-and-keep-bytes','wholeDocumentDeletion':'preview-atomic-root-release-durable-receipt','sharedRoots':'retain','lateResults':'no-document-resurrection'},
 'SG-1':{'enabledByDefault':False,'scope':'durable-spendSessionId','uncertainReservation':'held','restartResets':False,'guaranteedMoneyLimit':False}}
for id,fields in critical.items():
 for key,value in fields.items():need(profiles[id].get(key)==value,id+' contract '+key)
 owner,anchor=profiles[id]['owner'].split('#');need(anchor in anchors(current[owner[:-3]]),id+' owner anchor')
expected_test_ids={f'{prefix}{i:02}' for prefix,count in [('PROTO',4),('SEC',6),('EGRESS',3),('FORMAT',3),('PROV',2),('PRIV',2),('DELETE',3),('TRAIN',1),('CAPTION',1),('SPEND',2)] for i in range(1,count+1)}
need(set(contracts['testIds'])==expected_test_ids and len(contracts['testIds'])==27,'readiness consumer oracle inventory')
for id in expected_test_ids:need(len(re.findall(r'^\| '+id+r' /',current['testing'],re.M))==1,'readiness test row '+id)
need({t for p in profiles.values() for t in p['tests']}|set(contracts['editorialCases'])==expected_test_ids,'readiness profile/test closure')
route_rows=current['architecture'].split('### 20.1')[1].split('### 20.2')[0]
expected_routes=['POST /session/bootstrap', 'GET /session', 'POST /session/renew; POST /session/revoke', 'GET /capabilities', 'POST /commands', 'GET /commands/:id', 'GET /events?after=seq', 'GET /events/stream?after=seq', 'GET /documents/:id; GET /jobs/:id', 'POST /assets/staging', 'GET /assets/staging/:id', 'PUT /assets/staging/:id', 'POST /assets/staging/:id/finalize', 'GET /assets/:version/content', 'POST /bundles/import', 'GET /bundles/:id/content']
need([r['route'] for r in contracts['routes']]==expected_routes,'LP-1 route inventory')
for route in contracts['routes']:
 row='| '+route['route']+' | '+route['requestAndSuccess']+' | '+route['failureAndRetry']+' |'
 need(row in route_rows,'LP-1 route/schema mismatch '+route['route'])
need('MISSING_SCENE' in current['ux'] and 'explicit empty string passes' in current['ux'],'caption missing/empty contract')
need('A prepared image >2MiB' in current['ux'] and 'not per-image or square-only admission limits' in current['ux'],'training fixture/admission distinction')
need('Hiding results does not free disk space' in current['ux'],'candidate byte retention disclosure')
need('Task 7 review_required' not in current['index'],'stale Task 7 status')
need(set(re.findall(r'Q\d{2}',current['index'].split('### Phase-to-qualification applicability')[1].split('<a id="initial-support-matrix">')[0]))==set(contracts['qualificationIds']),'phase/Q applicability coverage')
need('API A/B' in current['index'] and 'Initial support matrix' in current['index'],'quick-start/support navigation')
checks.update(readiness_findings=20,readiness_profiles=8,readiness_consumer_oracles=27,local_protocol_route_rows=len(expected_routes),declared_A3_transformations=len(a3['operations']),reproduced_A2_documents=7)

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
  need(blocks(original)==blocks(preserved[name]),name+' baseline substantive typed/JSON contracts changed'); need(blocks(current[name])[:len(blocks(original))]==blocks(original),name+' original contracts not preserved before declared additions')
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
