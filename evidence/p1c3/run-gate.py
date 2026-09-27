import datetime,hashlib,json,os,pathlib,subprocess,sys
root=pathlib.Path(__file__).resolve().parents[2]
name=sys.argv[1];command=sys.argv[2:]
out=root/'evidence/p1c3'/name
out.mkdir(exist_ok=False)
env=dict(os.environ);env['PATH']=str(root/'.toolchain/bin')+':'+env['PATH']
paths=subprocess.check_output(['git','ls-files','-co','--exclude-standard'],cwd=root,text=True).splitlines()
sources={p:hashlib.sha256((root/p).read_bytes()).hexdigest() for p in paths if p.startswith(('src/','server/','tests/','tooling/','vendor/')) and not p.startswith(('tests/editor/evidence/','tests/editor/artifacts/','tests/text/artifacts/','tests/text-state/artifacts/')) and (root/p).is_file()}
meta={'command':command,'cwd':str(root),'head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),'start':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source':sources,'qualification':'Author functional check only; not performance or independent acceptance'}
meta['environment']={k:env[k] for k in ['EDITOR_BROWSER','EDITOR_RECEIPT','TEXT_STATE_APP','TEXT_STATE_EVIDENCE','TEXT_STATE_ENGINES','IE_RECOVERY_OUTPUT'] if k in env}
with (out/'output.txt').open('x') as log:r=subprocess.run(command,cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT)
meta.update(end=datetime.datetime.now(datetime.timezone.utc).isoformat(),exitCode=r.returncode)
(out/'receipt.json').write_text(json.dumps(meta,indent=2)+'\n')
print(json.dumps({k:v for k,v in meta.items() if k!='source'}));print((out/'output.txt').read_text()[-4500:]);sys.exit(r.returncode)
