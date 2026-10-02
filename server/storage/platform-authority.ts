import {StoreError} from './errors.js';

export type RollbackPinKind='schema16-maintenance-executable-pin-1'|'schema17-executable-pin-1'|'schema18-executable-pin-1';
export type RollbackExecutablePin<K extends RollbackPinKind=RollbackPinKind>=Readonly<{
  kind:K;packetId:string;identityHash:string;
  platform:Readonly<{os:string;arch:string;identity:string}>;
}>;
export type Schema16MaintenanceExecutablePin=RollbackExecutablePin<'schema16-maintenance-executable-pin-1'>&Readonly<{
  storageVersion:16;compatibilityContract:'schema16-linux-raster-maintenance-1';
  historicalBase:'5650326b623d4aa2080772307708aa9f1854aa52';
  maintenancePatchHash:'sha256:77f7fddc26a02bc9c4e613de72f47d213fa58bee9846ff84717cdece58214958';
  sourceIdentity:string;
}>;
export type RollbackAuthority<P extends RollbackExecutablePin=RollbackExecutablePin>=Readonly<{
  os:string;arch:string;pin:P|null;
}>;

const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const keys=(value:Record<string,unknown>,expected:string)=>Object.keys(value).sort().join(',')===expected;
const label=(value:unknown):value is string=>typeof value==='string'&&/^[a-z][a-z0-9_]{0,31}$/.test(value);
const digest=(value:unknown):value is string=>typeof value==='string'&&/^sha256:[a-f0-9]{64}$/.test(value);
function refuse(code:string):never{throw new StoreError('UNSUPPORTED_STORAGE',{kind:'fields',issues:[{path:'storage.schemaVersion',code}]});}
const immutablePin=<P extends RollbackExecutablePin>(pin:P):P=>Object.freeze({...pin,platform:Object.freeze({...pin.platform})});

/** Detach source-owned authority data from callers and freeze every nested row.
 * This creates no authority and does not select a platform or impose an open gate.
 * Selection validates the entire registry only when an old root needs a packet. */
export function freezeRollbackAuthorities<P extends RollbackExecutablePin>(rows:readonly RollbackAuthority<P>[]):readonly RollbackAuthority<P>[] {
  return Object.freeze(rows.map(row=>Object.freeze({...row,pin:row.pin===null?null:immutablePin(row.pin)})));
}

/** Select one independently issued authority. Never fall back across platforms.
 * A packet is still required to pass its existing installed-descriptor verifier;
 * this function does not import a producer or authenticate archive contents. */
export function selectRollbackExecutable(kind:'schema16-maintenance-executable-pin-1',rows:readonly RollbackAuthority[],os:string,arch:string):Schema16MaintenanceExecutablePin;
export function selectRollbackExecutable<K extends RollbackPinKind>(kind:K,rows:readonly RollbackAuthority[],os:string,arch:string):RollbackExecutablePin<K>;
export function selectRollbackExecutable<K extends RollbackPinKind>(kind:K,rows:readonly RollbackAuthority[],os:string,arch:string):RollbackExecutablePin<K> {
  const invalid='ROLLBACK_EXECUTABLE_AUTHORITY_INVALID';
  const authorities:readonly RollbackAuthority[]=rows;
  if((kind!=='schema16-maintenance-executable-pin-1'&&kind!=='schema17-executable-pin-1'&&kind!=='schema18-executable-pin-1')||!label(os)||!label(arch)||!Array.isArray(rows)||rows.length>32)refuse(invalid);
  const seen=new Set<string>();let selected:RollbackAuthority|undefined;
  for(const row of authorities){
    if(!record(row)||!keys(row,'arch,os,pin')||!label(row.os)||!label(row.arch))refuse(invalid);
    if(kind==='schema16-maintenance-executable-pin-1'&&(row.os!=='linux'||(row.arch!=='x64'&&row.arch!=='arm64')))refuse(invalid);
    const key=row.os+'/'+row.arch;if(seen.has(key))refuse(invalid);seen.add(key);
    if(row.pin!==null){
      const pin:unknown=row.pin;
      const expectedKeys=kind==='schema16-maintenance-executable-pin-1'?'compatibilityContract,historicalBase,identityHash,kind,maintenancePatchHash,packetId,platform,sourceIdentity,storageVersion':'identityHash,kind,packetId,platform';
      if(!record(pin)||!keys(pin,expectedKeys)||pin.kind!==kind||
         typeof pin.packetId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(pin.packetId)||!digest(pin.identityHash)||
         !record(pin.platform)||!keys(pin.platform,'arch,identity,os')||!digest(pin.platform.identity)||
         pin.platform.os!==row.os||pin.platform.arch!==row.arch)refuse(invalid);
      if(kind==='schema16-maintenance-executable-pin-1'&&(pin.storageVersion!==16||
         pin.compatibilityContract!=='schema16-linux-raster-maintenance-1'||
         pin.historicalBase!=='5650326b623d4aa2080772307708aa9f1854aa52'||
         pin.maintenancePatchHash!=='sha256:77f7fddc26a02bc9c4e613de72f47d213fa58bee9846ff84717cdece58214958'||
         !digest(pin.sourceIdentity)))refuse(invalid);
    }
    if(row.os===os&&row.arch===arch)selected=row;
  }
  if(selected===undefined)refuse('ROLLBACK_EXECUTABLE_AUTHORITY_MISSING');
  if(selected.pin===null)refuse('ROLLBACK_EXECUTABLE_AUTHORITY_UNISSUED');
  return immutablePin(selected.pin) as RollbackExecutablePin<K>;
}

// No Linux16 maintenance executable has been issued. Each future row requires
// an actual independently built and restored packet, never the Darwin release pin.
export const SCHEMA16_MAINTENANCE_AUTHORITIES=freezeRollbackAuthorities<Schema16MaintenanceExecutablePin>([]);
export function schema16MaintenanceExecutablePin():Schema16MaintenanceExecutablePin{
  return selectRollbackExecutable('schema16-maintenance-executable-pin-1',SCHEMA16_MAINTENANCE_AUTHORITIES,process.platform,process.arch);
}
