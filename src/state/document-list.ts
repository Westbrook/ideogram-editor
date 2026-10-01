import type {Document} from '../protocol/store.js';
import {modelPayloadBytes,reserveModelBytes} from '../observability/model-memory.js';

export const DOCUMENT_LIST_LIMITS=Object.freeze({documents:4096,payloadBytes:32*1024**2,cursorBytes:1024**2});
type Published={generation:string;cursor:string};
type Cache={published():Promise<Published>;rows(generation:string,type:string):AsyncIterable<{value:unknown}>};
export type OwnedDocumentList=Readonly<{documents:Document[];cursor:string;release():void;pin():()=>void}>;
export class DocumentListAdmissionError extends Error {
  constructor(cause?:unknown){super('The complete document list cannot fit its current memory allowance. The previous complete list is retained. Close unused views or reduce the workspace inventory before retrying.',{cause});}
}

/** Admit a complete replacement before publication. A refused or superseded
 * scan never truncates the visible list or retires its existing owner. IDB may
 * clone one row before yielding it; its known bounded cursor payload is booked
 * before the first native read and stays charged through iterator completion. */
export async function collectOwnedDocuments(cache:Cache,owns:()=>boolean=()=>true):Promise<OwnedDocumentList|null>{
  if(!owns())return null;
  const retained=reserveModelBytes('editor-document-list',0);let cursor:ReturnType<typeof reserveModelBytes>|undefined;
  let transferred=false;
  try{
    cursor=reserveModelBytes('editor-document-cursor',DOCUMENT_LIST_LIMITS.cursorBytes);
    const published=await cache.published(),documents:Document[]=[];let bytes=0;
    for await(const row of cache.rows(published.generation,'document')){
      if(!owns())return null;
      if(documents.length>=DOCUMENT_LIST_LIMITS.documents)throw new DocumentListAdmissionError();
      const size=modelPayloadBytes(row.value);if(size>DOCUMENT_LIST_LIMITS.cursorBytes||size>DOCUMENT_LIST_LIMITS.payloadBytes-bytes)throw new DocumentListAdmissionError();
      try{retained.resize(bytes+size,documents.length+2);}catch(error){throw new DocumentListAdmissionError(error);}
      bytes+=size;documents.push(row.value as Document);
    }
    if(!owns()||(await cache.published()).generation!==published.generation||!owns())return null;
    transferred=true;return Object.freeze({documents,cursor:published.cursor,release:()=>retained.release(),pin:()=>retained.pin()});
  }finally{cursor?.release();if(!transferred)retained.release();}
}
