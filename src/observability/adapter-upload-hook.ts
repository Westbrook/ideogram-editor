import type {DiagnosticRead} from './diagnostic-memory.js';
import type {OwnedModel} from './model-memory.js';
import type {StagingCreateRequest,StagingRecord} from '../protocol/assets.js';

/** The large producer loads only at explicit import/diagnostic initialization.
 * This registry exposes detached diagnostic reads, never byte-report setters. */
export type AdapterUploadRole='adapter-weights'|'adapter-config'|'adapter-provenance';
export type OpaqueUploadInput={file:Blob;purpose:StagingCreateRequest['purpose'];mediaType:string;existing?:StagingRecord;
 transport:(path:string,init?:RequestInit)=>Promise<Response>;check:()=>void;signal:AbortSignal;tick:()=>Promise<void>;
 owner:{sessionId:string;draftSessionId:string|null;documentId:string|null;documentEpoch:number;editorEpoch:number;clientId:string|null}};
export type AdapterOpaqueUpload=(input:OpaqueUploadInput)=>Promise<OwnedModel<StagingCreateRequest>>;
let reader:(()=>DiagnosticRead<unknown>)|undefined;
export function registerAdapterUploadReader(next:()=>DiagnosticRead<unknown>){if(reader&&reader!==next)throw Error('ADAPTER_UPLOAD_OBSERVER_ALREADY_REGISTERED');reader=next;}
export function readAdapterUploads(){return reader?.()??null;}
