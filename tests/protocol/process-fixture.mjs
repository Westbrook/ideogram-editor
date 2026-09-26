import { startLocalServer } from '../../dist/local/server/http.js';
const gate=new SharedArrayBuffer(4);
const server=await startLocalServer({root:process.argv[2]}, {writer:{phase:process.argv[3]||undefined,gate,
  effectCounters:globalThis.__storeNetworkCounters?.shared,onBarrier:phase=>process.send({type:'barrier',phase})}});
process.send({type:'ready',origin:server.origin});
process.on('message',message=>{
  if(message==='pair')process.send({type:'pair',url:server.issuePairingURL()});
  if(message==='effects')process.send({type:'effects',value:globalThis.__storeNetworkCounters.read()});
  if(message==='release')Atomics.store(new Int32Array(gate),0,1),Atomics.notify(new Int32Array(gate),0);
  if(message==='close')void server.close().then(()=>process.disconnect());
});
