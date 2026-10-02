import {isMainThread} from 'node:worker_threads';
import {diagnosticMemory} from '../../src/observability/diagnostic-memory.js';
// A main-process store uses the central ledger; dedicated workers instead adopt
// their parent's fixed grant before enabling handlers.
if(isMainThread&&!diagnosticMemory.adopted)await import('../../src/observability/allocations.js');
import {performance} from 'node:perf_hooks';
import {PhaseRecorder} from '../../src/observability/phases.js';
import {CommandAcceptancePhases,LocalQueuePhases,type CommandAcceptance} from './command-phases.js';
export {CommandAcceptancePhases,commandContext} from './command-phases.js';
export type {CommandAcceptance} from './command-phases.js';
import {canonical,hashBytes,parseCommand} from '../storage/canonical.js';

/** A writer owns one bounded, ephemeral trace. It is never journalled or exported. */
export const serverPhases=new PhaseRecorder({lane:'server-writer',capacity:2048});
export const commandAcceptances=new CommandAcceptancePhases(serverPhases);
export const localQueuePhases=new LocalQueuePhases(serverPhases);
const commandMethods=new Set(['submit','assetCommand','adapterCommand','rasterCommand','historyCommand','portableCommand','queueCommand']);
export function beginCommandAcceptance(method:unknown,bytes:unknown):CommandAcceptance|undefined {
  if(typeof method!=='string'||!commandMethods.has(method))return;
  const started=performance.now();
  // Parsing here is observational: malformed commands still follow the original
  // authority path and error. Never retain their body, error message, or bytes.
  try{
    if(!(bytes instanceof Uint8Array)||bytes.byteLength>65536)return commandAcceptances.begin(undefined,undefined,started);
    const workspace=diagnosticMemory.reserve('diagnostic-command-parse',1048576);
    try{const request=parseCommand(bytes);return commandAcceptances.begin(request.command,hashBytes(canonical(request)),started);}finally{workspace.release();}
  }catch{return commandAcceptances.begin(undefined,undefined,started);}
}
