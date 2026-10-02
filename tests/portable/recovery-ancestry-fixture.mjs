// Test-only isolated SQL predicate fixture. It never opens a workspace, starts
// a service, or calls a provider. The parent supplies the strict network guard.
import {DatabaseSync} from 'node:sqlite';
import {recoveryAssetAllowed} from '../../dist/local/server/portable/recovery.js';

process.once('message',fixtures=>{
 const results=[];
 try{
  for(const fixture of fixtures){
   const db=new DatabaseSync(':memory:');
   try{
    // Minimal columns intentionally exercise the actual production predicate,
    // independently of unrelated asset format and archive setup logic.
    db.exec('CREATE TABLE assets(id TEXT PRIMARY KEY,json TEXT NOT NULL) STRICT; CREATE TABLE candidates(json TEXT NOT NULL) STRICT; CREATE TABLE portable_rows(kind TEXT NOT NULL,json TEXT NOT NULL) STRICT;');
    for(const asset of fixture.assets)db.prepare('INSERT INTO assets VALUES (?,?)').run(asset.id,JSON.stringify(asset));
    for(const candidate of fixture.candidates??[])db.prepare('INSERT INTO candidates VALUES (?)').run(JSON.stringify(candidate));
    for(const candidate of fixture.importedCandidates??[])db.prepare("INSERT INTO portable_rows VALUES ('candidate-result',?)").run(JSON.stringify(candidate));
    const snapshot=()=>JSON.stringify(['assets','candidates','portable_rows'].map(table=>db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()));
    const before=snapshot(),allowed=recoveryAssetAllowed(db,fixture.assetId);results.push({name:fixture.name,allowed,unchanged:snapshot()===before});
   }finally{db.close();}
  }
  process.send({results,effects:globalThis.__storeNetworkCounters.read()},()=>process.disconnect());
 }catch(error){process.send({error:error.stack??String(error)},()=>process.disconnect());}
});
