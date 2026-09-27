import os,subprocess,sys
checks=[('40-authority-final',['.toolchain/bin/node','--import','./tests/session/no-egress.mjs','evidence/p1c3-correction/independent-mask-authority-v3.mjs'],{}),('35-firefox',['.toolchain/bin/node','node_modules/@playwright/test/cli.js','test','--config','tests/editor/authoring.config.ts'],{'EDITOR_BROWSER':'firefox','EDITOR_RECEIPT':'evidence/p1c3-correction/browser35'}),('36-webkit',['.toolchain/bin/node','node_modules/@playwright/test/cli.js','test','--config','tests/editor/authoring.config.ts'],{'EDITOR_BROWSER':'webkit','EDITOR_RECEIPT':'evidence/p1c3-correction/browser36'})]
for name,command,env in checks:
 print('START '+name,flush=True)
 result=subprocess.run(['python3','evidence/p1c3-correction/run-gate.py',name]+command,env=dict(os.environ,**env))
 if result.returncode:sys.exit(result.returncode)
 print('PASS '+name,flush=True)
