import {startLocalServer} from '../../dist/local/server/http.js';
const server=await startLocalServer({root:process.argv[2],staticDirectory:process.argv[3],credentialConfigured:false},{writer:{maxPageCount:process.argv[4]?Number(process.argv[4]):undefined,effectCounters:globalThis.__storeNetworkCounters.shared}});
process.send({type:'ready',origin:server.origin});
process.on('message',m=>{
 if(m==='pair')process.send({type:'pair',url:server.issuePairingURL()});
 if(m==='resources')process.send({type:'resources',value:process.memoryUsage()});
 if(m==='effects')process.send({type:'effects',value:globalThis.__storeNetworkCounters.read()});
 if(m==='close')void server.close().then(()=>process.disconnect());
});
