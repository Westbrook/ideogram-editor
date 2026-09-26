"""Preserve isolated source identities and every schema-correction gate attempt."""
import datetime, hashlib, json, os, pathlib, shutil, subprocess, sys
REPO=pathlib.Path(__file__).resolve().parents[2]
OUT=REPO/'evidence/p1b4-schema-correction'
BASE='7388d1e625a6ac2c563bc64cca6318d264649acc'
tag=sys.argv[1]
root=REPO.parent/'ideogram-edit-verification'/('p1b4-schema-'+tag)
root.mkdir(exist_ok=False)
source=root/'source'
subprocess.run(['git','clone','--shared','--no-checkout',str(REPO),str(source)],check=True)
subprocess.run(['git','-C',str(source),'checkout','--detach',BASE],check=True)
paths=subprocess.check_output(['git','ls-files','-co','--exclude-standard','-z'],cwd=REPO).decode().split('\0')
identities={}
for name in sorted(set(paths)):
    if not name or name.startswith('evidence/'): continue
    p=REPO/name
    if not p.is_file(): continue
    dest=source/name;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(p,dest)
    identities[name]=hashlib.sha256(p.read_bytes()).hexdigest()
shutil.copytree(REPO/'node_modules',source/'node_modules',symlinks=True)
os.symlink(REPO/'.toolchain',source/'.toolchain')
original=root.parent/'dfa383d-independent'
for name in ['probes','fixtures']: shutil.copytree(original/name,root/name)
(OUT/('source-'+tag+'.json')).write_text(json.dumps({'base':BASE,'source':str(source),'files':identities},indent=2)+'\n')
env=dict(os.environ,PATH=str(REPO/'.toolchain/bin')+':'+os.environ['PATH'])
gates=[['npm','run',g] for g in ['verify:raster','typecheck','build','verify:vendor','test:vendor','test:raster','test:assets','test:protocol','test:session','test:store','test:recovery','test:raster:browser','test:assets:volume','test:store:volume','test:consumer']]
gates+=[['node','--import','./tests/session/no-egress.mjs','--test','--test-concurrency=1','../probes/findings-v2.test.mjs']]
gates+=[['node','--import','./tests/session/no-egress.mjs','../probes/'+p] for p in ['controlled-v2.mjs','safety-v2.mjs']]
results={'startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source':str(source),'qualification':False,'gates':[]}
for i,command in enumerate(gates):
    log=OUT/'logs'/f'{tag}-{i:02}.txt';at=datetime.datetime.now(datetime.timezone.utc).isoformat()
    with log.open('wb') as stream: run=subprocess.run(command,cwd=source,env=env,stdout=stream,stderr=subprocess.STDOUT)
    results['gates'].append({'command':command,'at':at,'finishedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exitCode':run.returncode,'log':str(log.relative_to(REPO))})
    (OUT/('gates-'+tag+'.json')).write_text(json.dumps(results,indent=2)+'\n')
    print(command[-1],run.returncode,flush=True)
    if run.returncode: sys.exit(run.returncode)
for name in ['controlled-results-v2.json','safety-results-v2.json']:shutil.copy2(root/name,OUT/(tag+'-'+name))
results['finishedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat()
(OUT/('gates-'+tag+'.json')).write_text(json.dumps(results,indent=2)+'\n')
