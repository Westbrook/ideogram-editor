import glob,json,os,pathlib,subprocess,sys
root=pathlib.Path(__file__).resolve().parents[2]
node=['.toolchain/bin/node'];test=node+['--import','./tests/session/no-egress.mjs','--test','--test-concurrency=1']
gates=[
 ('19-types',['.toolchain/bin/npm','run','typecheck'],{}),
 ('20-build',['python3','-c','import shutil,subprocess; shutil.rmtree("dist/local"); raise SystemExit(subprocess.call([".toolchain/bin/npm","run","build"]))'],{}),
 ('21-text-seal',node+['tooling/text/verify.mjs'],{}),
 ('22-raster-seal',node+['tooling/raster/verify-inputs.mjs'],{}),
 ('23-vendor',['python3','tooling/verify-vendor.py'],{}),
 ('24-imports',node+['tooling/verify-imports.mjs'],{}),
 ('25-history',test+sorted(glob.glob('tests/history/*.test.mjs')),{}),
 ('26-raster',test+sorted(glob.glob('tests/raster/*.test.mjs')),{}),
 ('27-protocol-session',test+sorted(glob.glob('tests/protocol/*.test.mjs')+glob.glob('tests/session/*.test.mjs')),{}),
 ('28-assets',test+sorted(glob.glob('tests/assets/*.test.mjs')),{}),
 ('29-portable',test+[p for p in sorted(glob.glob('tests/portable/*.test.mjs')) if pathlib.Path(p).name not in ['large.test.mjs','browser-recovery.test.mjs']],{}),
 ('30-text-fixture',node+['node_modules/vite/bin/vite.js','build','--config','tests/text-state/vite.config.ts','--outDir',str(root/'artifacts/p1c3-correction/text-app')],{}),
 ('31-current-native',test+['tests/text-state/native.test.mjs'],{'TEXT_STATE_APP':'artifacts/p1c3-correction/text-app','TEXT_STATE_EVIDENCE':'evidence/p1c3-correction/current-native','TEXT_STATE_ENGINES':'chromium,firefox,webkit'}),
 ('32-text-state',test+['tests/text-state/font.test.mjs','tests/text-state/schema.test.mjs','tests/text-state/admission.test.mjs','tests/text-state/verifier.test.mjs'],{'TEXT_STATE_APP':'artifacts/p1c3-correction/text-app'}),
 ('33-editor-contracts',test+['tests/editor/document-projection.test.mjs','tests/editor/read-adapters.test.mjs','tests/editor/shutdown-console.test.mjs'],{}),
 ('34-namespace-browser',test+['tests/portable/browser-recovery.test.mjs'],{})]
(root/'evidence/p1c3-correction/current-native').mkdir(exist_ok=True)
for name,cmd,values in gates:
 if int(name[:2])<(int(sys.argv[1]) if len(sys.argv)>1 else 19):continue
 env=dict(os.environ,**values)
 print('START '+name,flush=True)
 r=subprocess.run(['python3','evidence/p1c3-correction/run-gate.py',name]+cmd,cwd=root,env=env)
 if r.returncode:print('STOP '+name,flush=True);sys.exit(r.returncode)
 print('PASS '+name,flush=True)
