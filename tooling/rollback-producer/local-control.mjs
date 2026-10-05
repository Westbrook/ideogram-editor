// Maintained local ARM64 successor. Original allocations and failed trees remain retained.
import {admitRetainedVolume, validateCreatedAttempt, validateRetainedVolumeMounts} from './local-retained-volume.mjs';
import {createToolchainQuiescence} from './local-toolchain-quiescence.mjs';
import {requestedImageLabels, projectedContainerLabels, containerImageLabelsMatch, imageLabelArgs} from './local-image-labels.mjs';
import {createHash} from 'node:crypto';
import {constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, writeSync} from 'node:fs';
import {mkdir, open, realpath} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';

const require = (condition, message) => { if (!condition) throw Error(message); };
export const PHASES = Object.freeze(['bootstrap', 'observe', 'tests', 'build16', 'build17', 'build18', 'verify16', 'verify17', 'verify18']);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const stamp = s => [s.dev, s.ino, s.mode, s.nlink, s.size, s.mtimeNs, s.ctimeNs];
function held(path, expected = null, capture = true, max = 256 * 1024 ** 2) {
  require(resolve(path) === path, 'Expected absolute normalized file path');
  const before = lstatSync(path, {bigint: true});
  require(before.isFile() && before.nlink === 1n && before.size <= BigInt(max), 'Expected bounded ordinary single-link file: ' + path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK), hash = createHash('sha256'), parts = [];
  try {
    require(isDeepStrictEqual(stamp(before), stamp(fstatSync(fd, {bigint: true}))), 'Input changed before open');
    const buffer = Buffer.alloc(Math.min(Number(before.size) || 1, 1024 ** 2)); let remaining = Number(before.size);
    while (remaining) { const n = readSync(fd, buffer, 0, Math.min(remaining, buffer.length), null); require(n > 0, 'Input shortened'); remaining -= n; hash.update(buffer.subarray(0, n)); if (capture) parts.push(Buffer.from(buffer.subarray(0, n))); }
    require(readSync(fd, buffer, 0, 1, null) === 0 && isDeepStrictEqual(stamp(before), stamp(fstatSync(fd, {bigint: true}))) && isDeepStrictEqual(stamp(before), stamp(lstatSync(path, {bigint: true}))), 'Input changed while read');
  } finally { closeSync(fd); }
  const ref = {path, bytes: Number(before.size), sha256: hash.digest('hex')};
  require(expected === null || isDeepStrictEqual(ref, expected), 'Bound input differs: ' + path);
  return {ref, bytes: capture ? Buffer.concat(parts) : null};
}
const data = ref => JSON.parse(held(ref.path, ref).bytes);
const exists = path => { try { lstatSync(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
async function save(path, value) { const fd = await open(path, 'wx', 0o600); try { await fd.writeFile(JSON.stringify(value, null, 2) + '\n'); await fd.sync(); } finally { await fd.close(); } return held(path).ref; }
function terminalSave(path, value) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n'), fd = openSync(path, 'wx', 0o600);
  try { let offset = 0; while (offset < bytes.length) { const count = writeSync(fd, bytes, offset, bytes.length - offset); require(count > 0, 'Terminal receipt short write'); offset += count; } fsyncSync(fd); }
  finally { closeSync(fd); }
  return held(path).ref;
}
const errorRecord = e => ({name: String(e?.name ?? 'Error'), message: String(e?.message ?? e).slice(0, 2048)});
const asRef = x => ({path: x.path, bytes: Number(x.byteLength), sha256: x.hash.replace(/^sha256:/, '')});
export function successfulChild(value) { return value?.code === 0 && value.signal === null && !value.timedOut && !value.interrupted && !value.error; }
export function childClosureUncertain(value) { return Boolean(value?.error || ((value?.timedOut || value?.interrupted) && value.exitObserved !== true)); }
export function observationTimeoutMs(deadlineMs, nowMs) {
  require(Number.isFinite(nowMs) && nowMs >= 0 && Number.isFinite(deadlineMs) && deadlineMs >= 0, 'Observation deadline must be finite');
  // boundedChild accepts whole milliseconds only. Round down so no command
  // receives time beyond its enclosing deadline, including a sub-ms remainder.
  const timeoutMs = Math.min(2000, Math.floor(deadlineMs - nowMs));
  require(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, 'Observation command deadline expired');
  return timeoutMs;
}
export async function settleChild(invoke, onUncertain, finalize) {
  let result=null,primary=null;
  try { result=await invoke(); if(childClosureUncertain(result))onUncertain(); }
  catch(error) { primary=error;onUncertain(); }
  try { await finalize(result); } catch(error) { primary??=error; }
  if(primary)throw primary;
  return result;
}
export async function closeLogHandles(handles) {
  let primary=null;
  for(const handle of handles) {
    try { await handle.sync(); } catch(error) { primary??=error; }
    try { await handle.close(); } catch(error) { primary??=error; }
  }
  if(primary)throw primary;
}
export function createdIdentity(role, names, cid, previous = null) {
  require(/^[a-f0-9]{64}$/.test(cid) && (!previous || previous.id === cid), 'Created CID conflicts with recorded authority');
  return {id: cid, name: names[role], role};
}
export function linkCancellation(parent, local, cleanup = false) {
  const cancel = () => local.abort(parent.reason);
  if (!cleanup) { parent.addEventListener('abort', cancel, {once: true}); if (parent.aborted) cancel(); }
  return () => parent.removeEventListener('abort', cancel);
}
export function roleNames(runId, attemptId) {
  require(/^ie-linux-[a-f0-9]{32}$/.test(runId), 'Use a fresh explicitly sealed 128-bit run identifier');
  require(/^attempt-[a-f0-9]{32}$/.test(attemptId), 'Fresh attempt identity required');
  const stem = runId + '-' + attemptId;
  return {observer: stem + '-observer', kernel: stem + '-kernel', init: stem + '-init', build: stem + '-build', verify: stem + '-verify', volume: runId + '-capsule'};
}
export function containerLabels(imageLabels, runId, attemptId) {
  roleNames(runId,attemptId);
  return requestedImageLabels(imageLabels,{'org.ideogram.rollback-run':runId,'org.ideogram.rollback-attempt':attemptId});
}
export function containerLabelArgs(imageLabels, runId, attemptId) {
  // Preserve the complete explicit request, including Desktop metadata. Only
  // inspect's independently reviewed representation uses the projection below.
  return imageLabelArgs(containerLabels(imageLabels,runId,attemptId));
}
export function expectedContainerLabels(imageLabels, runId, attemptId) {
  roleNames(runId,attemptId);
  return projectedContainerLabels(imageLabels,{'org.ideogram.rollback-run':runId,'org.ideogram.rollback-attempt':attemptId});
}
export const INITIALIZER_SCRIPT = 'umask 077; mkdir -- "/capsule/$1"; chown "$2:$3" "/capsule/$1"';
export function initializerCommand(attemptId, uid, gid) {
  require(/^attempt-[a-f0-9]{32}$/.test(attemptId) && Number.isSafeInteger(uid) && uid > 0 && Number.isSafeInteger(gid) && gid > 0, 'Exact fresh attempt and nonroot owner required');
  const args = ['-eu', '-c', INITIALIZER_SCRIPT, 'sh', attemptId, String(uid), String(gid)];
  return {entrypoint:['/bin/sh'],cmd:args,path:'/bin/sh',args};
}
export function projectedMounts(mounts) {
  return mounts.map(row => ({type:row.Type,source:row.Source,destination:row.Destination,rw:row.RW,subpath:row.Subpath ?? ''}));
}
export function validateLocalConfig(config) {
  require(config?.kind === 'local-linux-controller-config-1', 'Local configuration kind required');
  roleNames(config.runId, config.attemptId);
  require(Number.isSafeInteger(config.ownerUid) && config.ownerUid > 0 && Number.isSafeInteger(config.ownerGid) && config.ownerGid > 0 && Number.isSafeInteger(config.kernelObserverUid) && config.kernelObserverUid > 0 && config.kernelObserverUid !== config.ownerUid && Number.isSafeInteger(config.kernelObserverGid) && config.kernelObserverGid > 0, 'Distinct nonroot observer identity required');
  require(config.runRoot === join(config.allocation.root, config.attemptId), 'Fresh host attempt leaf must use original allocation');
  checkDesktopMountMapping(config.dockerDesktopMountMapping);
  return config;
}
export const BOOTSTRAP_MARKER = 'IDEOGRAM_LOCAL_BOOTSTRAP_READY_1';
export const BOOTSTRAP_READY_MS = 2000;
export function bootstrapPayloadArgs(id, uid, gid) {
  require(/^[a-f0-9]{64}$/.test(id) && Number.isSafeInteger(uid) && uid > 0 && Number.isSafeInteger(gid) && gid > 0, 'Bootstrap command requires exact CID/nonroot owner');
  return ['exec','--user',uid+':'+gid,'--env','PYTHONDONTWRITEBYTECODE=1',id,'/bin/sh','-eu','-c',"printf '%s\\n' IDEOGRAM_LOCAL_BOOTSTRAP_READY_1; exec /usr/bin/python3 -I -S -B /capsule/toolchain/tooling/bootstrap-toolchain.py"];
}
// The callback belongs only to the newly started bounded command. The deadline
// is a stricter readiness check; it never restarts the original child clock.
export function bootstrapLaunch({start,abort,schedule=setTimeout,cancel=clearTimeout}) {
  let accept,reject,seen=false;
  const ready=new Promise((ok,bad)=>{accept=ok;reject=bad;});
  const timer=schedule(()=>{reject(Error('Bootstrap launch handshake exceeded two seconds'));abort('Bootstrap launch handshake deadline');},BOOTSTRAP_READY_MS);
  const completion=Promise.resolve().then(()=>start(line=>{require(!seen&&line===BOOTSTRAP_MARKER,'Bootstrap launch handshake differs');seen=true;accept();}));
  completion.then(()=>{if(!seen)reject(Error('Bootstrap exited before launch handshake'));},reject);
  ready.then(()=>cancel(timer),()=>cancel(timer));
  return {ready,completion};
}
export function validateCapabilityEvidence(final, receipt, probeConfig, expected) {
  require(final?.kind==='local-capability-probe-finalization-1' && final.status==='CAPABILITY_AVAILABLE' && final.hostAudit?.status==='PASS' && final.hostVerification?.status==='PASS' && final.timingLockReleased===true, 'Successful audited local capability required');
  require(receipt?.kind==='local-capability-probe-receipt-1' && receipt.status==='CAPABILITY_OBSERVED' && receipt.cleanupComplete===true && receipt.engineAccounting?.status==='PASS', 'Actual completed local capability required');
  for (const value of [final,receipt]) require(value.qualification===false && value.producerExecuted===false && value.nativeAllocationsTouched===false, 'Capability evidence scope differs');
  require(probeConfig?.kind==='local-capability-probe-config-1' && /^ie-linux-[a-f0-9]{32}$/.test(probeConfig.runId) && receipt.runId===probeConfig.runId && probeConfig.image===expected.image && probeConfig.writerUser===expected.writerUser && probeConfig.observerUser===expected.observerUser, 'Capability candidate identity differs');
  require(Array.isArray(receipt.cleanup) && receipt.cleanup.length===2 && ['writer','observer'].every(role=>receipt.cleanup.some(row=>row.role===role && row.id===receipt.containers?.[role]?.id && row.complete===true && Number.isSafeInteger(row.exitCode))), 'Capability owned-container drainage required');
  require(Array.isArray(receipt.sources) && expected.sources.every(ref=>receipt.sources.some(row=>isDeepStrictEqual(row,ref))), 'Capability source/tool identity differs');
  return receipt;
}
export function activeCommand(role, uid, gid) {
  if (['observer', 'kernel', 'build', 'verify'].includes(role)) return {entrypoint: ['/bin/sleep'], cmd: ['infinity'], path: '/bin/sleep', args: ['infinity']};
  throw Error('Unknown idle container role');
}
export function checkContainerCommand(value, command) {
  require(command && isDeepStrictEqual(value.ConfigEntrypoint, command.entrypoint) && isDeepStrictEqual(value.ConfigCmd, command.cmd) && value.Path === command.path && isDeepStrictEqual(value.Args, command.args), 'Container command contract differs');
  return value;
}
export const DESKTOP_BIND_SOURCE_PREFIX = '/host_mnt';
export function checkDesktopMountMapping(mapping) {
  require(isDeepStrictEqual(mapping, {context: 'desktop-linux', bindSourcePrefix: DESKTOP_BIND_SOURCE_PREFIX}), 'Explicit pinned Docker Desktop mount mapping required');
  return mapping;
}
export function checkMounts(actual, hostConfig, expected) {
  require(Array.isArray(actual) && Array.isArray(hostConfig) && Array.isArray(expected), 'Mount inventories required');
  const sort = rows => rows.slice().sort((a, b) => a.Destination < b.Destination ? -1 : a.Destination > b.Destination ? 1 : 0);
  const wanted = sort(expected);
  require(new Set(wanted.map(x => x.Destination)).size === wanted.length, 'Duplicate declared mount destination');
  const configured = sort(hostConfig.map(x => {
    require(x && ['bind', 'volume'].includes(x.Type) && (x.ReadOnly === undefined || typeof x.ReadOnly === 'boolean'), 'Configured mount type or access differs');
    if (x.Type === 'volume') require(x.VolumeOptions?.NoCopy === true, 'Configured volume must preserve nocopy');
    return {Type: x.Type, Source: x.Source, Destination: x.Target, RW: x.ReadOnly !== true, Subpath: x.VolumeOptions?.Subpath ?? ''};
  }));
  require(actual.length === wanted.length && configured.length === wanted.length, 'Mount count differs');
  const effective = sort(actual);
  for (let i = 0; i < wanted.length; i++) {
    const have = effective[i], request = configured[i], want = wanted[i];
    require(have.Type === want.Type && have.Destination === want.Destination && have.RW === want.RW && request.Type === want.Type && request.Destination === want.Destination && request.RW === want.RW, 'Mount boundary differs');
    if (want.Type === 'volume') require(have.Name === want.Source && request.Source === want.Source && request.Subpath === (want.Subpath ?? ''), 'Volume identity/subpath differs');
    else {
      require(typeof want.Source === 'string' && resolve(want.Source) === want.Source && want.Source.startsWith('/'), 'Declared bind source must be absolute and normalized');
      require(request.Source === want.Source || request.Source === DESKTOP_BIND_SOURCE_PREFIX + want.Source, 'Configured bind source differs');
      require(have.Source === request.Source, 'Effective and configured bind sources differ');
    }
  }
  return actual;
}
export function checkContainerBoundary(value, role, expected) {
  require(value && /^[a-f0-9]{64}$/.test(value.Id) && value.Name === '/' + expected.name && value.Labels?.['org.ideogram.rollback-run'] === expected.runId && value.Privileged === false, 'Container ownership identity differs');
  require(!expected.id || value.Id === expected.id, 'Container ID changed');
  require(containerImageLabelsMatch(value.Labels,expected.imageLabels,{'org.ideogram.rollback-run':expected.runId,'org.ideogram.rollback-attempt':expected.attemptId}), 'Exact selected image/run/attempt labels differ');
  require(value.ConfigImage === expected.image && (!expected.imageId || value.Image === expected.imageId), 'Container image differs');
  if (role === 'image') require(value.User === '0:0' && value.Network === 'bridge' && value.Readonly === false && value.Mounts.length === 0, 'Prerequisite container boundary differs');
  else if (role === 'init') require(value.User === '0:0' && value.Network === 'none' && value.Readonly === true && value.Mounts.length === 1, 'Initializer boundary differs');
  else require(value.User === expected.user && value.Network === (role === 'build' ? 'bridge' : 'none') && value.Readonly === true && isDeepStrictEqual(value.CapDrop, ['ALL']) && isDeepStrictEqual(value.SecurityOpt, ['no-new-privileges']), 'Producer boundary differs');
  if (role === 'kernel') require(value.PidMode === 'container:' + expected.writerId && value.CgroupnsMode === 'host', 'Kernel observer namespace differs');
  else require(value.PidMode === '' && ['private', ''].includes(value.CgroupnsMode), 'Private process namespace required');
  if (role !== 'image') checkMounts(value.Mounts, value.HostConfigMounts, expected.mounts);
  else require(value.HostConfigMounts === null || (Array.isArray(value.HostConfigMounts) && value.HostConfigMounts.length === 0), 'Prerequisite requested mounts differ');
  return value;
}
export function checkContainer(value, role, expected) {
  checkContainerBoundary(value, role, expected);
  checkContainerCommand(value, role === 'init' ? expected.command : activeCommand(role, expected.ownerUid, expected.ownerGid));
  return value;
}
export async function drainOwnedContainer(role, {inspect, docker}) {
  // inspect authenticates and durably records any narrowly recovered create ID.
  const before = await inspect(role, true), cid = before.Id;
  if (before.State.Status === 'created' && !before.State.Running && !before.State.Restarting) return {neverStarted: true, observed: before.State, stopFailure: null};
  let stopFailure = null;
  if (before.State.Running) {
    try { await docker('stop-' + role, ['stop', '--time', '10', cid], 30000, true); }
    catch (e) { stopFailure = errorRecord(e); await docker('kill-' + role, ['kill', '--signal', 'KILL', cid], 30000, true); }
  }
  const status = await docker('wait-' + role, ['wait', cid], 30000, true), after = await inspect(role, true);
  require(/^\d+$/.test(status) && !after.State.Running && !after.State.Restarting && Number(status) === after.State.ExitCode && !after.State.Error, 'Owned container drainage is unproven');
  return {exitCode: after.State.ExitCode, observed: after.State, stopFailure};
}
export async function startOwnedContainer(role, {track, inspect, docker}) {
  track(role); // Even an unobservable previously recorded CID blocks lock release.
  const before = await inspect(role);
  require(!before.State.Running && !before.State.Restarting, 'Owned container must be stopped before phase');
  await docker('start-' + role, ['start', before.Id]);
  require((await inspect(role)).State.Running, 'Container did not start');
}
const INSPECT = '{"Id":{{json .Id}},"Name":{{json .Name}},"Image":{{json .Image}},"ConfigImage":{{json .Config.Image}},"User":{{json .Config.User}},"Labels":{{json .Config.Labels}},"Network":{{json .HostConfig.NetworkMode}},"Readonly":{{json .HostConfig.ReadonlyRootfs}},"Privileged":{{json .HostConfig.Privileged}},"CapDrop":{{json .HostConfig.CapDrop}},"SecurityOpt":{{json .HostConfig.SecurityOpt}},"Mounts":{{json .Mounts}},"State":{{json .State}},"ConfigEntrypoint":{{json .Config.Entrypoint}},"ConfigCmd":{{json .Config.Cmd}},"Path":{{json .Path}},"Args":{{json .Args}},"HostConfigMounts":{{json .HostConfig.Mounts}},"PidMode":{{json .HostConfig.PidMode}},"CgroupnsMode":{{json .HostConfig.CgroupnsMode}}}';
// Read-only, fixed-path admission observation. The whole-volume scanner remains
// byte-identical; this helper supplies only directory identity and fresh absence.
export const ATTEMPT_OBSERVER = `import json,os,re,stat,sys
leaf=sys.argv[1]; stage=sys.argv[2]
assert re.fullmatch('attempt-[a-f0-9]{32}',leaf) and stage in ('absent','created')
root=os.lstat('/capsule'); assert stat.S_ISDIR(root.st_mode)
value={'root':{'dev':root.st_dev,'ino':root.st_ino,'uid':root.st_uid,'gid':root.st_gid,'mode':stat.S_IMODE(root.st_mode)}}
path='/capsule/'+leaf
if stage=='absent':
 try: os.lstat(path)
 except FileNotFoundError: value['attempt']={'path':path,'absence':'ENOENT','parentIdentity':{'dev':root.st_dev,'ino':root.st_ino}}
 else: raise ValueError('ATTEMPT_ALREADY_EXISTS')
else:
 current=os.lstat(path); assert stat.S_ISDIR(current.st_mode)
 with os.scandir(path) as entries: empty=next(entries,None) is None
 value['attempt']={'path':path,'dev':current.st_dev,'ino':current.st_ino,'uid':current.st_uid,'gid':current.st_gid,'mode':stat.S_IMODE(current.st_mode),'empty':empty}
after=os.lstat('/capsule'); assert (root.st_dev,root.st_ino,root.st_uid,root.st_gid,root.st_mode)==(after.st_dev,after.st_ino,after.st_uid,after.st_gid,after.st_mode)
print(json.dumps(value,separators=(',',':')))
`;

async function main() {
  const args = process.argv.slice(2);
  require(args.length === 6 && args[0] === '--config' && args[2] === '--grant' && args[4] === '--phase', 'Use --config ABS --grant SHA256 --phase ' + PHASES.join('|'));
  const configInput = held(args[1]), config = JSON.parse(configInput.bytes), phase = args[5], index = PHASES.indexOf(phase);
  require(configInput.ref.sha256 === args[3] && index >= 0 && config.kind === 'local-linux-controller-config-1', 'Configuration grant or phase differs');
  validateLocalConfig(config);
  require(process.versions.node === '26.10.0' && globalThis.__storeNetworkCounters, 'Node26.10.0 and the existing no-network preload required');
  const known = data(config.knownInputs), grant = data(config.retainedVolumeGrant), priorFailed = data(grant.prior.receipt);
  const grantRefs = [grant.evidenceAllocation,grant.dockerAllocation,grant.prior.receipt,grant.prior.finalization,...grant.sources];
  const capabilityFinal=data(config.capabilityFinalization), capabilityReceipt=data(capabilityFinal.receipt), capabilityConfig=data(capabilityReceipt.config);
  const references = [configInput.ref, config.knownInputs, config.launcher, config.allocation.receipt, config.dockerAllocation, config.retainedVolumeGrant, config.capabilityFinalization, capabilityFinal.receipt, capabilityReceipt.config, ...capabilityReceipt.sources, ...known.files, ...grantRefs];
  const guard = () => { for (const ref of references) held(ref.path, ref, false); };
  guard(); held(await realpath(process.execPath), known.node, false); held(fileURLToPath(import.meta.url), config.launcher, false);
  require(known.accountingModule === fileURLToPath(new URL('./local-accounting.mjs',import.meta.url)) && known.volumeWorker.path === fileURLToPath(new URL('./local-volume-observer.py',import.meta.url)) && known.volumeWorker.sha256 === '11fc540c7e0151c534d23d94962677c5bf63a0ebc79260aad57b9c865e55d5bc' && known.kernelWorker.path === fileURLToPath(new URL('./local-cgroup-observer.py',import.meta.url)), 'Maintained local helper identities required');
  require(grant.output === config.runRoot && grant.attemptId === config.attemptId && grant.owner.uid === config.ownerUid && grant.owner.gid === config.ownerGid, 'Retained grant and current attempt differ');
  const capabilityPaths=['local-toolchain-quiescence.mjs','local-cgroup-observer.py','local-image-labels.mjs'].map(name=>fileURLToPath(new URL('./'+name,import.meta.url)));
  const capabilitySources=capabilityPaths.map(path=>{const ref=known.files.find(row=>row.path===path);require(ref,'Capability source absent from bound closure');return ref;});
  validateCapabilityEvidence(capabilityFinal,capabilityReceipt,capabilityConfig,{runId:config.runId,image:priorFailed.imageId,writerUser:config.ownerUid+':'+config.ownerGid,observerUser:config.kernelObserverUid+':'+config.kernelObserverGid,sources:[known.node,known.docker,config.allocation.receipt,config.dockerAllocation,...capabilitySources]});
  require(config.allocation?.root && config.allocation?.receipt && config.runRoot && config.ownerUid === process.getuid() && config.ownerGid === process.getgid() && config.ownerUid > 0 && config.ownerGid > 0, 'Actual allocation and source-readable nonroot owner must be selected');
  held(config.allocation.receipt.path, config.allocation.receipt, false);
  require(await realpath(config.allocation.root) === config.allocation.root && dirname(config.runRoot) === config.allocation.root, 'Run root must be a fresh child of the actual allocated root');
  const privateParent = lstatSync(config.allocation.root); require(privateParent.isDirectory() && privateParent.uid === process.getuid() && !(privateParent.mode & 0o077), 'Private owned allocation root required');
  const names = roleNames(config.runId, config.attemptId), out = join(config.runRoot, phase), state = {kind: 'local-linux-controller-phase-1', phase, config: configInput.ref, result: 'running', commands: [], containers: {}, imageId: null, sourceInputs: null, hostSelection: null, drafts: {}, packets: {}, failure: null, timingLockReleased: false, qualification:false};
  if (index === 0) {
    require(!exists(config.runRoot), 'Fresh host attempt cannot reuse an existing leaf');
    await mkdir(config.runRoot, {mode:0o700});
    const retained = data(config.retainedVolumeGrant), failed = data(retained.prior.receipt);
    Object.assign(state, {imageId: failed.imageId, sourceInputs: failed.sourceInputs, baseImageId: failed.baseImageId});
  }
  else {
    const prior = data(config.previous[phase]);
    require(prior.kind === 'local-linux-controller-finalization-1' && prior.result === 'passed' && prior.hostAudit.status === 'PASS' && prior.hostVerification.status === 'PASS' && prior.dockerObservationStatus === 'PASS', 'Successful audited predecessor required');
    const previous = data(prior.receipt);
    require(previous.kind === state.kind && previous.phase === PHASES[index - 1] && previous.result === 'passed' && prior.timingLockReleased === true && previous.runId === config.runId && previous.runRoot === config.runRoot && previous.knownInputs.sha256 === config.knownInputs.sha256 && previous.attemptId === config.attemptId, 'Successful exact predecessor required');
    require(isDeepStrictEqual(previous.allocation, config.allocation) && isDeepStrictEqual(previous.dockerAllocation, config.dockerAllocation) && isDeepStrictEqual(previous.retainedVolumeGrant,config.retainedVolumeGrant) && isDeepStrictEqual(previous.capabilityFinalization,config.capabilityFinalization), 'Previously selected allocation/grant/capability changed');
    Object.assign(state, {containers: previous.containers, imageId: previous.imageId, sourceInputs: previous.sourceInputs, hostSelection: previous.hostSelection, drafts: previous.drafts, packets: previous.packets, mounts: previous.mounts, volumeIdentity: previous.volumeIdentity, baseImageId: previous.baseImageId});
  }
  require(!exists(out), 'Phase cannot overwrite/retry an existing output'); await mkdir(out, {mode: 0o700}); await mkdir(join(out, 'tmp'), {mode: 0o700});
  Object.assign(state, {runId: config.runId, attemptId: config.attemptId, runRoot: config.runRoot, knownInputs: config.knownInputs, allocation: config.allocation, dockerAllocation: config.dockerAllocation, retainedVolumeGrant:config.retainedVolumeGrant, capabilityFinalization:config.capabilityFinalization, startedAt: new Date().toISOString()});
  const aborter = new AbortController(), onInt = () => aborter.abort('SIGINT'), onTerm = () => aborter.abort('SIGTERM');
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
  const {acquireTimingLock, timingLockDirectory} = await import(pathToFileURL(known.hostModule));
  const {boundedChild} = await import(pathToFileURL(known.childModule));
  const {loadAllocation, startEvidenceMonitor, retainEvidenceAudit, verifyEvidenceAudit} = await import(pathToFileURL(known.allocationModule));
  const {validateDockerAllocation, createAccounting, containerSize, imageSize, volumeSize, ENGINE_CONTAINER_FIELDS, ENGINE_IMAGE_FIELDS} = await import(pathToFileURL(known.accountingModule));
  const allocation = await loadAllocation(config.allocation.receipt.path);
  require(allocation.root === config.allocation.root, 'Actual allocation root differs');
  const dockerAllocation = validateDockerAllocation(data(config.dockerAllocation), {runId: config.runId, volume: names.volume});
  guard();
  let owner = null, uncertain = false, commandOrdinal = 0, hostMonitor = null, accounting = null, observerLog = null, observerBytes = 0, observationOrdinal = 0, volumeMode = 'sample', observerActive = false, quiescence = null, quiescenceActive = false, retainedAdmission = null;
  const engineTargets = new Set();
  const accountingFailure = error => { state.accountingFailure ??= errorRecord(error); aborter.abort('Accounting observation unavailable or ceiling reached'); };
  const pendingCreate = new Set(), touched = new Set();
  const env = {PATH: dirname(known.docker.path) + ':/usr/bin:/bin:/usr/sbin:/sbin', HOME: config.dockerHome, LANG: 'en_US.UTF-8', TZ: 'UTC', TMPDIR: join(out, 'tmp'), PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', PYTHONSAFEPATH: '1'};
  const run = async (label, binary, argv, timeoutMs = 30000, extra = {}, cleanup = false, firstLine = null) => {
    guard(); require(cleanup || !aborter.signal.aborted, 'Run interrupted');
    const prefix = join(out, String(++commandOrdinal).padStart(3, '0') + '-' + label), handles = [], chunks = [[], []], counts = [0, 0];
    const local = new AbortController(), unlinkCancellation = linkCancellation(aborter.signal, local, cleanup);
    let logFailure = null, result = null, line = Buffer.alloc(0), lineDelivered = false, primary = null;
    const append = i => bytes => {
      try {
        const keep = Math.min(bytes.length, 16 * 1024 ** 2 - counts[i]);
        if (keep > 0) { let offset = 0; while (offset < keep) { const n = writeSync(handles[i].fd, bytes, offset, keep - offset); require(n > 0, 'Log short write'); offset += n; } chunks[i].push(Buffer.from(bytes.subarray(0, keep))); counts[i] += keep; }
        require(keep === bytes.length, 'Log cap exceeded');
        if (i === 0 && firstLine && !lineDelivered) { line=Buffer.concat([line,bytes]);const end=line.indexOf(10);require(end>=0||line.length<=1024,'Bootstrap handshake bound exceeded');if(end>=0){require(end<=1024,'Bootstrap handshake bound exceeded');lineDelivered=true;firstLine(line.subarray(0,end).toString('ascii'));} }
      } catch(error) { logFailure ??= errorRecord(error); local.abort('Log failure'); }
    };
    const entry = {label, binary, argv, timeoutMs, startedAt: new Date().toISOString()};
    try {
      handles.push(await open(prefix + '.out', 'wx', 0o600)); handles.push(await open(prefix + '.err', 'wx', 0o600));
      state.commands.push(entry); await save(prefix + '.started.json', entry);
      result = await settleChild(async()=>{
        result = await boundedChild(binary,argv,{cwd:known.repo,env:{...env,...extra},timeoutMs,graceMs:10000,abortSignal:local.signal,onStdout:append(0),onStderr:append(1)});
        return result;
      },()=>{uncertain=true;},async()=>{await closeLogHandles(handles.splice(0));});
    } catch(error) { primary=error; result??={code:null,signal:null,error:errorRecord(error)}; }
    finally {
      unlinkCancellation();
      try { await closeLogHandles(handles.splice(0)); } catch(error) { primary??=error;logFailure??=errorRecord(error); }
    }
    Object.assign(entry,{result,logFailure});
    try {
      entry.stdout=held(prefix+'.out',null,false).ref;entry.stderr=held(prefix+'.err',null,false).ref;
      await save(prefix+'.finished.json',entry);
    } catch(error) { primary??=error;entry.logFailure??=errorRecord(error); }
    if(primary)throw primary;
    require(successfulChild(result)&&!logFailure,'Command unsuccessful: '+label);
    guard();return Buffer.concat(chunks[0]).toString('utf8').trim();
  };
  const docker = (label, argv, timeout = 30000, cleanup = false) => run(label, known.docker.path, ['--context', 'desktop-linux', ...argv], timeout, {}, cleanup);
  const bind = (Source, Destination = Source) => ({Type: 'bind', Source, Destination, RW: false});
  const wholeVolume = {Type: 'volume', Source: names.volume, Destination: '/capsule', RW: false};
  const volume = {...wholeVolume, RW: true, Subpath: config.attemptId};
  const observerMounts = () => [wholeVolume, bind(known.volumeWorker.path, '/inputs/volume-observer.py')];
  const kernelMounts = () => [bind(known.kernelWorker.path, '/inputs/local-cgroup-observer.py')];
  const expected = role => ({runId: config.runId, attemptId:config.attemptId, name: names[role], imageLabels:state.imageLabels, image: state.imageId, imageId: state.imageId, user: role === 'kernel' ? config.kernelObserverUid + ':' + config.kernelObserverGid : config.ownerUid + ':' + config.ownerGid, ownerUid: config.ownerUid, ownerGid: config.ownerGid, writerId: state.containers.build?.id, id: state.containers[role]?.id, command: role === 'init' ? initializerCommand(config.attemptId, config.ownerUid, config.ownerGid) : null, mounts: role === 'init' ? [{...wholeVolume,RW:true}] : role === 'observer' ? observerMounts() : role === 'kernel' ? kernelMounts() : state.mounts});
  const recordCID = async (role, cid, authority) => {
    if (state.containers[role]) { createdIdentity(role, names, cid, state.containers[role]); return; }
    state.containers[role] = createdIdentity(role, names, cid);
    await save(join(out, 'owned-' + role + '.json'), {runId: config.runId, ...state.containers[role], authority});
  };
  const inspect = async (role, cleanup = false) => {
    // Recovery by name is limited to this controller's previously sealed intent.
    const value = JSON.parse(await docker('inspect-' + role, ['inspect', '--type', 'container', '--format', INSPECT, state.containers[role]?.id ?? names[role]], 30000, cleanup));
    checkContainer(value, role, expected(role));
    if (!state.containers[role]) await recordCID(role, value.Id, 'authenticated-exact-name-lost-create-recovery');
    return value;
  };
  const stop = async role => {
    // Name lookup is allowed only to recover this phase's preflighted creation.
    // The identity is persisted before any stop/kill/wait is sent, by full CID.
    const stopped = await drainOwnedContainer(role, {inspect, docker}); state.containers[role].stopped = stopped;
    if (stopped.stopFailure) { state.result = 'failed'; state.failure ??= stopped.stopFailure; }
  };
  const start = async role => { if (['build','verify','init'].includes(role)) await assertRetainedClosure(); return startOwnedContainer(role, {track: value => touched.add(value), inspect, docker}); };
  const create = async (role, argv) => {
    require(!state.containers[role], 'Container already selected');
    const found = await docker('absent-' + role, ['container', 'ls', '--all', '--filter', 'name=^/' + names[role] + '$', '--format', '{{.ID}}']); require(found === '', 'Fresh owned container name required');
    await save(join(out, 'create-intent-' + role + '.json'), {runId: config.runId, name: names[role], role, argv}); pendingCreate.add(role); touched.add(role);
    let cid;
    try { cid = await docker('create-' + role, ['create', '--pull', 'never', '--name', names[role], ...containerLabelArgs(state.imageLabels,config.runId,config.attemptId), ...argv]); }
    finally { const command = state.commands.at(-1); if (command?.label === 'create-' + role && command.stdout) { const observed = held(command.stdout.path).bytes.toString().trim(); if (/^[a-f0-9]{64}$/.test(observed)) await recordCID(role, observed, 'docker-create-stdout'); } }
    require(/^[a-f0-9]{64}$/.test(cid), 'Create did not return exact CID');
    await inspect(role); require(state.containers[role].id === cid, 'Created CID differs'); pendingCreate.delete(role);
    await accountContainer(role);
  };
  const sourceRefs = () => { const result = []; for (const version of [16, 17, 18]) { const ref = state.sourceInputs[version], value = data(ref); result.push(ref, ...['originArchive', 'originManifest', 'lineage'].map(key => asRef(value[key]))); } return result; };
  const checkSourceInputs = () => { for (const ref of sourceRefs()) held(ref.path, ref, false, 256 * 1024 ** 3); };
  const planEnv = () => ({RUN_ID: config.runId, EVIDENCE: out, IMAGE_BUILD_CONTAINER: names.image, IMAGE_ID: state.imageId ?? '', PRODUCER_UID: String(config.ownerUid), PRODUCER_GID: String(config.ownerGid), BUILD_CONTAINER: state.containers.build?.id ?? names.build, VERIFY_CONTAINER: state.containers.verify?.id ?? names.verify,
    HOST_SELECTION: state.hostSelection?.path ?? '', HOST_SELECTION_HASH: state.hostSelection ? 'sha256:' + state.hostSelection.sha256 : '',
    ...Object.fromEntries([16, 17, 18].flatMap(v => [['SOURCE' + v + '_INPUT', state.sourceInputs?.[v]?.path ?? ''], ['SOURCE' + v + '_HASH', state.sourceInputs?.[v] ? 'sha256:' + state.sourceInputs[v].sha256 : ''], ['DRAFT' + v + '_HASH', state.drafts[v]?.hash ?? '']]))});
  const plan = (name, timeout) => run('recipe-' + name, '/bin/bash', [join(known.plan, 'docker-commands.sh'), name], timeout, planEnv());
  const mountArgs = mounts => mounts.flatMap(x => ['--mount', 'type=' + x.Type + ',src=' + x.Source + ',dst=' + x.Destination + (x.Type === 'volume' ? ',volume-nocopy' + (x.Subpath ? ',volume-subpath=' + x.Subpath : '') : '') + (x.RW ? '' : ',readonly')]);
  const exec = (label, argv, timeout = 30000, additions = {}) => docker(label, ['exec', '--user', config.ownerUid + ':' + config.ownerGid, ...Object.entries(additions).flatMap(([k, v]) => ['--env', k + '=' + v]), state.containers.build.id, ...argv], timeout);
  // Sampling uses the same boundedChild implementation but one append-only
  // journal, not ordinary command files/state.commands. This avoids races with
  // authoritative create stdout and keeps long phases under retention limits.
  const retainObservation = async value => {
    const bytes = Buffer.from(JSON.stringify(value) + '\n');
    require(bytes.length <= 256 * 1024 && observerBytes + bytes.length <= 512 * 1024 ** 2, 'Observation journal bound exceeded');
    let offset = 0; while (offset < bytes.length) { const count = writeSync(observerLog.fd, bytes, offset, bytes.length - offset); require(count > 0, 'Observation short write'); offset += count; }
    observerBytes += bytes.length; await observerLog.sync();
  };
  const observeDocker = async (label, argv, options = {}) => {
    // The startup/per-phase guard seals all helpers. Each observation checks the
    // directly executed binary/worker. Full source guard remains at command
    // boundaries and finalization; timing gaps caused by hashing stay failures.
    held(known.docker.path, known.docker, false); held(known.volumeWorker.path, known.volumeWorker, false); held(known.kernelWorker.path, known.kernelWorker, false);
    const sequence = observationOrdinal++, args = ['--context', 'desktop-linux', ...argv], startedMs = performance.now(), chunks = [[], []], counts = [0, 0], limits = [65536, 16384], local = new AbortController();
    let result = null, failure = null, childInvoked = false;
    const collect = i => bytes => { const count = Math.min(bytes.length, limits[i] - counts[i]); if (count > 0) { chunks[i].push(Buffer.from(bytes.subarray(0, count))); counts[i] += count; } if (count !== bytes.length) { failure = {message: 'Observer output cap exceeded'}; local.abort('Observer output cap'); } };
    try {
      const timeoutMs = observationTimeoutMs(options.deadlineMs ?? (startedMs + 2000), performance.now());
      childInvoked = true;
      result = await boundedChild(known.docker.path, args, {cwd: known.repo, env, timeoutMs, graceMs: 1000, abortSignal: local.signal, onStdout: collect(0), onStderr: collect(1)});
    }
    catch (error) { result = {code: null, signal: null, error: errorRecord(error)}; if (childInvoked) uncertain = true; }
    if ((result.timedOut || result.interrupted) && result.exitObserved !== true) uncertain = true;
    const stdout = Buffer.concat(chunks[0]), stderr = Buffer.concat(chunks[1]);
    await retainObservation({kind: 'linux-docker-observation-command-1', sequence, label, binary: known.docker, argv: args, startedMs, endedMs: performance.now(), result, failure, stdoutBase64: stdout.toString('base64'), stderrBase64: stderr.toString('base64')});
    require(successfulChild(result) && failure === null, 'Observation command unsuccessful: ' + label);
    return stdout.toString('utf8').trim();
  };
  const observeAttempt = async stage => JSON.parse(await observeDocker('attempt-' + stage, ['exec', '--user', config.ownerUid + ':' + config.ownerGid, state.containers.observer.id, '/usr/bin/python3', '-I', '-S', '-B', '-c', ATTEMPT_OBSERVER, config.attemptId, stage]));
  const assertRetainedClosure = async () => {
    for (const old of Object.values(priorFailed.containers)) {
      const value=JSON.parse(await observeDocker('retained-stopped', ['inspect','--type','container','--format','{"Id":{{json .Id}},"Name":{{json .Name}},"Run":{{json (index .Config.Labels "org.ideogram.rollback-run")}},"State":{{json .State}}}',old.id]));
      require(value.Id===old.id && value.Name==='/'+old.name && value.Run===config.runId && value.State.Running===false && value.State.Restarting===false && value.State.Paused===false && value.State.Dead===false,'Historical stopped-container closure changed');
    }
    const actual=(await observeDocker('retained-attachment-closure',['container','ls','--all','--no-trunc','--filter','volume='+names.volume,'--format','{{.ID}}'])).split('\n').filter(Boolean).sort();
    const expected=[...Object.entries(priorFailed.containers).filter(([role])=>role!=='image').map(([,row])=>row.id),...Object.entries(state.containers).filter(([role])=>role!=='kernel').map(([,row])=>row.id)].sort();
    require(isDeepStrictEqual(actual,expected),'Unowned retained-volume attachment');
  };
  const admitRetainedAttempt = async () => {
    const grantInput = held(config.retainedVolumeGrant.path, config.retainedVolumeGrant), grant = JSON.parse(grantInput.bytes);
    require(grant.output === config.runRoot && grant.attemptId === config.attemptId && isDeepStrictEqual(grant.evidenceAllocation,config.allocation.receipt) && isDeepStrictEqual(grant.dockerAllocation,config.dockerAllocation), 'Retained grant and current configuration differ');
    const refs = [grant.evidenceAllocation,grant.dockerAllocation,grant.prior.receipt,grant.prior.finalization,...grant.sources], artifacts = new Map(refs.map(ref => [ref.path,held(ref.path,ref).bytes]));
    const prior = JSON.parse(artifacts.get(grant.prior.receipt.path)), historicalContainers = [];
    for (const old of Object.values(prior.containers)) {
      const row = JSON.parse(await observeDocker('historical-container', ['inspect','--type','container','--format',INSPECT,old.id]));
      require(row.Id === old.id && row.Name === '/' + old.name && row.Labels?.['org.ideogram.rollback-run'] === config.runId, 'Historical container ownership changed');
      historicalContainers.push({id:row.Id,name:row.Name.slice(1),running:row.State.Running,restarting:row.State.Restarting,paused:row.State.Paused,dead:row.State.Dead});
    }
    const volume = JSON.parse(await observeDocker('retained-volume', ['volume','inspect','--format','{"name":{{json .Name}},"driver":{{json .Driver}},"labels":{{json .Labels}},"optionCount":{{len .Options}}}',names.volume]));
    const image = JSON.parse(await observeDocker('retained-image-labels', ['image','inspect','--format','{"id":{{json .Id}},"labels":{{json .Config.Labels}}}',prior.imageId]));
    const row = await inspect('observer'), observed = await observeAttempt('absent');
    const attachments = (await observeDocker('retained-attachments', ['container','ls','--all','--no-trunc','--filter','volume=' + names.volume,'--format','{{.ID}}'])).split('\n').filter(Boolean);
    const admissionObserver = {id:row.Id,name:row.Name.slice(1),image:row.Image,user:row.User,labels:row.Labels,networkMode:row.Network,pidMode:row.PidMode,readonlyRootfs:row.Readonly,capDrop:row.CapDrop,securityOpt:row.SecurityOpt,privileged:row.Privileged,running:row.State.Running,restarting:row.State.Restarting,paused:row.State.Paused,dead:row.State.Dead,mounts:projectedMounts(observerMounts())};
    retainedAdmission = admitRetainedVolume({grantBytes:grantInput.bytes,expectedGrantSha256:config.retainedVolumeGrant.sha256,artifacts,observed:{...observed,volume,image,historicalContainers,attachments,admissionObserver}});
    state.retainedAdmission = retainedAdmission; references.push(...refs);
    await save(join(out,'retained-admission.json'),retainedAdmission);
  };
  const observeTarget = async target => {
    if (target.type === 'host-checkpoint') { await hostMonitor.checkpoint(); return {bytes: 0, meaning: 'Journal failure watchdog; host audit owns actual allocation measurements'}; }
    if (target.type === 'container') {
      const observed = containerSize(JSON.parse(await observeDocker('size-' + target.role, ['container', 'inspect', '--size', '--format', ENGINE_CONTAINER_FIELDS, target.id])), target);
      return {bytes: observed.writableBytes, ...observed};
    }
    if (target.type === 'image') { const observed = imageSize(JSON.parse(await observeDocker('image-size-' + target.label, ['image', 'inspect', '--format', ENGINE_IMAGE_FIELDS, target.id])), target.id); return {bytes: observed.reportedBytes, ...observed}; }
    require(target.type === 'volume' && observerActive, 'Readonly volume observer unavailable');
    const request = {kind: 'capsule-volume-request-1', mode: volumeMode, ownerUid: config.ownerUid, ownerGid: config.ownerGid, rootIdentity: volumeMode === 'initial-empty' ? null : state.volumeIdentity, policyId: 'capsule-allocated-inodes-1'};
    const scan = async ({outerDeadlineMs} = {}) => { const raw = await observeDocker('volume-' + volumeMode, ['exec', '--user', config.ownerUid + ':' + config.ownerGid, state.containers.observer.id, '/usr/bin/python3', '-I', '-S', '-B', '/inputs/volume-observer.py', '--request-json', JSON.stringify(request)], {deadlineMs:outerDeadlineMs});
    const observed = volumeSize(JSON.parse(raw), request);
    if (volumeMode === 'initial-empty') state.volumeIdentity = observed.rootIdentity;
    return observed; };
    if (quiescenceActive) { const value = await quiescence.observe(scan); return {...value.observation, coordination: value.coordination}; }
    return scan();
  };
  const accountImage = async (id, label) => { const key = 'image:' + id; if (!engineTargets.has(key)) { engineTargets.add(key); await accounting.add({key, type: 'image', id, label, capacityBytes: dockerAllocation.engine.imageReportedCapacityBytes, meaning: 'Engine image Size including shared base; per-object ceiling, not summed/exclusive/allocated bytes'}); } };
  const accountContainer = async role => {
    touched.add(role); // Even a failed observation of a prior recorded CID must drain or retain the lock.
    const selected = await inspect(role), key = 'container:' + selected.Id;
    require(!selected.State.Running && !selected.State.Restarting, 'Owned accounting target must be stopped before phase admission');
    if (!engineTargets.has(key)) { engineTargets.add(key); await accounting.add({key, type: 'container', id: selected.Id, name: names[role], role, runId: config.runId, image: selected.Image, capacityBytes: dockerAllocation.engine.containerWritableCapacityBytes, meaning: 'Engine SizeRw; SizeRootFs retained separately and never added to image or volume bytes'}); }
  };
  const startVolumeObserver = async fresh => {
    volumeMode = 'sample';
    if (fresh) await create('observer', ['--init', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', config.ownerUid + ':' + config.ownerGid, '--read-only', ...mountArgs(observerMounts()), '--entrypoint', '/bin/sleep', state.imageId, 'infinity']);
    await start('observer'); observerActive = true;
    await accounting.add({key: 'volume:' + names.volume, type: 'volume', capacityBytes: dockerAllocation.volume.capacityBytes, meaning: 'Unique inode st_blocks*512 for all /capsule entries; symlink inode only, no traversal'});
  };
  try {
    owner = await acquireTimingLock(await timingLockDirectory(), {receiptId: config.runId + '-' + config.attemptId + '-' + phase});
    await save(join(out, 'timing-acquired.json'), {path: owner.path, identity: owner.identity}); guard();
    hostMonitor = await startEvidenceMonitor({allocationPath: config.allocation.receipt.path, output: out, campaignId: config.runId + '-' + config.attemptId + '-' + phase, intervalMs: 2000, onAlarm: alarm => { if (alarm.status !== 'PASS') accountingFailure(alarm); }});
    state.evidenceStorage = hostMonitor.reference;
    observerLog = await open(join(out, 'docker-observations.jsonl'), 'wx', 0o600);
    accounting = createAccounting({observe: observeTarget, retain: retainObservation, onFailure: accountingFailure});
    await accounting.add({key: 'host-journal-watchdog', type: 'host-checkpoint', capacityBytes: 1, meaning: 'Failure watchdog only, zero is not an allocation measurement'});
    {
      const base = JSON.parse(await observeDocker('base-image-identity', ['image', 'inspect', known.baseImage, '--format', ENGINE_IMAGE_FIELDS]));
      imageSize(base, base.Id); require(!state.baseImageId || state.baseImageId === base.Id, 'Base image changed'); state.baseImageId = base.Id;
      await accountImage(state.baseImageId, 'shared-base');
      if (state.imageId) await accountImage(state.imageId, 'owned-prerequisite');
      const selectedImage = JSON.parse(await observeDocker('selected-image-labels',['image','inspect','--format','{"id":{{json .Id}},"labels":{{json .Config.Labels}}}',state.imageId]));
      require(selectedImage.id===state.imageId,'Selected image label identity differs');
      containerLabels(selectedImage.labels,config.runId,config.attemptId); state.imageLabels=selectedImage.labels;
      for (const role of Object.keys(state.containers)) await accountContainer(role);
      if (phase !== 'bootstrap') await startVolumeObserver(false);
    }
    if (phase === 'bootstrap') {
      // Admission observes the retained whole root and a genuinely absent fresh
      // leaf through this attempt's new read-only observer. No old process starts.
      await create('observer', ['--init', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', config.ownerUid + ':' + config.ownerGid, '--read-only', ...mountArgs(observerMounts()), '--entrypoint', '/bin/sleep', state.imageId, 'infinity']);
      await start('observer'); observerActive = true;
      await admitRetainedAttempt();
      state.volumeIdentity = retainedAdmission.rootIdentity;
      await accounting.add({key: 'volume:' + names.volume, type: 'volume', capacityBytes: dockerAllocation.volume.capacityBytes, meaning: 'Whole retained /capsule unique inode st_blocks*512; includes every failed and current attempt'});
      checkSourceInputs();
      const command = initializerCommand(config.attemptId, config.ownerUid, config.ownerGid);
      await create('init', ['--network', 'none', '--user', '0:0', '--read-only', ...mountArgs([{...wholeVolume,RW:true}]), '--entrypoint', '/bin/sh', state.imageId, ...command.args]);
      await assertRetainedClosure(); await docker('start-init', ['start', state.containers.init.id]); const exit = await docker('wait-init', ['wait', state.containers.init.id], 120000); const init = await inspect('init'); require(exit === '0' && !init.State.Running && init.State.ExitCode === 0, 'Fresh attempt initializer failed');
      validateCreatedAttempt(retainedAdmission, await observeAttempt('created'));
      await accounting.checkpoint('volume:' + names.volume); require(!aborter.signal.aborted, 'Fresh attempt accounting failed');
      const selected = join(config.runRoot, 'selected');
      require(!exists(selected), 'Fresh selection directory required'); await mkdir(selected, {mode:0o700});
      const sourceMounts = [...new Map(sourceRefs().map(ref => [ref.path, bind(ref.path)])).values()];
      state.mounts = [volume, bind(known.producers, '/inputs/producers'), bind(known.bootstrap, '/inputs/bootstrap-toolchain.py'), bind(known.toolchainPins, '/inputs/toolchain.json'), ...sourceMounts, bind(selected), ...known.testMounts.map(x => bind(x.source, x.destination))];
      require(state.mounts.every(x => !/[\n\r,]/.test(x.Source + x.Destination)), 'Unsupported mount path');
      validateRetainedVolumeMounts(retainedAdmission, {observer: projectedMounts(observerMounts()), producer: projectedMounts(state.mounts)});
      await create('build', ['--init', '--network', 'bridge', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', config.ownerUid + ':' + config.ownerGid, '--read-only', '--env', 'HOME=/capsule/home', '--env', 'TMPDIR=/capsule/tmp', '--env', 'PYTHONDONTWRITEBYTECODE=1', ...mountArgs(state.mounts), '--entrypoint', '/bin/sleep', state.imageId, 'infinity']);
      await start('build');
      await exec('initialize-toolchain-directories', ['/bin/sh', '-eu', '-c', 'for name in home tmp toolchain toolchain/tooling workspaces outputs; do mkdir -m 0700 "/capsule/$name"; done']);
      await exec('copy-bootstrap', ['/bin/cp', '/inputs/bootstrap-toolchain.py', '/capsule/toolchain/tooling/bootstrap-toolchain.py']); await exec('copy-toolchain', ['/bin/cp', '/inputs/toolchain.json', '/capsule/toolchain/tooling/toolchain.json']);
      await create('kernel', ['--init', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', config.kernelObserverUid + ':' + config.kernelObserverGid, '--read-only', '--pid', 'container:' + state.containers.build.id, '--cgroupns', 'host', ...mountArgs(kernelMounts()), '--entrypoint', '/bin/sleep', state.imageId, 'infinity']);
      await start('kernel');
      quiescence = createToolchainQuiescence({writer:{id:state.containers.build.id,runId:config.runId,image:state.imageId,user:config.ownerUid+':'+config.ownerGid},kernelObserver:{id:state.containers.kernel.id,user:config.kernelObserverUid+':'+config.kernelObserverGid},command:observeDocker,retain:retainObservation,clock:()=>performance.now(),onUncertain:()=>{uncertain=true;}});
      const idle = await quiescence.admit(); state.quiescenceAdmission = idle;
      let payload = null;
      try {
        await accounting.coordinate(async () => {
          const launch=bootstrapLaunch({start:callback=>run('recipe-bootstrap',known.docker.path,['--context','desktop-linux',...bootstrapPayloadArgs(state.containers.build.id,config.ownerUid,config.ownerGid)],1200000,{},false,callback),abort:reason=>aborter.abort(reason)});
          payload=launch.completion;
          try { await launch.ready; quiescenceActive=true; }
          catch(error) { await payload.catch(()=>{}); throw error; }
        });
        await payload;
      } finally {
        if (payload) await payload.catch(()=>{});
        await accounting.coordinate(async()=>{const closed=await quiescence.close();quiescenceActive=false;state.quiescenceClosure=closed;require(isDeepStrictEqual(idle.members,closed.kernelObservation.members),'Bootstrap descendants did not return to authenticated idle membership');});
      }
    } else {
      checkSourceInputs();
      require(Array.isArray(state.mounts), 'Bootstrap mount inventory absent');
      if (phase === 'observe') {
        await start('build');
        for (const [label, argv] of [['packages', ['/usr/bin/dpkg-query', '-W']], ['loader', ['/usr/sbin/ldconfig', '-p']], ['glibc', ['/usr/bin/getconf', 'GNU_LIBC_VERSION']], ['triplet', ['/usr/bin/gcc', '-dumpmachine']], ...['cc1', 'cc1plus', 'collect2', 'as', 'ld'].map(name => [name, ['/usr/bin/gcc', '-print-prog-name=' + name]])]) await exec('observe-' + label, argv, 30000);
        await exec('observe-node-libraries', ['/capsule/toolchain/.toolchain/node-v26.10.0-linux-arm64/bin/node', '-e', 'console.log(JSON.stringify({platform:process.platform,arch:process.arch,sharedObjects:process.report.getReport().sharedObjects}))']);
      } else if (phase === 'tests' || phase.startsWith('build')) {
        if (phase === 'tests') { state.hostSelection = config.hostSelection; require(state.hostSelection?.path === join(config.runRoot, 'selected', 'host-selection.json'), 'Actual host selection must use owned readonly parent'); data(state.hostSelection); }
        else require(isDeepStrictEqual(state.hostSelection, config.hostSelection), 'Selected host changed');
        held(state.hostSelection.path, state.hostSelection); await start('build');
        if (phase === 'tests') {
          const selection = [17, 18].map(storageVersion => ({storageVersion, sourceInput: {path: state.sourceInputs[storageVersion].path, hash: 'sha256:' + state.sourceInputs[storageVersion].sha256, byteLength: String(state.sourceInputs[storageVersion].bytes)}}));
          const selected = join(config.runRoot, 'selected', 'selected-genuine-sources.json'); await save(selected, selection); await exec('copy-genuine-selection', ['/bin/cp', selected, '/capsule/selected-genuine-sources.json']);
          await plan('tests', 2400000);
          const testCommand = state.commands.at(-1), testText = held(testCommand.stdout.path).bytes.toString() + held(testCommand.stderr.path).bytes.toString();
          require(!/OK \(skipped=|# skipped [1-9]|# todo [1-9]/.test(testText), 'Source fixtures skipped required cases');
          await exec('restore-fixtures', ['/usr/bin/timeout', '--signal=TERM', '--kill-after=10s', '180s', '/usr/bin/python3', '-I', '-S', '-B', '/inputs/execution-plan/tests/test_restore_data.py'], 210000, {PYTHONDONTWRITEBYTECODE: '1', TMPDIR: '/capsule/tmp', LINUX_OWNED_TRANSPORT_REQUIRE_NATIVE: '1'});
          const restoreCommand = state.commands.at(-1), restoreText = held(restoreCommand.stdout.path).bytes.toString() + held(restoreCommand.stderr.path).bytes.toString();
          require(/Ran 10 tests? in /.test(restoreText) && /\nOK\s*$/.test(restoreText) && !/skipped=/.test(restoreText), 'All ten native restore fixtures must execute');
        } else { await plan(phase, 14400000); const v = phase.slice(5); const raw = await exec('draft-identity', ['/usr/bin/sha256sum', '/capsule/outputs/' + phase + '/draft.json']); require(/^[a-f0-9]{64}  \/capsule\/outputs\/build(?:16|17|18)\/draft\.json$/.test(raw), 'Draft hash missing'); state.drafts[v] = {path: '/capsule/outputs/' + phase + '/draft.json', hash: 'sha256:' + raw.slice(0, 64)}; }
      } else {
        held(state.hostSelection.path, state.hostSelection);
        if (phase === 'verify16') await create('verify', ['--init', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', config.ownerUid + ':' + config.ownerGid, '--read-only', '--env', 'HOME=/capsule/home', '--env', 'TMPDIR=/capsule/tmp', '--env', 'PYTHONDONTWRITEBYTECODE=1', ...mountArgs(state.mounts), '--entrypoint', '/bin/sleep', state.imageId, 'infinity']);
        await start('verify'); await plan(phase, 7200000); const v = phase.slice(6);
        const raw = await docker('packet-identity', ['exec', '--user', config.ownerUid + ':' + config.ownerGid, state.containers.verify.id, '/usr/bin/sha256sum', '/capsule/outputs/verified' + v + '/packet.json']); require(/^[a-f0-9]{64}  \/capsule\/outputs\/verified(?:16|17|18)\/packet\.json$/.test(raw), 'Packet hash missing'); state.packets[v] = {path: '/capsule/outputs/verified' + v + '/packet.json', hash: 'sha256:' + raw.slice(0, 64)};
      }
    }
    guard(); require(Object.values(globalThis.__storeNetworkCounters.read()).every(n => n === 0), 'Unexpected parent network effects'); state.result = 'passed';
  } catch (e) { state.result = 'failed'; state.failure = errorRecord(e); }
  finally {
    // Mutating containers drain while both observers remain active. Sidecar is
    // the final owned daemon process to drain after its last volume observation.
    if (quiescenceActive) try { await accounting.coordinate(async()=>{state.quiescenceCleanup = await quiescence.close(); quiescenceActive = false; require(isDeepStrictEqual(state.quiescenceAdmission.members,state.quiescenceCleanup.kernelObservation.members),'Bootstrap cleanup membership differs');}); } catch (error) { uncertain = true; state.result = 'failed'; state.cleanupFailure ??= []; state.cleanupFailure.push({role:'quiescence',error:errorRecord(error)}); }
    if (pendingCreate.has('kernel') || touched.has('kernel')) try { await stop('kernel'); } catch (error) { uncertain = true; state.result = 'failed'; state.cleanupFailure ??= []; state.cleanupFailure.push({role:'kernel',error:errorRecord(error)}); }
    for (const role of new Set([...pendingCreate, ...touched])) if (role !== 'observer' && role !== 'kernel') try { await stop(role); } catch (e) { uncertain = true; state.result = 'failed'; state.cleanupFailure ??= []; state.cleanupFailure.push({role, error: errorRecord(e)}); }
    if (observerActive) try { await accounting.retire('volume:' + names.volume); } catch (e) { state.result = 'failed'; state.accountingFailure ??= errorRecord(e); }
    if (pendingCreate.has('observer') || touched.has('observer')) try { await stop('observer'); } catch (e) { uncertain = true; state.result = 'failed'; state.cleanupFailure ??= []; state.cleanupFailure.push({role: 'observer', error: errorRecord(e)}); }
    if (accounting) try { state.dockerObservations = await accounting.finish(); if (state.dockerObservations.status !== 'PASS') state.result = 'failed'; } catch (e) { state.result = 'failed'; state.accountingFailure ??= errorRecord(e); }
    if (observerLog) try { try { await observerLog.sync(); } finally { await observerLog.close(); } state.observationJournal = held(join(out, 'docker-observations.jsonl'), null, false, 512 * 1024 ** 2).ref; }
    catch (error) { state.result = 'failed'; state.accountingFailure ??= errorRecord(error); }
  }
  if (aborter.signal.aborted) { state.result = 'failed'; state.interrupted = String(aborter.signal.reason); }
  state.finishedAt = new Date().toISOString(); state.cleanupComplete = !uncertain;
  // The raw receipt never changes after this point, including its honest held
  // lock state. Audit/verifier/drain/release outcomes live in finalization.json.
  state.timingLock = owner ? {path: owner.path, identity: owner.identity, heldAtReceiptSeal: true} : null;
  state.timingLockReleased = false;
  const receipt = await save(join(out, 'receipt.json'), state);
  const finalized = {kind: 'local-linux-controller-finalization-1', receipt, result: state.result, hostAudit: null, hostVerification: null, dockerObservationStatus: state.dockerObservations?.status ?? 'INCONCLUSIVE', timingLockReleased: false, failure: null, qualification: false};
  try {
    require(hostMonitor !== null, 'Host monitor was not established');
    finalized.hostAudit = await hostMonitor.finish({receiptPath: receipt.path, outcome: state.result});
    await retainEvidenceAudit(hostMonitor.reference, out);
    finalized.hostVerification = await verifyEvidenceAudit(hostMonitor.reference, receipt.path);
    require(finalized.hostAudit.status === 'PASS' && finalized.hostVerification.status === 'PASS', 'Host evidence accounting unavailable or unsuccessful');
    guard(); require(!aborter.signal.aborted, 'Interrupted during accounting finalization');
  } catch (error) { finalized.result = 'failed'; finalized.failure = errorRecord(error); }
  if (owner && !uncertain) try { await owner.release(); finalized.timingLockReleased = true; } catch (e) { finalized.result = 'failed'; finalized.failure ??= errorRecord(e); }
  if (!finalized.timingLockReleased) finalized.result = 'failed';
  if (aborter.signal.aborted) { finalized.result = 'failed'; finalized.failure ??= {message: 'Interrupted before terminal commit: ' + String(aborter.signal.reason)}; }
  // All asynchronous work is drained. This terminal section has no event-loop
  // yield: a handled signal cannot race between the last check and receipt seal.
  // A later process-level interruption is outside the completed work boundary;
  // the operator still requires actual CLI exit0 before selecting its receipt.
  process.off('SIGINT', onInt); process.off('SIGTERM', onTerm);
  const finalRef = terminalSave(join(out, 'finalization.json'), finalized);
  console.log(JSON.stringify({result: finalized.result, receipt, finalization: finalRef, timingLockReleased: finalized.timingLockReleased}, null, 2)); process.exitCode = finalized.result === 'passed' ? 0 : 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
