import {startLocalServer} from '../../dist/local/server/http.js';
const gate=new SharedArrayBuffer(4);
const server=await startLocalServer({root:process.argv[2],staticDirectory:process.argv[3],credentialConfigured:false},{writer:{phase:'history-after-proofs',gate,onBarrier:phase=>process.send({type:'barrier',phase}),effectCounters:globalThis.__storeNetworkCounters.shared}});
process.send({type:'ready',origin:server.origin});
process.on('message',m=>{
 if(m==='pair')process.send({type:'pair',url:server.issuePairingURL()});
 if(m==='release'){Atomics.store(new Int32Array(gate),0,1);Atomics.notify(new Int32Array(gate),0);}
 if(m==='effects')process.send({type:'effects',value:globalThis.__storeNetworkCounters.read()});
 if(m==='close')void server.close().then(()=>process.disconnect());
});
