import {startLocalServer} from '../../dist/local/server/http.js';
const server=await startLocalServer({root:process.argv[2],staticDirectory:process.argv[3]||undefined}, {writer:{phase:process.argv[4]||undefined,gate:new SharedArrayBuffer(4),onBarrier:phase=>process.send({type:'barrier',phase})}});
process.send({type:'ready',origin:server.origin,url:server.issuePairingURL()});
process.on('message',m=>{if(m==='memory')process.send({type:'memory',usage:process.memoryUsage()});if(m==='close')void server.close().then(()=>process.disconnect());});
