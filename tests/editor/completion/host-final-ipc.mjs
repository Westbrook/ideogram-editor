import assert from 'node:assert/strict';
import {privateHostReceiver} from './host-final-receiver.mjs';
export function ownedHostIPC({server,instance,pid=process.pid,send,disconnect,uninstall,health,abruptStop,createReceiver=privateHostReceiver}){
 let host;const state={errors:[],closed:false};
 return {state,handles:url=>host?.handles(url)??false,handleRequest:(...args)=>{assert(host);return host.handle(...args);},
 async message(m){
  if(m?.type==='host'){try{const a=m.args??{};let value;
   if(m.method==='configure'){assert(!host,'Single own server configuration');assert.equal(a.origin,server.origin);host=createReceiver({run:a.run,origin:server.origin,pid,instance});value={run:a.run,origin:server.origin,pid,instance};}
   else {assert(host,'Private host receiver configured');if(m.method==='allocate')value=host.allocate(a);else if(m.method==='arm')value=host.arm(a.nonce,a.value);else if(m.method==='drain')value=await host.drain(a.nonce,a.deadline);else if(m.method==='snapshot')value=structuredClone(host.data);else if(m.method==='assertDrained')value=host.assertDrained();else throw Error('Unknown private IPC method');}
   send({type:m.reply,value});
  }catch(e){send({type:m.reply,error:{message:String(e),stack:e.stack}});}return;}
  if(m?.type==='completion-close'){
   const failures=[],reply=value=>send(m.reply?{type:m.reply,value}:value),retain=(phase,e)=>{const f={phase,message:String(e)};failures.push(f);state.errors.push(f);};
   try{assert(host);host.assertDrained();}catch(e){retain('close-prerequisite',e);if(!m.cleanupOnly){reply({type:'close-refused',failures});return;}}
   // A deliberate restart keeps the writer's abrupt SIGKILL semantics. The
   // installed snapshot, IPC send and self-signal share one synchronous turn.
   // No clean server close, uninstall or post-exit observation is claimed.
   if(m.mode==='restart'&&!m.cleanupOnly){
    try{assert(health&&abruptStop);const before=health.snapshot();reply({type:'completion-closed',failures,cleanupOnly:false,serverClosed:false,recorder:{kind:'abrupt',before}});abruptStop();}catch(e){retain('abrupt-stop',e);reply({type:'close-refused',failures});}return;
   }
   const recorder={kind:'graceful'};
   try{await server.close();state.closed=true;}catch(e){retain('server-close',e);}
   try{recorder.before=health?.snapshot();}catch(e){retain('recorder-before-uninstall',e);}
   try{await uninstall();health?.removed();}catch(e){retain('uninstall',e);}
   try{recorder.after=health?.snapshot('closed');}catch(e){retain('recorder-final',e);}
   try{reply({type:'completion-closed',failure:failures[0]?.message,failures,cleanupOnly:!!m.cleanupOnly,serverClosed:state.closed,recorder});}catch(e){retain('close-reply',e);}
   try{disconnect();}catch(e){retain('disconnect',e);}
  }
 }
 };
}
