// Real faults are confined to this disposable mounted image, never the host volume.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { closeSync,fsyncSync,ftruncateSync,openSync,statfsSync,writeSync } from 'node:fs';
import { mkdir,mkdtemp,realpath,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { startLocalServer } from '../../dist/local/server/http.js';
import { call,pair,exchange,cookieFrom,readHeaders,mutationHeaders } from '../session/helpers.mjs';

test('actual upload ENOSPC after reservation preserves prior offset and resumes after capacity returns',async t=>{
  assert.equal(process.platform,'darwin');const directory=await mkdtemp(join(await realpath(tmpdir()),'ie-assets-volume-'));const mount=join(directory,'mount');const image=join(directory,'fault.sparseimage');await mkdir(mount);let attached=false,server,fd;
  const bytes=Buffer.alloc(1048580,97);const s={protocolVersion:1,stagingId:'real_enospc',purpose:'caption',expectedBytes:String(bytes.length),sha256:'sha256:'+createHash('sha256').update(bytes).digest('hex'),mediaType:'text/plain'};
  try{
    execFileSync('/usr/bin/hdiutil',['create','-size','2g','-type','SPARSE','-fs','HFS+','-volname','IdeogramAssetFault',image],{stdio:'pipe'});execFileSync('/usr/bin/hdiutil',['attach','-nobrowse','-owners','on','-mountpoint',mount,image],{stdio:'pipe'});attached=true;const root=join(mount,'private');
    server=await startLocalServer({root});let paired=await pair(server);assert.equal((await call(server.origin,'/api/v1/assets/staging',{method:'POST',body:s,headers:mutationHeaders(server,paired)})).status,201);
    assert.equal((await call(server.origin,'/api/v1/assets/staging/'+s.stagingId,{method:'PUT',raw:bytes.subarray(0,4),headers:{...mutationHeaders(server,paired),'Content-Type':'application/octet-stream','Upload-Offset':'0'}})).status,200);const cookie=cookieFrom(paired);await server.close();
    const gate=new SharedArrayBuffer(4);let entered;const hit=new Promise(r=>entered=r);let nativeError;
    server=await startLocalServer({root},{writer:{phase:'upload-before-write',gate,onBarrier:()=>entered(),onFailure:e=>nativeError=e}});
    paired=await call(server.origin,'/api/v1/session/bootstrap',{method:'POST',headers:{Origin:server.origin,Cookie:cookie},body:{protocolVersion:1,pairingToken:new URL(server.issuePairingURL()).hash.slice(9)}});
    const pending=exchange(server.origin,'/api/v1/assets/staging/'+s.stagingId,{method:'PUT',raw:bytes.subarray(4),headers:{...mutationHeaders(server,paired),'Content-Type':'application/octet-stream','Upload-Offset':'4'}}).response;await hit;
    fd=openSync(join(mount,'filler'),'wx',0o600);let filled=0;for(const size of [1048576,4096,512]){const block=Buffer.alloc(size,123);try{for(;;)filled+=writeSync(fd,block);}catch(e){assert.equal(e.code,'ENOSPC');}}fsyncSync(fd);const free=statfsSync(mount);Atomics.store(new Int32Array(gate),0,1);Atomics.notify(new Int32Array(gate),0);
    const failed=await pending;assert.equal(failed.status,507,failed.text);assert.equal(nativeError.code,'ENOSPC');assert.equal((await call(server.origin,'/api/v1/assets/staging/'+s.stagingId,{headers:readHeaders(cookieFrom(paired))})).json.committedOffset,'4');
    ftruncateSync(fd,0);fsyncSync(fd);closeSync(fd);fd=undefined;
    assert.equal((await call(server.origin,'/api/v1/assets/staging/'+s.stagingId,{method:'PUT',raw:bytes.subarray(4),headers:{...mutationHeaders(server,paired),'Content-Type':'application/octet-stream','Upload-Offset':'4'}})).json.committedOffset,String(bytes.length));await server.close();server=undefined;
    execFileSync('/usr/bin/hdiutil',['detach',mount],{stdio:'pipe'});attached=false;execFileSync('/usr/bin/hdiutil',['attach','-readonly','-nobrowse','-owners','on','-mountpoint',mount,image],{stdio:'pipe'});attached=true;
    assert.throws(()=>openSync(join(root,'writer.lock'),'r+'),{code:'EROFS'});await assert.rejects(startLocalServer({root}));
    t.diagnostic(JSON.stringify({fillerBytes:filled,availableAtFault:free.bavail*free.bsize,actualError:nativeError.code,readOnlyError:'EROFS',offsetBefore:'4',offsetRecovered:String(bytes.length),reservationMarginBytes:'1073741824',powerLossQualified:false}));
  }finally{if(fd!==undefined)closeSync(fd);if(server)await server.close();if(attached)execFileSync('/usr/bin/hdiutil',['detach',mount],{stdio:'pipe'});await rm(directory,{recursive:true,force:true});}
});
