import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openWriter } from '../../dist/local/server/storage/writer.js';
import { canonical, hashBytes } from '../../dist/local/server/storage/canonical.js';
import { command, checkpoint, encode, expectedBytes, refFor } from '../store/helpers.mjs';
// Trusted fixture builder on its own stopped disposable root. No public command
// discriminator or HTTP test route is introduced. Final immutable records pass
// the production startup validator and public complete-transaction consumer.
export async function largeTransaction(root,count=80) {
  const writer=await openWriter({root});const ref=await writer.putObject([expectedBytes],refFor(expectedBytes),writer.epoch);
  await writer.submit(encode(command(ref)),writer.epoch);
  for(let i=1;i<=count;i++)await writer.submit(encode(checkpoint(ref,String(i),'Fixture '+i+' x'.repeat(500))),writer.epoch);
  await writer.close();const db=new DatabaseSync(join(root,'metadata.sqlite'));db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE; DROP TRIGGER events_v2_immutable_update; DROP TRIGGER commands_immutable_update; DROP TRIGGER commands_immutable_delete;');
  try {
    const first=JSON.parse(db.prepare("SELECT json FROM events_v2 WHERE seq='2'").get().json);const cmd=JSON.parse(db.prepare('SELECT canonical FROM commands WHERE id=?').get(first.commandId).canonical);
    const transactionId=first.transactionId;const commandId=first.commandId;
    for(const row of db.prepare("SELECT seq,json FROM events_v2 WHERE seq!='1'").all()){const event=JSON.parse(row.json);event.commandId=commandId;event.transactionId=transactionId;db.prepare('UPDATE events_v2 SET command_id=?,transaction_id=?,json=? WHERE seq=?').run(commandId,transactionId,canonical(event),row.seq);}
    const receipt={status:'accepted',commandId,fromSeq:'2',toSeq:String(count+1),documentRevision:String(count+1),transactionId};
    db.prepare('UPDATE commands SET receipt=? WHERE id=?').run(canonical(receipt),commandId);
    const creation=JSON.parse(db.prepare("SELECT json FROM events_v2 WHERE seq='1'").get().json).commandId;
    db.prepare('DELETE FROM commands WHERE id NOT IN (?,?)').run(creation,commandId);
    db.exec("CREATE TRIGGER events_v2_immutable_update BEFORE UPDATE ON events_v2 BEGIN SELECT RAISE(ABORT,'immutable'); END; CREATE TRIGGER commands_immutable_update BEFORE UPDATE ON commands BEGIN SELECT RAISE(ABORT,'immutable'); END; CREATE TRIGGER commands_immutable_delete BEFORE DELETE ON commands BEGIN SELECT RAISE(ABORT,'immutable'); END; COMMIT;");
    return {ref,count,transactionId,commandId};
  } finally {db.close();}
}
