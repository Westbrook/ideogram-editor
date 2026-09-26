import subprocess,sys,json,datetime,os,hashlib
from pathlib import Path
root=Path(__file__).resolve().parent;src=root/'source';label=sys.argv[1];cmd=sys.argv[2:]
def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
files=subprocess.check_output(['git','ls-files'],cwd=src,text=True).splitlines()+subprocess.check_output(['git','ls-files','--others','--exclude-standard'],cwd=src,text=True).splitlines()
record={'cwd':str(src),'command':cmd,'start':now(),'sources':{f:hashlib.sha256((src/f).read_bytes()).hexdigest() for f in files if (src/f).is_file()}}
(root/(label+'.sources.json')).write_text(json.dumps(record['sources'],indent=2));del record['sources']
env={**os.environ,'PATH':str(src/'.toolchain/bin')+':'+os.environ['PATH']}
with (root/(label+'.log')).open('xb') as log:
 p=subprocess.run(cmd,cwd=src,env=env,stdout=log,stderr=subprocess.STDOUT)
record.update(end=now(),exit=p.returncode);(root/(label+'.receipt.json')).write_text(json.dumps(record,indent=2));print(json.dumps(record));print((root/(label+'.log')).read_text()[-5000:]);sys.exit(p.returncode)
