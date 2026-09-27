from pathlib import Path
import datetime,hashlib,json,os,shutil,subprocess
packet=Path(__file__).resolve().parent
repo=packet/'source'
service=packet.parent/'ideogram-edit-p1c3-preview-1888c6a0'
evidence=packet/'preview-service'
assert not service.exists() and not evidence.exists()
service.mkdir(mode=0o700);evidence.mkdir()
def digest(data):return hashlib.sha256(data).hexdigest()
def save(relative,data):
 p=service/relative;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(data)
 return digest(data)
build={}
for path,record in json.loads((packet/'build-files.json').read_text())['files'].items():
 data=(packet/'sealed-build'/path).read_bytes();assert len(data)==record['bytes'] and digest(data)==record['sha256']
 build['dist/'+path]=save('dist/'+path,data)
extras={}
for relative in ['src/text/profile.json','src/text/retained-profiles/c19791ae.json','src/text/retained-profiles/b89503d3.json','src/text/retained-profiles/6e8a481e.json','src/text/retained-profiles/d047f5be.json','tests/protocol/no-effects.mjs','tests/store/no-network.mjs','package.json','package-lock.json']:
 data=subprocess.check_output(['git','show','1888c6a04d43b1991b539ddd60511b7619036cf6:'+relative],cwd=repo)
 extras[relative]=save(relative,data)
packages={};pending=['fs-ext','sharp','canvaskit-wasm']
while pending:
 name=pending.pop()
 if name in packages:continue
 source=repo/'node_modules'/name
 if not source.exists():continue
 assert source.is_dir() and not source.is_symlink()
 package=json.loads((source/'package.json').read_text());packages[name]=package['version']
 for p in source.rglob('*'):
  assert not p.is_symlink(),p
  if p.is_file():
   relative=(Path('node_modules')/name/p.relative_to(source)).as_posix();extras[relative]=save(relative,p.read_bytes())
 pending.extend([*package.get('dependencies',{}),*package.get('optionalDependencies',{})])
source=json.loads((packet/'source-inputs.json').read_text())
runtime={k:v['sha256'] for k,v in source['files'].items() if k.startswith(('src/','server/')) or k in ['index.html','package.json','package-lock.json','vite.app.config.ts']}
identity={'created':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceCommit':source['sourceCommit'],'checkerCommit':'fdcccac486c8c99de8f1603e5dedb9ddbbd33a41','rejectedTarget':'d3f7cc351ca76e9dff6dc52e6cd9ca78ccb7ff50','productCommit':'1888c6a04d43b1991b539ddd60511b7619036cf6','buildGate':'04-build','buildSourceCommit':'1888c6a04d43b1991b539ddd60511b7619036cf6','build':build,'runtimeSource':runtime,'runtimeSourceSHA256':digest(json.dumps(runtime,separators=(',',':'),sort_keys=True).encode()),'extraRuntimeFiles':extras,'installedPackages':packages,'scope':'Frozen local AUTHOR review of exact raster input-authority correction1888c6a0 and checkerfdcccac; no independent acceptance; private new root; outgoing effects denied. No old service changes.'}
(service/'source.json').write_text(json.dumps(identity,indent=2)+'\n');(evidence/'source.json').write_text(json.dumps(identity,indent=2)+'\n')
script="""import {startLocalServer} from './dist/local/server/http.js';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('.',import.meta.url));
const identity=JSON.parse(await readFile(new URL('source.json',import.meta.url),'utf8'));
for(const [path,hash] of Object.entries({...identity.build,...identity.extraRuntimeFiles})){const actual=createHash('sha256').update(await readFile(new URL(path,import.meta.url))).digest('hex');if(actual!==hash)throw Error('Frozen runtime mismatch: '+path);}
const server=await startLocalServer({root:root+'private',staticDirectory:root+'dist/app',credentialConfigured:false},{writer:{effectCounters:globalThis.__storeNetworkCounters.shared}});
await writeFile(new URL('runtime.json',import.meta.url),JSON.stringify({started:new Date().toISOString(),pid:process.pid,origin:server.origin,reviewURL:server.origin+'/?progress-report',sourceCommit:identity.sourceCommit,runtimeSourceSHA256:identity.runtimeSourceSHA256,buildFiles:Object.keys(identity.build).length,extraRuntimeFiles:Object.keys(identity.extraRuntimeFiles).length,node:process.version,executable:process.execPath,service:root,root:root+'private',mode:'isolated AUTHOR review; no independent approval; outgoing effects denied'},null,2)+'\\n');
const input=createInterface({input:process.stdin,terminal:false});
input.on('line',line=>{if(line==='pair-file')void writeFile(new URL('pairing.json',import.meta.url),JSON.stringify({url:server.issuePairingURL().replace('/#','/?progress-report#')}),{mode:0o600});if(line==='effects')void writeFile(new URL('effects.json',import.meta.url),JSON.stringify(globalThis.__storeNetworkCounters.read()));});
const stop=()=>{input.close();void server.close();};process.once('SIGINT',stop);process.once('SIGTERM',stop);
console.log('Isolated P1c.3 author review service ready; private control FIFO supplies pairing.');
"""
(service/'run.mjs').write_text(script);(evidence/'run.mjs.txt').write_text(script)
os.mkfifo(service/'control',0o600);fd=os.open(service/'control',os.O_RDWR)
with (service/'service.log').open('wb') as log:
 process=subprocess.Popen([str(repo/'.toolchain/bin/node'),'--import',str(service/'tests/protocol/no-effects.mjs'),str(service/'run.mjs')],cwd=service,stdin=fd,stdout=log,stderr=log,start_new_session=True)
os.close(fd)
receipt={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'pid':process.pid,'service':str(service),'sourceCommit':source['sourceCommit'],'runtimeSourceSHA256':identity['runtimeSourceSHA256'],'buildFiles':len(build),'extraRuntimeFiles':len(extras),'installedPackages':packages,'status':'start requested; readiness/served identity not yet verified'}
(evidence/'start.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))
