// Only the process boundary differs from the original chain fixture. The
// writer, loopback provider, diagnostic observer and shutdown checks are real.
import {startLocalServer} from '../../dist/local/server/http.js';

const server=await startLocalServer({root:process.argv[2]},{writer:{setupModule:new URL('./candidate-copy-observer-fixture.mjs',import.meta.url).href}});
let closing;
function close(){
  return closing??=(async()=>{
    try{
      await server.close();
      if(process.connected)process.send({type:'closed'},()=>process.disconnect());
    }catch(error){
      process.exitCode=1;
      if(process.connected)process.send({type:'failure',message:String(error).slice(0,4096)},()=>process.disconnect());
      else console.error(error);
    }
  })();
}
process.on('message',message=>{
  if(message==='close')void close();
  else throw new Error('Unexpected candidate-copy child control message');
});
process.once('disconnect',()=>{void close();});
process.send({type:'ready',origin:server.origin,pairingURL:server.issuePairingURL()});
