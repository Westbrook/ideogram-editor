import subprocess, pathlib, os, json, hashlib
root=pathlib.Path(__file__).resolve().parent
legacy=root/'legacy-text-v1';src=legacy/'source';src.mkdir(parents=True)
base='648a35abce7c2a91e90c132c38b6868f2790e5a1'
subprocess.run(['git','archive','--output='+str(legacy/'source.tar'),base,'server','src','tests','tooling','tsconfig.server.json'],check=True)
subprocess.run(['tar','-xf',str(legacy/'source.tar'),'-C',str(src)],check=True)
(src/'package.json').write_text('{"type":"module"}')
(src/'node_modules').symlink_to(root/'source/node_modules',target_is_directory=True)
(src/'vendor').mkdir();(src/'vendor/text').symlink_to(root/'source/vendor/text',target_is_directory=True)
(src/'evidence/p1c2-text-state').mkdir(parents=True)
helper=(root/'controls-v1.mjs').read_text()
helper=helper.replace("['plain','nfd','leading-bom','reversed-line-range','missing-runs','mismatched-pixels','wrong-direction']", "['plain','nfd']")
helper=helper.replace("target:'648a35abce7c2a91e90c132c38b6868f2790e5a1'", "target:'648a35abce7c2a91e90c132c38b6868f2790e5a1 valid historical fixture only'")
(legacy/'valid-fixture-v1.mjs').write_text(helper)
(legacy/'source-inputs.json').write_text(json.dumps({str(p.relative_to(src)):hashlib.sha256(p.read_bytes()).hexdigest() for parent in ['server','src','tests','tooling'] for p in (src/parent).rglob('*') if p.is_file()},indent=2))
for command in [[str(src/'node_modules/.bin/tsc'),'-p','tsconfig.server.json'],[str(src/'node_modules/.bin/vite'),'build','--config','tests/text-state/vite.config.ts'],['node','--import','./tests/session/no-egress.mjs','../valid-fixture-v1.mjs','chromium']]:
 print(json.dumps({'historicalTarget':base,'cwd':str(src),'command':command}),flush=True)
 subprocess.run(command,cwd=src,check=True)
