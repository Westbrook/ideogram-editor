from pathlib import Path
import subprocess,sys,json,datetime,os
root=Path('/Users/westbrook/Documents/repos/ideogram-edit');out=Path(__file__).parent
name=sys.argv[1];argv=sys.argv[2:];target=out/name;target.mkdir()
env=os.environ.copy();env['PATH']=str(root/'.toolchain/bin')+':'+env['PATH'];env['EDITOR_RECEIPT']=str(target);env['EDITOR_BROWSER']=os.environ.get('EDITOR_BROWSER','webkit')
def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
r={'name':name,'argv':argv,'cwd':str(root),'engine':env['EDITOR_BROWSER'],'receipt':str(target),'start':now()}
with (target/'stdout.txt').open('w') as f:p=subprocess.run(argv,cwd=root,env=env,stdout=f,stderr=subprocess.STDOUT)
r.update(end=now(),exit=p.returncode);(target/'command.json').write_text(json.dumps(r,indent=2)+'\n')
with (out/'commands.jsonl').open('a') as f:f.write(json.dumps(r)+'\n')
print(json.dumps(r));print((target/'stdout.txt').read_text()[-6000:]);sys.exit(p.returncode)
