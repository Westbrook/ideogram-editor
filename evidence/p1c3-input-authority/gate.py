import sys,os,subprocess,json,datetime,hashlib
from pathlib import Path
r=Path(__file__).resolve().parent;source=r/'source';name=sys.argv[1];argv=sys.argv[2:];out=r/'gates'/name;out.mkdir(parents=True,exist_ok=False)
def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
env=os.environ.copy();env['PATH']=str(source/'.toolchain/bin')+os.pathsep+env['PATH'];env['npm_config_cache']=str(r/'npm-cache')
receipt={'name':name,'argv':argv,'cwd':str(source),'start':now(),'head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=source,text=True).strip(),'status':subprocess.check_output(['git','status','--short','--untracked-files=no'],cwd=source,text=True),'env':{k:v for k,v in env.items() if k in ['PATH','npm_config_cache','TEXT_STATE_APP','TEXT_STATE_EVIDENCE','TEXT_STATE_ENGINES','IE_RECOVERY_OUTPUT','EDITOR_BROWSER','EDITOR_RECEIPT']},'inputs':{p:hashlib.sha256((source/p).read_bytes()).hexdigest() for p in ['server/storage/raster.ts','tests/raster/input-authority.test.mjs','src/text/profile.json']}}
(out/'started.json').write_text(json.dumps(receipt,indent=2)+'\n')
with (out/'output.txt').open('w') as f:p=subprocess.run(argv,cwd=source,env=env,stdout=f,stderr=subprocess.STDOUT)
receipt.update(end=now(),exit=p.returncode);(out/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt),flush=True);sys.exit(p.returncode)
