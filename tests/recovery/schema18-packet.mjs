// Test prerequisite installer for actual legacy-root migrations. The supplied
// executable must already have passed the separate capture/restore campaign.
// This helper neither manufactures an old database nor qualifies a packet.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open,lstat,mkdir} from 'node:fs/promises';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {compositionTextExecutablePin,compositionTextInstalledPacket,schema18PacketIdentity} from '../../dist/local/server/storage/composition-text-schema.js';

const stamp=s=>[s.dev,s.ino,s.mode,s.nlink,s.size,s.mtimeMs,s.ctimeMs];
const same=(a,b)=>assert.deepEqual(stamp(a),stamp(b),'A held packet file changed identity');
async function directory(path,privateMode=false){
 const value=await lstat(path);assert(value.isDirectory()&&!value.isSymbolicLink(),path);
 if(privateMode){assert.equal(value.uid,process.getuid());assert.equal(value.mode&0o077,0,path);}
}
async function ancestors(path){
 for(let parent=dirname(path);;parent=dirname(parent)){await directory(parent);if(dirname(parent)===parent)break;}
}
async function held(path,expected,write=null,max=8*1024**3){
 assert(isAbsolute(path)&&resolve(path)===path,'Use a canonical absolute packet path');await ancestors(path);
 const before=await lstat(path);assert(before.isFile()&&!before.isSymbolicLink());assert(before.size<=max);
 const source=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 const digest=createHash('sha256'),block=Buffer.alloc(Math.min(1048576,Math.max(1,before.size))),chunks=[];
 let remaining=before.size;
 try{
  same(before,await source.stat());
  while(remaining){const {bytesRead}=await source.read(block,0,Math.min(block.length,remaining),null);assert(bytesRead,'Packet file shortened');remaining-=bytesRead;const part=block.subarray(0,bytesRead);digest.update(part);
   if(write){let offset=0;while(offset<part.length){const result=await write.write(part,offset,part.length-offset,null);assert(result.bytesWritten);offset+=result.bytesWritten;}}
   else chunks.push(Buffer.from(part));
  }
  assert.equal((await source.read(block,0,1,null)).bytesRead,0,'Packet file grew');same(before,await source.stat());same(before,await lstat(path));
 }finally{await source.close();}
 const identity={hash:'sha256:'+digest.digest('hex'),byteLength:String(before.size)};
 if(expected)assert.deepEqual(identity,{hash:expected.hash,byteLength:expected.byteLength});
 return {identity,bytes:write?null:Buffer.concat(chunks)};
}

export async function installSchema18Packet(root){
 const pin=compositionTextExecutablePin();
 assert(pin,'Seal the actual independently restored schema18 executable before running legacy migrations');
 await directory(root,true);
 const parent=join(root,'rollback-executables'),target=join(parent,pin.packetId);
 try{await lstat(target);compositionTextInstalledPacket(root);return;}
 catch(error){if(error.code!=='ENOENT')throw error;}
 const input=process.env.IE_SCHEMA18_EXECUTABLE_PACKET;
 assert(input&&isAbsolute(input),'Legacy migration tests require IE_SCHEMA18_EXECUTABLE_PACKET naming the actual qualified schema18 packet');
 const descriptor=await held(input,null,null,65536),packet=JSON.parse(descriptor.bytes.toString('utf8'));
 assert.equal(packet.kind,'schema18-executable-packet-1');assert.equal(packet.storageVersion,18);
 assert.equal(packet.packetId,pin.packetId);assert.equal(schema18PacketIdentity(packet),pin.identityHash);assert.deepEqual(packet.platform,pin.platform);
 try{await mkdir(parent,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
 await directory(parent,true);await mkdir(target,{mode:0o700});let index=0;
 const copy=async ref=>{
  const path=join(target,String(index++).padStart(3,'0')+'.sealed');
  const output=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{await held(ref.path,ref,output);await output.sync();}finally{await output.close();}
  return {...ref,path};
 };
 const installed={...packet,sourceArchive:await copy(packet.sourceArchive),sourceManifest:await copy(packet.sourceManifest),compiledClosures:[],verifiedFreshRestore:{...packet.verifiedFreshRestore}};
 for(const closure of packet.compiledClosures)installed.compiledClosures.push({...closure,archive:await copy(closure.archive),manifest:await copy(closure.manifest)});
 installed.verifiedFreshRestore.receipt=await copy(packet.verifiedFreshRestore.receipt);
 assert.equal(schema18PacketIdentity(installed),pin.identityHash);
 const output=await open(join(target,'packet.json'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{await output.writeFile(JSON.stringify(installed)+'\n');await output.sync();}finally{await output.close();}
 for(const path of [target,parent]){const fd=await open(path,constants.O_RDONLY);try{await fd.sync();}finally{await fd.close();}}
 // The product's full receipt, archive identity, private filename and platform
 // validation remains authoritative; a copied descriptor alone is insufficient.
 compositionTextInstalledPacket(root);
 await held(input,descriptor.identity,null,65536);
}
