// Hosted prerequisite bootstrap scheduling only. Never used by a sealed native
// build/restore/proof, original producer-running campaign, or performance claim.
import {constants} from 'node:fs';
import {open, lstat, realpath, mkdir, rmdir} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {randomUUID, createHash} from 'node:crypto';

export const TOOLCHAIN_SCHEDULING = 'hosted-toolchain-quiescent-inodes-1';
export const SYNCHRONIZATION_WINDOW_MS = 1000;
const require = (value, code) => {if (!value) throw Error(code);};
const integer = value => Number.isSafeInteger(value) && value >= 0;
const safeCode = error => /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.message??'') ? error.message : 'FREEZER_SYSTEM_ERROR';
const digest = value => createHash('sha256').update(value).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

async function read(path, maximum = 131072) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_CLOEXEC);
  try {
    const chunks=[];let bytes=0;
    for (;;) {const b=Buffer.alloc(Math.min(16384,maximum+1-bytes)), n=await handle.read(b,0,b.length,null);if(!n.bytesRead)break;bytes+=n.bytesRead;require(bytes<=maximum,'FREEZER_READ_BOUND');chunks.push(b.subarray(0,n.bytesRead));}
    return Buffer.concat(chunks).toString('ascii');
  } finally {await handle.close();}
}
async function immutable(path) {
  require(resolve(path) === path && await realpath(path) === path, 'FREEZER_CANONICAL');
  for(let current=path;;current=dirname(current)){const s=await lstat(current);require(s.isDirectory()&&s.uid===0&&!(s.mode&0o022),'FREEZER_ANCESTRY');if(dirname(current)===current)break;}
}
export function cgroupHierarchy(membership, mountinfo) {
  const rows=membership.trimEnd().split('\n');require(rows.length===1&&rows[0].startsWith('0::'),'FREEZER_UNIFIED_REQUIRED');
  const safe=value=>typeof value==='string'&&value.length<=4096&&value.startsWith('/')&&!value.startsWith('//')&&!value.includes('\\')&&!/[\x00-\x20\x7f]/.test(value)&&resolve(value)===value;
  const current=rows[0].slice(3);require(safe(current),'FREEZER_MEMBERSHIP_PATH');const mounts=[];
  for(const row of mountinfo.trimEnd().split('\n')){const fields=row.split(' '),sep=fields.indexOf('-');if(sep<0||fields[sep+1]!=='cgroup2')continue;require(fields.length>sep+3&&safe(fields[3])&&safe(fields[4]),'FREEZER_MOUNT_SHAPE');mounts.push({fields,sep});}
  // A subtree-rooted or alternate visible mount cannot establish the complete
  // visible common-ancestor control closure. Never use PID1 as a global proxy.
  require(mounts.length===1,'FREEZER_MOUNT_AMBIGUOUS');const {fields,sep}=mounts[0];
  require(fields[3]==='/','FREEZER_HIDDEN_ANCESTRY');require(fields[5].split(',').includes('rw')&&fields[sep+3].split(',').includes('rw'),'FREEZER_READ_ONLY');
  const mount=fields[4],parent=join(mount,current.slice(1)),ancestors=[];
  for(let item=parent;;item=dirname(item)){require(ancestors.length<128&&safe(item)&&(item===mount||item.startsWith(mount.replace(/\/$/,'')+'/')),'FREEZER_ANCESTOR_BOUND');ancestors.push(item);if(item===mount)break;}
  return {parent,mount,ancestors};
}
export const cgroupLocation=(membership,mountinfo)=>cgroupHierarchy(membership,mountinfo).parent;
export async function authenticateHierarchy(layout,{inspect=lstat}={}) {
  const rows=[];
  for(const path of layout.ancestors){
    const directory=await inspect(path),control=await inspect(join(path,'cgroup.procs'));
    require(directory.isDirectory()&&directory.uid===0&&!(directory.mode&0o022),'FREEZER_ANCESTOR_OWNER');
    require(control.isFile()&&control.uid===0&&!(control.mode&0o022),'FREEZER_ANCESTOR_CONTROL');
    rows.push({directory:{dev:directory.dev,ino:directory.ino,uid:directory.uid,mode:directory.mode},control:{dev:control.dev,ino:control.ino,uid:control.uid,mode:control.mode}});
  }
  require(rows.length>0&&rows.length<=128,'FREEZER_ANCESTOR_BOUND');return rows;
}
export function eventValues(raw) {
  const value={};for(const line of raw.trimEnd().split('\n')){const fields=line.split(' ');require(fields.length===2&&['populated','frozen'].includes(fields[0])&&!(fields[0] in value)&&/^[01]$/.test(fields[1]),'FREEZER_EVENTS');value[fields[0]]=Number(fields[1]);}
  require(Object.keys(value).length===2,'FREEZER_EVENTS');return value;
}
export function memberValues(raw) {const values=raw.trim().split(/\s+/).filter(Boolean);require(values.length<=4096&&values.every(x=>/^[1-9][0-9]*$/.test(x)&&Number.isSafeInteger(Number(x))),'FREEZER_MEMBER_BOUND');const result=values.map(Number).sort((a,b)=>a-b);require(new Set(result).size===result.length,'FREEZER_DUPLICATE_MEMBER');return result;}
export function processFields(pid, status, rawStat) {
  const names=['Uid','Gid','Groups','CapInh','CapPrm','CapEff','CapBnd','CapAmb','NoNewPrivs'], fields={};
  for(const name of names){const rows=status.split('\n').filter(x=>x.startsWith(name+':'));require(rows.length===1,'FREEZER_STATUS');fields[name]=rows[0].slice(name.length+1).trim();}
  const tail=rawStat.slice(rawStat.lastIndexOf(') ')+2).trim().split(/\s+/);require(rawStat.includes(') ')&&tail.length>=20&&/^\d+$/.test(tail[19]),'FREEZER_STAT');
  const numbers = value => value===''?[]:value.split(/\s+/).map(x=>{require(/^\d+$/.test(x)&&Number.isSafeInteger(Number(x)),'FREEZER_CREDENTIAL');return Number(x);});
  const caps=names.filter(x=>x.startsWith('Cap')).map(x=>{require(/^[a-fA-F0-9]+$/.test(fields[x]),'FREEZER_CAPABILITY');return BigInt('0x'+fields[x]).toString();});
  return {pid,start:tail[19],parent:Number(tail[1]),uids:numbers(fields.Uid),gids:numbers(fields.Gid),groups:numbers(fields.Groups),capabilities:caps,noNewPrivs:fields.NoNewPrivs};
}
export function validateMemberIdentities(rows, owner, ready) {
  for(const row of rows){
    require(integer(row.pid)&&row.pid>0&&/^\d+$/.test(row.start),'FREEZER_PROCESS_IDENTITY');
    if(ready&&row.pid===ready.pid)require(row.start===ready.start,'FREEZER_PID_REUSED');
    const selected=same(row.uids,[owner.uid,owner.uid,owner.uid,owner.uid])&&same(row.gids,[owner.gid,owner.gid,owner.gid,owner.gid])&&row.groups.length===0&&row.capabilities.length===5&&row.capabilities.every(x=>x==='0')&&row.noNewPrivs==='1';
    // The only allowed privileged member is the source-bound launch stub during
    // its fixed attach -> setpriv exec transition, before payload code can run.
    const stub=ready&&row.pid===ready.pid&&row.start===ready.start&&row.parent===process.pid&&row.uids.length===4&&row.uids.every(x=>x===0);
    require(selected||stub,'FREEZER_FOREIGN_MEMBER');
  }
  return rows.map(x=>({pid:x.pid,start:x.start}));
}

// Admission exclusion prevents a new root launch stub from joining midway
// through a frozen observation. Waiting consumes each caller's original clock.
export function admissionGate({clock=()=>performance.now(),sleep=pause}={}) {
  let observing=false,admitting=false;
  return {
    async acquire(deadline){while(admitting||observing){require(clock()<=deadline,'FREEZER_ADMISSION_DEADLINE');await sleep(5);}require(clock()<=deadline,'FREEZER_ADMISSION_DEADLINE');observing=true;},
    release(){observing=false;},
    async begin(deadline,cancelled=()=>false){require(!admitting,'FREEZER_WRITER_OVERLAP');while(observing){require(!cancelled()&&clock()<=deadline,'FREEZER_WRITER_DEADLINE');await sleep(5);}require(!cancelled()&&clock()<=deadline&&!admitting,'FREEZER_WRITER_DEADLINE');admitting=true;},
    ready(){admitting=false;},
  };
}

// Injectable control seam tests actual scheduling and failure behavior without
// starting a payload, touching a cgroup, or granting a kernel capability result.
export async function coordinateObservation(scope, observe, {clock=()=>performance.now(),sleep=pause}={}) {
  const startedMs=clock(), deadline=startedMs+SYNCHRONIZATION_WINDOW_MS;
  const trace={policy:TOOLCHAIN_SCHEDULING,startedMs,groupIdentity:scope.identity,freezeRequestedMs:null,frozenMs:null,scanStartedMs:null,scanEndedMs:null,thawRequestedMs:null,thawedMs:null,endedMs:null,members:null,frozenEvents:null,afterScanEvents:null,thawedEvents:null,failure:null,cleanupFailure:null};
  const check = () => require(clock()<=deadline,'FREEZER_WINDOW_EXCEEDED');
  async function until(expected){for(;;){check();const events=await scope.events();if(events.frozen===expected)return events;await sleep(5);}}
  let value, primary=null, requested=false, acquired=false;
  try {
    if(scope.acquire){await scope.acquire(deadline);acquired=true;}
    await scope.ready(deadline);check();trace.freezeRequestedMs=clock();requested=true;await scope.write('cgroup.freeze','1');trace.frozenEvents=await until(1);trace.frozenMs=clock();
    trace.members=await scope.identities(deadline);check();trace.scanStartedMs=clock();
    value=await observe({outerDeadlineMs:startedMs+2000});trace.scanEndedMs=clock();check();
    trace.afterScanEvents=await scope.events();require(trace.afterScanEvents.frozen===1&&same(await scope.identities(deadline),trace.members),'FREEZER_MEMBERSHIP_DRIFT');
  } catch(error) {primary=error;trace.failure={code:safeCode(error)};}
  finally {
    if(requested){trace.thawRequestedMs=clock();try{await scope.write('cgroup.freeze','0');trace.thawedEvents=await until(0);trace.thawedMs=clock();}catch(error){trace.cleanupFailure={code:safeCode(error)};primary??=error;}}
    if(acquired)scope.release();
    trace.endedMs=clock();if(trace.endedMs>deadline){primary??=Error('FREEZER_WINDOW_EXCEEDED');trace.failure??={code:'FREEZER_WINDOW_EXCEEDED'};}
  }
  return {value,trace,error:primary};
}

export function verifyCoordination(value, command, record, expectedGroup) {
  require(same(value?.groupIdentity,expectedGroup),'FREEZER_REPLAY_GROUP');
  require(value?.policy===TOOLCHAIN_SCHEDULING&&value.failure===null&&value.cleanupFailure===null,'FREEZER_REPLAY_FAILURE');
  const times=['startedMs','freezeRequestedMs','frozenMs','scanStartedMs','scanEndedMs','thawRequestedMs','thawedMs','endedMs'].map(k=>value[k]);
  require(times.every(x=>Number.isFinite(x)&&x>=0)&&times.every((x,i)=>i===0||x>=times[i-1]),'FREEZER_REPLAY_TIME');
  require(record.startedMs<=value.startedMs&&record.endedMs-value.startedMs<=SYNCHRONIZATION_WINDOW_MS&&value.endedMs<=record.endedMs,'FREEZER_REPLAY_WINDOW');
  require(command.startedMs>=value.scanStartedMs&&command.endedMs<=value.scanEndedMs,'FREEZER_REPLAY_COMMAND');
  require(integer(value.groupIdentity?.dev)&&integer(value.groupIdentity?.ino)&&value.groupIdentity.ino>0&&Array.isArray(value.members)&&value.members.length<=4096,'FREEZER_REPLAY_BINDING');
  require(value.frozenEvents?.frozen===1&&value.afterScanEvents?.frozen===1&&value.thawedEvents?.frozen===0&&[value.frozenEvents,value.afterScanEvents,value.thawedEvents].every(x=>[0,1].includes(x.populated)),'FREEZER_REPLAY_EVENTS');
  require(value.members.every(x=>integer(x.pid)&&x.pid>0&&/^\d+$/.test(x.start))&&new Set(value.members.map(x=>x.pid)).size===value.members.length,'FREEZER_REPLAY_MEMBERS');
  return true;
}

export async function createToolchainScope({runId,owner}) {
  require(process.platform==='linux'&&process.getuid()===0&&/^ie-native-[a-f0-9]{32}$/.test(runId),'FREEZER_ROOT_SCOPE');
  const layout=cgroupHierarchy(await read('/proc/self/cgroup'),await read('/proc/self/mountinfo')),parent=layout.parent;await immutable(parent);
  const ancestry=await authenticateHierarchy(layout);
  async function checkHierarchy(){require(same(await authenticateHierarchy(layout),ancestry),'FREEZER_ANCESTRY_DRIFT');}
  const name='ideogram-toolchain-'+runId.slice(10)+'-'+randomUUID().replaceAll('-',''),path=join(parent,name);await mkdir(path,0o700);
  let original;try{original=await lstat(path);}catch(cause){const error=Error('FREEZER_CREATED_IDENTITY_UNAVAILABLE');error.cleanupUncertain=true;throw error;}
  const identity={dev:original.dev,ino:original.ino};let readyValue=null,readyResolve=null,readyReject=null,readyPromise=null;const gate=admissionGate();
  async function check(){const current=await lstat(path);require(current.isDirectory()&&current.uid===0&&!(current.mode&0o022)&&current.dev===identity.dev&&current.ino===identity.ino,'FREEZER_GROUP_REPLACED');}
  async function control(name,writeValue=null){require(['cgroup.procs','cgroup.freeze','cgroup.kill','cgroup.events','cgroup.type'].includes(name),'FREEZER_CONTROL');await check();const target=join(path,name),s=await lstat(target);require(s.isFile()&&s.uid===0&&!(s.mode&0o022),'FREEZER_CONTROL_OWNER');if(writeValue===null)return read(target,65536);require(name==='cgroup.freeze'&&['0','1'].includes(writeValue)||name==='cgroup.kill'&&writeValue==='1','FREEZER_WRITE');const h=await open(target,constants.O_WRONLY|constants.O_NOFOLLOW|constants.O_CLOEXEC);try{const raw=Buffer.from(writeValue+'\n'),v=await h.write(raw,0,raw.length,null);require(v.bytesWritten===raw.length,'FREEZER_SHORT_WRITE');}finally{await h.close();}}
  const scope={identity,locatorSHA256:digest(path),events:async()=>eventValues(await control('cgroup.events')),write:control,
    async identities(deadline=Infinity){await checkHierarchy();const pids=memberValues(await control('cgroup.procs')),rows=[];for(const pid of pids){require(performance.now()<=deadline,'FREEZER_WINDOW_EXCEEDED');rows.push(processFields(pid,await read('/proc/'+pid+'/status'),await read('/proc/'+pid+'/stat')));}require(performance.now()<=deadline,'FREEZER_WINDOW_EXCEEDED');return validateMemberIdentities(rows,owner,readyValue);},
    acquire:deadline=>gate.acquire(deadline),
    release:()=>gate.release(),
    async begin(deadline,cancelled=()=>false){require(readyPromise===null,'FREEZER_WRITER_OVERLAP');await gate.begin(deadline,cancelled);try{await checkHierarchy();}catch(error){gate.ready();throw error;}readyValue=null;readyPromise=new Promise((ok,bad)=>{readyResolve=ok;readyReject=bad;});readyPromise.catch(()=>{});},
    accept(value){require(value&&Object.keys(value).sort().join('|')===['kind','pid','start','groupIdentity','attached','privilegeDropPending'].sort().join('|')&&value?.kind==='hosted-toolchain-writer-ready-1'&&same(value.groupIdentity,identity)&&integer(value.pid)&&value.pid>0&&/^\d+$/.test(value.start)&&value.attached===true&&value.privilegeDropPending===true&&readyValue===null,'FREEZER_WRITER_READY');readyValue=value;gate.ready();readyResolve();},
    async ready(deadline){await checkHierarchy();if(!readyPromise)return;while(!readyValue){require(performance.now()<=deadline,'FREEZER_WRITER_READY_DEADLINE');await Promise.race([readyPromise,pause(Math.min(5,Math.max(0,deadline-performance.now())))]);}},
    async end(){gate.ready();const missing=!readyValue;if(missing)readyReject(Error('FREEZER_WRITER_NOT_READY'));require((await scope.identities()).length===0,'FREEZER_WRITER_NOT_DRAINED');readyPromise=null;readyResolve=null;readyReject=null;require(!missing,'FREEZER_WRITER_NOT_READY');},
    selection(config,configPath,grant){return {binary:config.tools.python.path,args:['-I','-S','-B',join(config.controlRoot,'tooling/rollback-producer/hosted-toolchain-launch.py'),'--config',configPath,'--grant',grant,'--group',path,'--group-dev',String(identity.dev),'--group-ino',String(identity.ino)]};},
    async close(){let failure=null;for(const [name,value] of [['cgroup.freeze','0'],['cgroup.kill','1']])try{await control(name,value);}catch(error){failure??=error;}try{require(memberValues(await control('cgroup.procs')).length===0&&(await scope.events()).populated===0,'FREEZER_CLEANUP_NOT_EMPTY');await check();await rmdir(path);}catch(error){failure??=error;}if(failure)throw failure;return {complete:true,groupIdentity:identity};},
  };
  try{require((await control('cgroup.type')).trim()==='domain'&&memberValues(await control('cgroup.procs')).length===0&&(await scope.events()).populated===0&&(await scope.events()).frozen===0,'FREEZER_INITIAL_STATE');return scope;}
  catch(error){try{await scope.close();}catch(cleanup){error.cleanupUncertain=true;}throw error;}
}
