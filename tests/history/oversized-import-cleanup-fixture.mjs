// Internal failure injection at a real writer cleanup boundary. No raster
// result, receipt, source proof, or authority is fabricated by this fixture.
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
export async function setup(store){
 const config=JSON.parse(fs.readFileSync(join(store.root,'import-cleanup-control.json'),'utf8'));
 const cleanup=store.rasters.cleanupImport.bind(store.rasters),fsync=fs.fsyncSync,parent=fs.statSync(join(store.root,'raster-work'));
 let injected=false,armed=false,attempts=0,calls=0,ownedPath;
 const write=(index,error)=>{
  const rows=store.db.prepare('SELECT path FROM deletion_work WHERE document_id=?').all('raster-import:'+config.commandId);
  const value={index,error,attempts,rows,inventory:store.objects.reservationInventory(),retained:store.rasters.retainedImportCleanup.has(config.commandId),auth:store.rasters.approvalAuth.has(config.commandId),paused:store.rasters.paused.has(config.commandId)};
  const path=join(store.root,'import-cleanup-'+index+'.json');fs.writeFileSync(path+'.tmp',JSON.stringify(value),{mode:0o600});fs.renameSync(path+'.tmp',path);
 };
 fs.fsyncSync=function(fd){
  const stat=fs.fstatSync(fd);if(armed&&stat.dev===parent.dev&&stat.ino===parent.ino){attempts++;if(attempts===1)throw Object.assign(Error('Injected parent fsync failure'),{code:'EIO'});}
  return fsync(fd);
 };syncBuiltinESMExports();
 store.rasters.cleanupImport=function(id){
  const terminal=id===config.commandId&&store.db.prepare('SELECT 1 FROM commands WHERE id=?').get(id);
  if(!terminal)return cleanup(id);
  const index=++calls;let error=null;
  try{
   if(!injected){const row=store.db.prepare('SELECT path FROM deletion_work WHERE document_id=?').get('raster-import:'+id);if(!row)throw Error('Missing real import cleanup journal');ownedPath=row.path;injected=true;if(config.phase==='mode')fs.chmodSync(ownedPath,0o500);else armed=true;}
   return cleanup(id);
  }catch(e){error=e.code??e.message;throw e;}
  finally{setImmediate(()=>write(index,error));}
 };
 return async()=>{store.rasters.cleanupImport=cleanup;fs.fsyncSync=fsync;syncBuiltinESMExports();if(ownedPath&&fs.existsSync(ownedPath))fs.chmodSync(ownedPath,0o700);};
}
