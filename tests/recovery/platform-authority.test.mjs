// SOURCE-ONLY successor: authored without execution. Every synthetic pin below
// is test data for selection only; none is a product authority or packet proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import {freezeRollbackAuthorities,selectRollbackExecutable,SCHEMA16_MAINTENANCE_AUTHORITIES,schema16MaintenanceExecutablePin} from '../../dist/local/server/storage/platform-authority.js';
import {REQUEST_FAMILY_SCHEMA17_AUTHORITIES,REQUEST_FAMILY_SCHEMA17_EXECUTABLE,requestFamilyExecutablePin,assertRequestFamilyMigrationReady,assertEditorStorageCompatibility} from '../../dist/local/server/storage/schema.js';
import {COMPOSITION_TEXT_SCHEMA18_AUTHORITIES,COMPOSITION_TEXT_SCHEMA18_EXECUTABLE,compositionTextExecutablePin,compositionTextInstalledPacket,assertCompositionTextMigrationReady} from '../../dist/local/server/storage/composition-text-schema.js';

const kinds=['schema17-executable-pin-1','schema18-executable-pin-1'];
const digest=letter=>'sha256:'+letter.repeat(64);
function syntheticPin(kind=kinds[1],os='darwin',arch='arm64'){
  return {kind,packetId:'test_only_'+kind.slice(0,8)+'_'+os+'_'+arch,identityHash:digest('a'),platform:{os,arch,identity:digest('b')}};
}
const authority=(kind=kinds[1],os='darwin',arch='arm64')=>({os,arch,pin:syntheticPin(kind,os,arch)});
const select=(rows,os='darwin',arch='arm64',kind=kinds[1])=>selectRollbackExecutable(kind,rows,os,arch);
const refusal=code=>error=>error?.code==='UNSUPPORTED_STORAGE'&&error.detail?.kind==='fields'&&
  error.detail.issues.length===1&&error.detail.issues[0].path==='storage.schemaVersion'&&error.detail.issues[0].code===code;
const invalid=refusal('ROLLBACK_EXECUTABLE_AUTHORITY_INVALID');
const missing=refusal('ROLLBACK_EXECUTABLE_AUTHORITY_MISSING');
const unissued=refusal('ROLLBACK_EXECUTABLE_AUTHORITY_UNISSUED');
function assertFrozenPin(pin){assert(Object.isFrozen(pin));assert(Object.isFrozen(pin.platform));}

test('registry freezing detaches all supported object levels without freezing caller data',()=>{
  const source=[authority(),{os:'linux',arch:'x64',pin:null}],before=structuredClone(source);
  const frozen=freezeRollbackAuthorities(source);
  assert.deepEqual(frozen,before);assert.notEqual(frozen,source);assert(Object.isFrozen(frozen));
  for(let i=0;i<source.length;i++){assert.notEqual(frozen[i],source[i]);assert(Object.isFrozen(frozen[i]));assert(!Object.isFrozen(source[i]));}
  assert.notEqual(frozen[0].pin,source[0].pin);assert.notEqual(frozen[0].pin.platform,source[0].pin.platform);assertFrozenPin(frozen[0].pin);
  assert(!Object.isFrozen(source));assert(!Object.isFrozen(source[0].pin));assert(!Object.isFrozen(source[0].pin.platform));
  source[0].pin.packetId='caller_changed';source[0].pin.platform.identity=digest('c');source[1].os='freebsd';source.push(authority(kinds[1],'linux','arm64'));
  assert.deepEqual(frozen,before);
  assert.throws(()=>frozen.push(authority()),TypeError);assert.throws(()=>{frozen[0].os='linux';},TypeError);
  assert.throws(()=>{frozen[0].pin.packetId='changed';},TypeError);assert.throws(()=>{frozen[0].pin.platform.identity=digest('d');},TypeError);
});

test('constructing a frozen unissued registry does not impose an import-time migration gate',()=>{
  const rows=freezeRollbackAuthorities([{os:'darwin',arch:'arm64',pin:null}]);
  assert.equal(rows[0].pin,null);assert.throws(()=>select(rows),unissued);assert.throws(()=>select(rows,'linux','x64'),missing);
});

for(const kind of kinds)test('selection uses exact independently listed test platform for '+kind,()=>{
  const rows=freezeRollbackAuthorities([authority(kind),authority(kind,'linux','x64'),authority(kind,'linux','arm64')]);
  for(const row of rows){
    const pin=select(rows,row.os,row.arch,kind);assert.deepEqual(pin,row.pin);assert.notEqual(pin,row.pin);assert.notEqual(pin.platform,row.pin.platform);assertFrozenPin(pin);
  }
});

test('selection from mutable input returns an independently frozen pin',()=>{
  const source=[authority()],expected=structuredClone(source[0].pin),pin=select(source);
  source[0].pin.identityHash=digest('c');source[0].pin.platform.os='linux';
  assert.deepEqual(pin,expected);assertFrozenPin(pin);assert.throws(()=>{pin.platform.arch='x64';},TypeError);
});

test('missing platform never falls back to another OS, architecture, first row, or null row',()=>{
  const rows=[authority(),{os:'linux',arch:'arm64',pin:null}];
  assert.throws(()=>select(rows,'linux','x64'),missing);assert.throws(()=>select(rows,'darwin','x64'),missing);
  assert.throws(()=>select(rows,'win32','x64'),missing);assert.throws(()=>select([]),missing);
  assert.throws(()=>select(rows,'linux','arm64'),unissued);assert.deepEqual(select(rows),rows[0].pin);
});

for(const variant of ['identical','different-pin','unissued'])test('duplicate OS/architecture refuses even with '+variant+' values',()=>{
  const first=authority(),second=structuredClone(first);
  if(variant==='different-pin')second.pin.identityHash=digest('c');
  if(variant==='unissued')second.pin=null;
  assert.throws(()=>select([first,second]),invalid);
});

test('duplicate nonselected platform refuses before returning an otherwise valid selection',()=>{
  const foreign=authority(kinds[1],'linux','x64');
  assert.throws(()=>select([authority(),foreign,structuredClone(foreign)]),invalid);
});

test('wrong-kind nonselected authority refuses the whole registry',()=>{
  assert.throws(()=>select([authority(),authority(kinds[0],'linux','x64')]),invalid);
  assert.throws(()=>select([authority(kinds[0])]),invalid);
});

for(const field of ['os','arch'])test('row and pin platform '+field+' must agree exactly',()=>{
  const row=authority();row.pin.platform[field]=field==='os'?'linux':'x64';assert.throws(()=>select([row]),invalid);
});

test('null and malformed rows are invalid rather than missing or unissued authority',()=>{
  for(const rows of [null,undefined,{},'rows',[null],[undefined],[false],[[]],[{}],Array(1)])assert.throws(()=>select(rows),invalid);
  const row=authority();delete row.pin;assert.throws(()=>select([row]),invalid);
  assert.throws(()=>select([{os:'darwin',arch:'arm64',pin:false}]),invalid);
});

test('all record levels reject missing and extra ordinary JSON fields',()=>{
  const changes=[
    row=>{row.extra=true;},row=>{delete row.arch;},row=>{row.pin.extra=true;},
    row=>{delete row.pin.identityHash;},row=>{row.pin.platform.extra=true;},row=>{delete row.pin.platform.identity;},
  ];
  for(const change of changes){const row=authority();change(row);assert.throws(()=>select([row]),invalid,change.toString());}
});

test('packet identifiers and both digest fields require their exact bounded formats',()=>{
  for(const packetId of ['', 'bad/id', 'bad id', 'x'.repeat(129), 12]){
    const row=authority();row.pin.packetId=packetId;assert.throws(()=>select([row]),invalid);
  }
  for(const value of ['a'.repeat(64),'sha256:'+'A'.repeat(64),'sha256:'+'a'.repeat(63),'sha256:'+'a'.repeat(65),null]){
    for(const field of ['identityHash','platform']){
      const row=authority();if(field==='platform')row.pin.platform.identity=value;else row.pin.identityHash=value;
      assert.throws(()=>select([row]),invalid);
    }
  }
  const boundary=authority();boundary.pin.packetId='x'.repeat(128);assert.equal(select([boundary]).packetId,boundary.pin.packetId);
});

test('selector kind and platform labels refuse invalid runtime arguments',()=>{
  for(const kind of ['schema19-executable-pin-1','schema18-executable-packet-1','',null])assert.throws(()=>select([authority()],'darwin','arm64',kind),invalid);
  for(const value of ['', 'Darwin', '../linux', 'linux/x64', 'x'.repeat(33),null]){
    assert.throws(()=>select([authority()],value,'arm64'),invalid);assert.throws(()=>select([authority()],'darwin',value),invalid);
    const row=authority();row.os=value;row.pin.platform.os=value;assert.throws(()=>select([row]),invalid);
  }
});

test('invalid trailing row refuses before a found selection can escape',()=>{
  const bad=authority(kinds[1],'linux','x64');bad.pin.platform.identity='not-a-digest';
  assert.throws(()=>select([authority(),bad]),invalid);
  assert.throws(()=>select([{os:'darwin',arch:'arm64',pin:null},bad]),invalid);
});

test('registry admission accepts32 unique rows and refuses33',()=>{
  const rows=Array.from({length:32},(_,i)=>authority(kinds[1],'testos'+i,'x64'));
  assert.equal(select(rows,'testos31','x64').packetId,rows[31].pin.packetId);
  rows.push(authority(kinds[1],'testos32','x64'));assert.throws(()=>select(rows,'testos0','x64'),invalid);
});

const productRegistries=[
  ['schema17',kinds[0],REQUEST_FAMILY_SCHEMA17_AUTHORITIES,REQUEST_FAMILY_SCHEMA17_EXECUTABLE,requestFamilyExecutablePin],
  ['schema18',kinds[1],COMPOSITION_TEXT_SCHEMA18_AUTHORITIES,COMPOSITION_TEXT_SCHEMA18_EXECUTABLE,compositionTextExecutablePin],
];
for(const [name,kind,rows,literal,wrapper] of productRegistries){
  test(name+' product registry preserves only its actually declared Darwin authority',()=>{
    assert.deepEqual(rows.map(({os,arch})=>({os,arch})),[{os:'darwin',arch:'arm64'}]);
    assert(Object.isFrozen(rows));assert(Object.isFrozen(rows[0]));assert.deepEqual(rows[0].pin,literal);
    if(literal!==null){assert.notEqual(rows[0].pin,literal);assert.notEqual(rows[0].pin.platform,literal.platform);assertFrozenPin(rows[0].pin);}
    assert.throws(()=>select(rows,'linux','x64',kind),missing);assert.throws(()=>select(rows,'linux','arm64',kind),missing);
  });
  test(name+' wrapper agrees with the actual host row without fabricating an installed packet',()=>{
    const row=rows.find(value=>value.os===process.platform&&value.arch===process.arch);
    if(!row){assert.throws(wrapper,missing);return;}
    if(row.pin===null){assert.throws(wrapper,unissued);return;}
    const pin=wrapper();assert.deepEqual(pin,select(rows,process.platform,process.arch,kind));assertFrozenPin(pin);assert.notEqual(pin,row.pin);
  });
}

test('fresh0 and current19 readiness do not inspect an old executable root',()=>{
  let inspected=0;const root=new Proxy({}, {get(){inspected++;throw Error('Root must not be inspected');}});
  for(const version of [0,19]){
    assert.doesNotThrow(()=>assertRequestFamilyMigrationReady(version,root));
    assert.doesNotThrow(()=>assertCompositionTextMigrationReady(version,root));
  }
  assert.equal(inspected,0);
});

test('future storage refuses before database access instead of choosing a rollback authority',()=>{
  let reads=0;const db=new Proxy({}, {get(){reads++;throw Error('Future version must refuse before reading');}});
  assert.throws(()=>assertEditorStorageCompatibility(db,'unused-root',20),refusal('USE_MATCHING_EXECUTABLE_OR_VERIFIED_BACKUP'));
  assert.equal(reads,0);
});

test('installed-packet verification rejects a synthetic foreign pin before any root access',()=>{
  let inspected=0;const root=new Proxy({}, {get(){inspected++;throw Error('Foreign pin must refuse first');}});
  const foreignOs=process.platform==='darwin'?'linux':'darwin',pin=syntheticPin(kinds[1],foreignOs,'arm64');
  assert.throws(()=>compositionTextInstalledPacket(root,pin),{code:'UNSUPPORTED_STORAGE'});
  assert.equal(inspected,0);
});

const maintenanceKind='schema16-maintenance-executable-pin-1';
const maintenancePin=(arch='x64')=>({...syntheticPin(maintenanceKind,'linux',arch),storageVersion:16,
  compatibilityContract:'schema16-linux-raster-maintenance-1',historicalBase:'5650326b623d4aa2080772307708aa9f1854aa52',
  maintenancePatchHash:'sha256:77f7fddc26a02bc9c4e613de72f47d213fa58bee9846ff84717cdece58214958',sourceIdentity:digest('c')});

test('schema16 maintenance selection binds its complete distinct source contract',()=>{
  const rows=freezeRollbackAuthorities(['x64','arm64'].map(arch=>({os:'linux',arch,pin:maintenancePin(arch)})));
  for(const row of rows){
    const selected=select(rows,'linux',row.arch,maintenanceKind);assert.deepEqual(selected,row.pin);assertFrozenPin(selected);
    assert.notEqual(selected,row.pin);assert.notEqual(selected.platform,row.pin.platform);
  }
  assert.throws(()=>select(rows,'darwin','arm64',maintenanceKind),missing);
  assert.throws(()=>select(rows,'linux','x64',kinds[0]),invalid);
  const mismatches={storageVersion:17,compatibilityContract:'schema16-release',historicalBase:'0'.repeat(40),
    maintenancePatchHash:digest('d'),sourceIdentity:'not-a-digest'};
  for(const [field,value] of Object.entries(mismatches)){
    const bad=structuredClone(rows);bad[1].pin[field]=value;
    assert.throws(()=>select(bad,'linux','x64',maintenanceKind),invalid,field);
  }
  for(const field of Object.keys(mismatches)){
    const bad=structuredClone(rows);delete bad[0].pin[field];assert.throws(()=>select(bad,'linux','x64',maintenanceKind),invalid,field);
  }
  const extra=structuredClone(rows);extra[0].pin.gitCommit='5650326b623d4aa2080772307708aa9f1854aa52';
  assert.throws(()=>select(extra,'linux','x64',maintenanceKind),invalid);
  for(const [os,arch] of [['darwin','arm64'],['linux','riscv64']]){
    const pin=maintenancePin(arch);pin.platform.os=os;
    assert.throws(()=>select([{os,arch,pin}],os,arch,maintenanceKind),invalid);
  }
});

test('unissued schema16 maintenance registry supplies no fallback or implied historical authority',()=>{
  assert.deepEqual(SCHEMA16_MAINTENANCE_AUTHORITIES,[]);assert(Object.isFrozen(SCHEMA16_MAINTENANCE_AUTHORITIES));
  assert.throws(schema16MaintenanceExecutablePin,missing);
  for(const arch of ['x64','arm64'])assert.throws(()=>select(SCHEMA16_MAINTENANCE_AUTHORITIES,'linux',arch,maintenanceKind),missing);
});
