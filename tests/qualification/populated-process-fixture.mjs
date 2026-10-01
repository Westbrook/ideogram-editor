import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {startLocalServer} from '../../dist/local/server/http.js';

const root=process.argv[2];
const server=await startLocalServer({root,staticDirectory:process.argv[3],credentialConfigured:false},{writer:{setupModule:new URL('./populated-observer-fixture.mjs',import.meta.url).href}});
process.send({type:'ready',origin:server.origin});
process.on('message',message=>{
  if(message==='pair')process.send({type:'pair',url:server.issuePairingURL()});
  if(message==='effects')void readFile(join(root,'axe-populated-observer.json'),'utf8').then(value=>process.send({type:'effects',value:JSON.parse(value)}));
  if(message==='close')void server.close().then(()=>process.disconnect());
});
