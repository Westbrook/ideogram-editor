import {startLocalServer} from './dist/local/server/http.js';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('.',import.meta.url));
const identity=JSON.parse(await readFile(new URL('source.json',import.meta.url),'utf8'));
for(const [path,hash] of Object.entries(identity.build)){const actual=createHash('sha256').update(await readFile(new URL(path,import.meta.url))).digest('hex');if(actual!==hash)throw Error('Frozen build mismatch');}
const server=await startLocalServer({root:root+'private',staticDirectory:root+'dist/app',credentialConfigured:false},{writer:{effectCounters:globalThis.__storeNetworkCounters.shared}});
await writeFile(new URL('runtime.json',import.meta.url),JSON.stringify({started:new Date().toISOString(),pid:process.pid,origin:server.origin,reviewURL:server.origin+'/?progress-report',runtimeSourceSHA256:identity.runtimeSourceSHA256,node:process.version,executable:process.execPath,service:root,root:root+'private',mode:'isolated author review; no independent approval; outgoing effects denied'},null,2)+'\n');
const input=createInterface({input:process.stdin,terminal:false});
input.on('line',line=>{if(line==='pair-file')void writeFile("/Users/westbrook/Documents/repos/ideogram-edit/artifacts/webkit-rail-private/pairing.json",JSON.stringify({url:server.issuePairingURL().replace('/#','/?progress-report#')}),{mode:0o600});if(line==='effects')void writeFile(new URL('effects.json',import.meta.url),JSON.stringify(globalThis.__storeNetworkCounters.read()));});
const stop=()=>{input.close();void server.close();};process.once('SIGINT',stop);process.once('SIGTERM',stop);
console.log('Isolated browser integration review service ready; use private control FIFO.');
