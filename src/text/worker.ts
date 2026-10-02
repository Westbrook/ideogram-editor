import {diagnosticMemory,reserveBorrowedDiagnostics,TEXT_WORKER_DIAGNOSTIC_BYTES} from '../observability/diagnostic-memory.js';
import { createTextEngine, prepareText } from './engine';
import { TextFailure } from './contracts';
import type { TextRequest } from './contracts';
import { PhaseRecorder } from '../observability/phases.js';
const scope = self as unknown as { onmessage: ((event: MessageEvent<TextRequest>) => void) | null;
  postMessage(value: unknown): void; close(): void };
// The owning TextRenderer pre-admits the matching delegation before creating
// this worker, including native queued message overlap until receive/terminate.
// Leave 2 MiB of that delegation outside the worker for native ingress metadata.
diagnosticMemory.adopt(reserveBorrowedDiagnostics(TEXT_WORKER_DIAGNOSTIC_BYTES-2*1024**2));
let started = false;
const engine = createTextEngine();
engine.then(() => scope.postMessage({ ready: true }), error => scope.postMessage({ ok: false, fatal: true,
  code: 'TEXT_ENGINE_LOAD', details: String(error) }));
scope.onmessage = async event => {
  if (started) return; started = true;
  const phases=new PhaseRecorder({lane:'text-worker',capacity:128,openSpans:128});
  const post=(message:Record<string,unknown>)=>{
    let observation:ReturnType<PhaseRecorder['readSnapshot']>|undefined;
    try{observation=phases.readSnapshot();}catch{/* Missing diagnostic evidence is explicit; it cannot fail the text result. */}
    try{scope.postMessage({...message,...(observation?{phases:observation.value}:{phasesUnavailable:true})});}
    finally{observation?.release();}
  };
  try { post({ ok: true, value: await prepareText(event.data, await engine, undefined, phases) }); }
  catch (error) { post({ ok: false, code: error instanceof TextFailure ? error.code :
    error instanceof RangeError && error.message === 'TEXT_NATIVE_ALLOCATION' ? 'TEXT_NATIVE_CAPACITY' : 'TEXT_WORKER_FAILURE',
    fatal: !(error instanceof TextFailure), details: error instanceof TextFailure ? error.details : String(error) }); }
  finally { phases.dispose();started = false; }
};
