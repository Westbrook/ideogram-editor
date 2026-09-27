from pathlib import Path
import datetime,hashlib,json,os,shutil,subprocess
repo=Path(__file__).resolve().parents[2]
service=repo.parent/'ideogram-edit-p1c3-preview-e070baff'
evidence=repo/'evidence/p1c3/81-preview-service'
assert not service.exists() and not evidence.exists()
service.mkdir(mode=0o700);evidence.mkdir()
def digest(data):return hashlib.sha256(data).hexdigest()
def save(relative,data):
 p=service/relative;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(data)
 return digest(data)
build={}
for path,record in json.loads((repo/'evidence/p1c3/build-files.json').read_text())['files'].items():
 data=(repo/path).read_bytes();assert len(data)==record['bytes'] and digest(data)==record['sha256']
 build[path.replace('evidence/p1c3/sealed-build/','dist/')]=save(path.replace('evidence/p1c3/sealed-build/','dist/'),data)
extras={}
for relative in ['src/text/profile.json','src/text/retained-profiles/c19791ae.json','src/text/retained-profiles/b89503d3.json','src/text/retained-profiles/6e8a481e.json','tests/protocol/no-effects.mjs','tests/store/no-network.mjs','package.json','package-lock.json']:
 data=subprocess.check_output(['git','show','e070baff7069a319f92a39e6c369378a31424181:'+relative],cwd=repo)
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
source=json.loads((repo/'evidence/p1c3/source-inputs.json').read_text())
runtime={k:v['sha256'] for k,v in source['files'].items() if k.startswith(('src/','server/')) or k in ['index.html','package.json','package-lock.json','vite.app.config.ts']}
identity={'created':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceCommit':source['sourceCommit'],'checkerCommit':'a78aa8879291c3bdc938796d64b4aa4926e7df93','firstEvidenceCommit':'01de7559f6ae02a0d770be550154da11bf18b865','buildGate':'65-build','build':build,'runtimeSource':runtime,'runtimeSourceSHA256':digest(json.dumps(runtime,separators=(',',':'),sort_keys=True).encode()),'extraRuntimeFiles':extras,'installedPackages':packages,'scope':'Frozen local AUTHOR review of exact product e070baff; no independent acceptance; private new root; outgoing effects denied. No old service changes.'}
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
