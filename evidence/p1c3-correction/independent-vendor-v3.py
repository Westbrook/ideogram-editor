import importlib.util,json,os,shutil,contextlib,io,datetime
from pathlib import Path
R=Path(__file__).resolve().parent; S=R.parents[1]; O=S/'artifacts/p1c3-correction/independent-vendor-v3';O.mkdir()
spec=importlib.util.spec_from_file_location('review_vendor',S/'tooling/verify-vendor.py');v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
results=[]
for name in ['valid','archive-hardlink','profile-parent-symlink','duplicate-inventory','missing-lock','lock-symlink']:
 p=O/name;p.mkdir()
 for n in ['package.json','package-lock.json','tooling/toolchain.json','src/text/profile.json']:
  (p/n).parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(S/n,p/n)
 shutil.copytree(S/'vendor',p/'vendor')
 if name=='archive-hardlink': os.link(p/v.CANVASKIT_PATH,p/'archive-alias.tgz')
 if name=='profile-parent-symlink': (p/'src/text').rename(p/'profile-copy');(p/'src/text').symlink_to(p/'profile-copy',target_is_directory=True)
 if name=='duplicate-inventory':
  f=p/'vendor/text/FILES.json';rows=json.loads(f.read_text());rows.append(next(x for x in rows if x['path']==v.CANVASKIT_PATH));f.write_text(json.dumps(rows))
 if name=='missing-lock': (p/'package-lock.json').unlink()
 if name=='lock-symlink': (p/'package-lock.json').rename(p/'lock-copy.json');(p/'package-lock.json').symlink_to(p/'lock-copy.json')
 start=datetime.datetime.now(datetime.timezone.utc).isoformat();output=io.StringIO();accepted=False;reason=''
 try:
  with contextlib.redirect_stdout(output):v.verify(p)
  accepted=True
 except BaseException as e: reason=f'{type(e).__name__}: {e}'
 row=dict(name=name,start=start,end=datetime.datetime.now(datetime.timezone.utc).isoformat(),expectedAccepted=name=='valid',accepted=accepted,reason=reason,stdout=output.getvalue());row['pass']=row['expectedAccepted']==accepted;results.append(row);print(json.dumps(row))
(O/'results.json').write_text(json.dumps(results,indent=2)+'\n')
raise SystemExit(0 if all(x['pass'] for x in results) else 1)
