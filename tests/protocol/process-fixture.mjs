import { startLocalServer } from '../../dist/local/server/http.js';
const gate=new SharedArrayBuffer(4);
// Observation only: retain at most 16 sanitized failures plus one truncation
// marker. A closed diagnostic channel must not change a command outcome.
let writerFailures=0;
function reportWriterFailure(failure){
  if(writerFailures>=17||!process.connected)return;
  const occurrence=++writerFailures,detail={};
  if(typeof failure?.code==='string'&&/^[A-Z_0-9]{1,64}$/.test(failure.code))detail.code=failure.code;
  if(Number.isSafeInteger(failure?.sqliteCode))detail.sqliteCode=failure.sqliteCode;
  try{process.send({type:'writer-failure',occurrence,...occurrence===17?{truncated:true}:{failure:detail}},()=>{});}catch{}
}
const server=await startLocalServer({root:process.argv[2]}, {writer:{phase:process.argv[3]||undefined,gate,
  effectCounters:globalThis.__storeNetworkCounters?.shared,onFailure:reportWriterFailure,onBarrier:phase=>process.send({type:'barrier',phase})}});
process.send({type:'ready',origin:server.origin});
process.on('message',message=>{
  if(message==='pair')process.send({type:'pair',url:server.issuePairingURL()});
  if(message==='effects')process.send({type:'effects',value:globalThis.__storeNetworkCounters.read()});
  if(message==='release')Atomics.store(new Int32Array(gate),0,1),Atomics.notify(new Int32Array(gate),0);
  if(message==='close')void server.close().then(()=>process.disconnect());
});
