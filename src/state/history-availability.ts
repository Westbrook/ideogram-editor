import type {Document,HistoryNode} from '../protocol/store.js';
import type {ImageHistoryNode} from '../protocol/history.js';
import type {RecoveryCache} from './recovery-cache.js';
import {reserveModelBytes,modelPayloadBytes} from '../observability/model-memory.js';

// Recovery admits bounded canonical control records. This conservative logical
// payload allowance precedes the IndexedDB read; it does not estimate native
// structured-clone or IndexedDB implementation memory.
const HEAD_MODEL_BYTES=4*65536+8;
export async function readUndoAvailability(cache:Pick<RecoveryCache,'read'>,document:Pick<Document,'id'|'historyHead'>):Promise<boolean|null>{
  const lease=reserveModelBytes('editor-history-head',HEAD_MODEL_BYTES);let value:unknown;
  try{
    value=await cache.read('history',document.historyHead);
    if(modelPayloadBytes(value)>HEAD_MODEL_BYTES)throw Error('HISTORY_HEAD_MODEL_LIMIT');
    if(!value||typeof value!=='object'||Array.isArray(value))return null;
    const head=value as HistoryNode|ImageHistoryNode;
    if(head.id!==document.historyHead||head.documentId!==document.id)return null;
    if(!('kind' in head))return head.parent===null?false:null;
    return head.kind==='image-edit'&&typeof head.parent==='string'&&head.parent.length>0;
  }finally{value=undefined;lease.release();}
}
