import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';
import {rasterImportCancellation,RASTER_IMPORT_CANCELLATION_REF} from '../../dist/local/src/protocol/raster-import.js';
const data=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const text=await readFile('src/state/editor-client.ts','utf8'),start=text.indexOf('  async cancelRasterImport('),end=text.indexOf('  async cancelExport(',start);assert(start>=0&&end>start);
// Exercise the exact production method. The reader/transport admission boundary
// is controlled here; the shared reader has separate real-stream allocation gates.
const code=(await transformWithOxc('class Client { importAdmissions=new Map(); '+text.slice(start,end)+' }','import-client.ts')).code;
const factory=await import(data('export default (rasterImportCancellation,reserveCommandWire)=>{'+code+'; return Client;};'));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {resolve,reject,promise};};
function fixture(){
 const counts={wire:0,model:0},calls=[],response=deferred(),admission=deferred();let identity='owner';
 const Client=factory.default(rasterImportCancellation,body=>{counts.wire++;assert.deepEqual(body,{protocolVersion:1});return {wire:JSON.stringify(body),release(){counts.wire--;}};}),client=new Client(),session={identity:()=>identity};client.session=session;
 client.ownedJSON=async(...args)=>{calls.push(args);const value=await response.promise;counts.model++;return {value,release(){counts.model--;}};};
 return {client,session,counts,calls,response,admission,owner:{session,identity:'owner'},change(){identity='other';}};
}
const value=id=>({protocolVersion:1,commandId:id,status:'canceled',receipt:{status:'rejected',commandId:id,code:'INVALID_INPUT',currentRevision:null,details:{...RASTER_IMPORT_CANCELLATION_REF}}});
test('import cancellation waits for original admission, bounds the reply, copies fixed fields and releases its reader',async()=>{
 const f=fixture(),id='pending-import';f.client.importAdmissions.set(id,f.admission.promise);let settled=false;const operation=f.client.cancelRasterImport(id,f.owner).finally(()=>{settled=true;});await Promise.resolve();assert.equal(f.calls.length,0);
 f.admission.resolve();await Promise.resolve();await Promise.resolve();assert.equal(f.calls.length,1);const [path,owner,init,owns,limit,kind]=f.calls[0];assert.equal(path,'/api/v1/commands/'+id+'/cancel-raster-import');assert.equal(owner,'raster-import-cancellation');assert.equal(init.method,'POST');assert.equal(init.signal.aborted,false);assert.equal(owns,undefined);assert.equal(limit,65536);assert.equal(kind,'control');assert.equal(settled,false);
 const retained=value(id);f.response.resolve(retained);const result=await operation;assert.deepEqual(result,retained);assert.notEqual(result,retained);assert.notEqual(result.receipt,retained.receipt);assert.notEqual(result.receipt.details,retained.receipt.details);assert.deepEqual(f.counts,{wire:0,model:0});
});
test('owner change while response is pending drains before rejecting and releases both retained owners',async()=>{
 const f=fixture(),operation=f.client.cancelRasterImport('id',f.owner);let settled=false;void operation.catch(()=>{settled=true;});await Promise.resolve();f.change();await Promise.resolve();assert.equal(settled,false);f.response.resolve(value('id'));await assert.rejects(operation,/OWNER_CHANGED/);assert.deepEqual(f.counts,{wire:0,model:0});
});
for(const mutate of [v=>delete v.receipt.details,v=>v.receipt.details.byteLength='1',v=>v.receipt.details.hash='sha256:'+'a'.repeat(64),v=>delete v.receipt.currentRevision,v=>v.extra=true,v=>v.receipt.extra=true])test('invalid import cancellation receipt remains unconfirmed and releases its model',async()=>{
 const f=fixture(),v=value('id');mutate(v);f.response.resolve(v);await assert.rejects(f.client.cancelRasterImport('id',f.owner),/UNCONFIRMED/);assert.deepEqual(f.counts,{wire:0,model:0});
});
test('unknown transport and original ownership replacement never invent a canceled result',async()=>{
 const f=fixture();f.response.reject(Error('NOT_FOUND'));await assert.rejects(f.client.cancelRasterImport('id',f.owner),/NOT_FOUND/);assert.deepEqual(f.counts,{wire:0,model:0});
 const g=fixture();g.client.importAdmissions.set('id',g.admission.promise);const operation=g.client.cancelRasterImport('id',g.owner);g.change();g.admission.resolve();await assert.rejects(operation,/OWNER_CHANGED/);assert.equal(g.calls.length,0);
});
