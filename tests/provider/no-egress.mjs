// Guard all TCP and DNS access in the test process before importing the product.
import net from 'node:net';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
const original=net.Socket.prototype.connect;
const attempts=[];
net.Socket.prototype.connect=function(...args){
  const normalized=Array.isArray(args[0])?args[0]:args;
  const opt=normalized[0],host=typeof opt==='object'?(opt.host??opt.hostname):normalized[1];
  if(host!=='127.0.0.1'){attempts.push(String(host));throw Error('P2.1 test denied external socket');}
  return original.apply(this,args);
};
const deny=()=>{attempts.push('DNS');throw Error('P2.1 test denied ambient DNS');};
for(const target of [dns,dnsPromises])for(const name of Object.keys(target))if(name==='lookup'||name==='lookupService'||name.startsWith('resolve'))target[name]=deny;
dns.lookup=(hostname,options,callback)=>{
  if(hostname!=='127.0.0.1')return deny();
  if(typeof options==='function'){callback=options;options={};}
  queueMicrotask(()=>options?.all?callback(null,[{address:'127.0.0.1',family:4}]):callback(null,'127.0.0.1',4));
};
dnsPromises.lookup=async(hostname,options)=>{if(hostname!=='127.0.0.1')return deny();return options?.all?[{address:'127.0.0.1',family:4}]:{address:'127.0.0.1',family:4};};
syncBuiltinESMExports();
export function egressAttempts(){return [...attempts];}

process.on('exit',()=>{if(attempts.length){process.stderr.write('P2.1 denied egress attempts: '+JSON.stringify(attempts)+'\n');process.exitCode=1;}});
