from pathlib import Path
import json,subprocess,os,sys
r=Path(__file__).resolve().parent
for name,cmd,extra in json.loads((r/'browser-plan.json').read_text()):
 p=subprocess.run(['python3',str(r/'gate.py'),name,*cmd],env={**os.environ,**extra},capture_output=True,text=True);q=r/'gates'/name/'receipt.json';d=json.loads(q.read_text()) if q.exists() else {};print(json.dumps({k:d.get(k) for k in ['name','start','end','exit']}),flush=True)
 if p.returncode:print(p.stderr,p.stdout[-1000:]);sys.exit(p.returncode)
