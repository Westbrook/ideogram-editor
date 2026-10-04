// Diagnostic-only projection of the pinned raw Gecko profile format36.
// No raw JSON object tree, location strings, marker payloads or process IDs escape.
// Native capacity is measured in eight-byte entries; these parser limits do not
// bound native profiler buffers, JS heap overhead, process count or total RSS.
// A projected sample is a positive category observation, never a duration or a
// complete-coverage claim. JS stays unattributed; idle does not prove waiting.
export const PROFILE_LIMITS=Object.freeze({rawBytes:16777216,chunkBytes:16384,bufferedBytes:65536,depth:48,stringBytes:16384,numberBytes:32,values:1000000,processes:8,threads:64,samples:250000,frames:100000,stacks:200000,strings:100000,markers:100000,pages:256,numericBytes:16777216,selectedSamples:10000,stackDepth:128,projectedFrames:65536,outputBytes:262144});
export const PROFILE_CATEGORY_CODES=Object.freeze(['IDLE_CATEGORY_SAMPLE','OTHER_CATEGORY_SAMPLE','LAYOUT_SAMPLE','JS_SAMPLE','GC_SAMPLE','UNCLASSIFIED_SAMPLE']);
const CATEGORIES=[["Idle",["Other"]],["Other",["Other","Preference Read","Profiling"]],["Test",["Test"]],["Layout",["Other","Frame construction","Reflow","CSS parsing","Selector query","Style computation","Layout cleanup","Printing"]],["JavaScript",["Other","Parsing","JIT Compile (baseline)","JIT Compile (ion)","Interpreter","JIT (baseline-interpreter)","JIT (baseline)","JIT (ion)","Builtin API","Wasm (ion)","Wasm (baseline)","Wasm (other)"]],["GC / CC",["Other","Minor GC","Major GC (Other)","Major GC (Mark)","Major GC (Sweep)","Major GC (Compact)","Unmark Gray","Barrier","CC (Free Snow White)","CC (Build Graph)","CC (Scan Roots)","CC (Collect White)","CC (Finalize)"]],["Network",["Other"]],["Graphics",["Other","DisplayList building","DisplayList merging","Layer building","Tile allocation","WebRender display list","Rasterization","Flushing async paints","Image decoding","WebGPU","VSync triggered animation"]],["DOM",["Other"]],["Android",["Other"]],["AndroidX",["Other"]],["Java",["Other"]],["Mozilla",["Other"]],["Kotlin",["Other"]],["Blocked",["Other"]],["Mailnews",["Other"]],["IPC",["Other"]],["Media",["Other","Cubeb","Playback","Real-time rendering"]],["Accessibility",["Other"]],["Profiler",["Other"]],["Timer",["Other"]],["Remote-Protocol",["Other"]],["Sandbox",["Other"]],["Telemetry",["Other"]],["ML",["Other","Inference","Setup"]],["Logs",["Other"]]];
const SCHEMAS=Object.freeze({stackTable:['prefix','frame'],frameTable:['location','relevantForJS','innerWindowID','implementation','line','column','category','subcategory'],samples:['stack','time','eventDelay','argumentValues','threadCPUDelta'],markers:['name','startTime','endTime','phase','category','data']});
const CONTEXT=['p4WallMs','realmTimeOriginMs','f5WallMs','f5MonotonicMs','f6WallMs','f6MonotonicMs','queueReadEntryMonotonicMs','queueReadCallbackMonotonicMs'];
const REASONS=new Set(['NONE','CONTEXT_UNAVAILABLE','CONTEXT_INVALID','INPUT_FAILURE','RAW_LIMIT','CHUNK_LIMIT','DEPTH_LIMIT','TOKEN_LIMIT','VALUE_LIMIT','ROW_LIMIT','MEMORY_LIMIT','OUTPUT_LIMIT','JSON_INVALID','SCHEMA_INVALID','REFERENCE_INVALID','CONFIG_INVALID','VERSION_UNSUPPORTED','TARGET_UNAVAILABLE','TARGET_AMBIGUOUS','CLOCK_UNKNOWN','COVERAGE_UNKNOWN']);
const KEYS=new Set(['meta','processes','threads','pages','version','startTime','profilingStartTime','contentEarliestTime','profilingEndTime','shutdownTime','categories','name','subcategories','configuration','capacity','interval','duration','activeTabID','features','stackwalk','js','nomarkerstacks','processType','samples','markers','stackTable','frameTable','schema','data','stringTable','prefix','frame','location','relevantForJS','innerWindowID','implementation','line','column','category','subcategory','stack','time','eventDelay','argumentValues','threadCPUDelta','endTime','phase','type','entryType']);
const failures=new WeakMap();
class Refusal extends Error{constructor(code){super(code);failures.set(this,code);}}
const refuse=code=>{throw new Refusal(code);};
const finite=n=>typeof n==='number'&&Number.isFinite(n);
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const optional=n=>Number.isNaN(n);
const numeric=n=>n===null?NaN:finite(n)?n:refuse('SCHEMA_INVALID');
const exactKeys=(o,keys)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).length===keys.length&&keys.every(k=>Object.hasOwn(o,k));

// Fixed-width numeric pages avoid retaining rows of arbitrary source objects.
class Table{
 constructor(width,state,counter,limit){this.width=width;this.state=state;this.counter=counter;this.limit=limit;this.pages=[];this.length=0;}
 push(row){
  if(++this.state.counts[this.counter]>this.limit)refuse('ROW_LIMIT');
  if(this.length%128===0){const bytes=128*this.width*8;this.state.reserve(bytes);const page=new Float64Array(128*this.width);page.fill(NaN);this.pages.push(page);}
  const page=this.pages[this.length>>7],offset=(this.length%128)*this.width;
  for(let i=0;i<this.width;i++)page[offset+i]=row[i]??NaN;
  this.length++;
 }
 at(row,col){return this.pages[row>>7][(row%128)*this.width+col];}
}

// Incremental tokenization: only one bounded token and one bounded decoded chunk.
class Lexer{
 constructor(token){this.token=token;this.mode='idle';this.text='';this.bytes=0;this.escape=false;this.hex=null;}
 append(c){this.text+=c;}
 endAtom(){const raw=this.text;this.text='';this.mode='idle';if(raw==='true')this.token('value',true);else if(raw==='false')this.token('value',false);else if(raw==='null')this.token('value',null);else {if(!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(raw))refuse('JSON_INVALID');const n=Number(raw);if(!finite(n))refuse('JSON_INVALID');this.token('value',n);}}
 feed(text){
  for(const c of text){
   if(this.mode==='atom'){
    if(/[\s{}\[\],:]/.test(c)){this.endAtom();}else {if(++this.bytes>PROFILE_LIMITS.numberBytes)refuse('TOKEN_LIMIT');this.append(c);continue;}
   }
   if(this.mode==='string'){
    this.bytes+=c.codePointAt(0)>65535?4:c.charCodeAt(0)>2047?3:c.charCodeAt(0)>127?2:1;
    if(this.bytes>PROFILE_LIMITS.stringBytes)refuse('TOKEN_LIMIT');
    if(this.hex!==null){if(!/^[0-9a-fA-F]$/.test(c))refuse('JSON_INVALID');this.hex+=c;if(this.hex.length===4){this.append(String.fromCharCode(parseInt(this.hex,16)));this.hex=null;}continue;}
    if(this.escape){this.escape=false;if(c==='u'){this.hex='';continue;}const escapes={'"':'"','\\':'\\','/':'/','b':'\b','f':'\f','n':'\n','r':'\r','t':'\t'};if(!Object.hasOwn(escapes,c))refuse('JSON_INVALID');this.append(escapes[c]);continue;}
    if(c==='\\'){this.escape=true;continue;}
    if(c==='"'){const value=this.text;this.text='';this.mode='idle';this.token('string',value);continue;}
    if(c.charCodeAt(0)<32)refuse('JSON_INVALID');this.append(c);continue;
   }
   if(c===' '||c==='\t'||c==='\r'||c==='\n')continue;
   if(c==='"'){this.mode='string';this.text='';this.bytes=0;continue;}
   if('{}[],:'.includes(c)){this.token(c);continue;}
   if(/[-0-9tfn]/.test(c)){this.mode='atom';this.text=c;this.bytes=1;continue;}
   refuse('JSON_INVALID');
  }
 }
 finish(){if(this.mode==='atom')this.endAtom();if(this.mode!=='idle')refuse('JSON_INVALID');}
}

class Parser{
 constructor(sink){this.sink=sink;this.stack=[];this.root=false;this.values=0;}
 token(type,value){
  let top=this.stack.at(-1);
  if(type==='}'||type===']'){
   if(!top||top.kind!==(type==='}'?'object':'array')||!['first','after'].includes(top.state))refuse('JSON_INVALID');
   this.sink.close(top.role,top.index);this.stack.pop();return;
  }
  if(top?.kind==='object'&&(top.state==='first'||top.state==='key')){
   if(type!=='string')refuse('JSON_INVALID');const key=KEYS.has(value)?value:'';
   if(key&&top.seen.has(key))refuse('SCHEMA_INVALID');if(key)top.seen.add(key);
   top.key=key;top.state='colon';return;
  }
  if(top?.state==='colon'){if(type!==':')refuse('JSON_INVALID');top.state='value';return;}
  if(top?.state==='after'){if(type!==',')refuse('JSON_INVALID');top.state=top.kind==='object'?'key':'value';return;}
  if(top&&top.state!=='value'&&!(top.kind==='array'&&top.state==='first'))refuse('JSON_INVALID');
  if(!top&&this.root)refuse('JSON_INVALID');
  if(++this.values>PROFILE_LIMITS.values)refuse('VALUE_LIMIT');
  const key=top?.kind==='object'?top.key:top?top.index++:null;
  if(top)top.state='after';else this.root=true;
  if(type==='{'||type==='['){
   if(this.stack.length>=PROFILE_LIMITS.depth)refuse('DEPTH_LIMIT');const kind=type==='{'?'object':'array';
   const role=this.sink.open(top?.role,key,kind);this.stack.push({kind,role,state:'first',index:0,key:'',seen:new Set()});return;
  }
  if(type!=='string'&&type!=='value')refuse('JSON_INVALID');this.sink.value(top?.role,key,value,type==='string');
 }
 finish(){if(!this.root||this.stack.length)refuse('JSON_INVALID');}
}

class Profile{
 constructor(){this.processes=[];this.counts={threads:0,samples:0,frames:0,stacks:0,strings:0,markers:0,pages:0};this.numericBytes=0;}
 reserve(bytes){if(this.numericBytes+bytes>PROFILE_LIMITS.numericBytes)refuse('MEMORY_LIMIT');this.numericBytes+=bytes;}
 process(){if(this.processes.length>=PROFILE_LIMITS.processes)refuse('ROW_LIMIT');const p={meta:{},threads:[],categories:0};this.processes.push(p);return {type:'process',p};}
 thread(p){if(++this.counts.threads>PROFILE_LIMITS.threads)refuse('ROW_LIMIT');const t={p,isMain:false,isContent:false,tables:{},marks:[],stringTable:new Table(1,this,'strings',PROFILE_LIMITS.strings)};p.threads.push(t);return {type:'thread',p,t};}
 open(parent,key,kind){
  if(!parent){if(kind!=='object')refuse('SCHEMA_INVALID');return this.process();}
  const {type,p,t}=parent;
  if(['features','filters','schema','strings','subcategories'].includes(type))refuse('SCHEMA_INVALID');
  if(type==='configuration'&&(key==='duration'||key==='activeTabID'))refuse('CONFIG_INVALID');
  const expect=(wanted,role)=>{if(kind!==wanted)refuse('SCHEMA_INVALID');return role;};
  if(type==='processes')return expect('object',this.process());
  if(type==='threads')return expect('object',this.thread(p));
  if(type==='categories')return expect('object',{type:'category',p,index:key,name:false,subcategories:false});
  if(type==='pages'){if(++this.counts.pages>PROFILE_LIMITS.pages)refuse('ROW_LIMIT');return expect('object',{type:'skip'});}
  if(type==='process'){
   if(key==='meta')return expect('object',{type:'meta',p});
   if(key==='threads')return expect('array',{type:'threads',p});
   if(key==='processes')return expect('array',{type:'processes'});
   if(key==='pages')return expect('array',{type:'pages'});
  }
  if(type==='meta'){
   if(key==='categories')return expect('array',{type:'categories',p});
   if(key==='configuration')return expect('object',{type:'configuration',p,c:p.configuration={features:0,threads:0}});
  }
  if(type==='configuration'&&(key==='features'||key==='threads'))return expect('array',{type:key==='features'?'features':'filters',c:parent.c});
  if(type==='category'&&key==='subcategories'){parent.subcategories=true;return expect('array',{type:'subcategories',category:parent});}
  if(type==='thread'){
   if(Object.hasOwn(SCHEMAS,key)){const table={name:key,schema:0,hasData:false,rows:0};t.tables[key]=table;return expect('object',{type:'table',p,t,table});}
   if(key==='stringTable'){t.hasStrings=true;return expect('array',{type:'strings',t});}
  }
  if(type==='table'){
   if(key==='schema')return expect('object',{type:'schema',table:parent.table});
   if(key==='data'){parent.table.hasData=true;return expect('array',{type:'rows',t,table:parent.table});}
  }
  if(type==='rows')return expect('array',{type:'row',t,table:parent.table,row:new Array(SCHEMAS[parent.table.name].length).fill(NaN),mark:{type:false,name:0,entry:false,window:NaN},fields:0});
  if(type==='row'){
   parent.fields=Math.max(parent.fields,key+1);
   if(parent.table.name==='markers'&&key===5)return expect('object',{type:'mark',mark:parent.mark});
   if(parent.table.name==='samples'&&key===3)return {type:'skip'};
   refuse('SCHEMA_INVALID');
  }
  if(type==='skip')return {type:'skip'};
  // Unknown metadata may contain private strings/objects, but is never retained.
  if(key&&['meta','configuration','categories','threads','schema','data','stringTable'].includes(key))refuse('SCHEMA_INVALID');
  return {type:'skip'};
 }
 value(role,key,value,string){
  if(!role)refuse('SCHEMA_INVALID');const {type,p,t}=role;
  if(type==='meta'){
   if(['version','startTime','profilingStartTime','contentEarliestTime','profilingEndTime','shutdownTime'].includes(key))p.meta[key]=numeric(value);
   else if(['categories','configuration'].includes(key))refuse('SCHEMA_INVALID');return;
  }
  if(type==='configuration'){
   if(key==='duration')refuse('CONFIG_INVALID');
   if(['capacity','interval','activeTabID'].includes(key))role.c[key]=numeric(value);else if(['threads','features'].includes(key))refuse('SCHEMA_INVALID');return;
  }
  if(type==='features'){const bits={js:1,stackwalk:2,nomarkerstacks:4},bit=string&&Object.hasOwn(bits,value)?bits[value]:0;if(!bit||role.c.features&bit)refuse('CONFIG_INVALID');role.c.features|=bit;return;}
  if(type==='filters'){if(!string||value!=='GeckoMain'||++role.c.threads!==1)refuse('CONFIG_INVALID');return;}
  if(type==='category'){if(key==='name'){if(!string||value!==CATEGORIES[role.index]?.[0])refuse('SCHEMA_INVALID');role.name=true;}return;}
  if(type==='subcategories'){if(!string||value!==CATEGORIES[role.category.index]?.[1][key])refuse('SCHEMA_INVALID');return;}
  if(type==='thread'){if(key==='name')t.isMain=string&&value==='GeckoMain';else if(key==='processType')t.isContent=string&&value==='tab';else if(Object.hasOwn(SCHEMAS,key)||key==='stringTable')refuse('SCHEMA_INVALID');return;}
  if(type==='schema'){const columns=SCHEMAS[role.table.name],index=columns.indexOf(key);if(index<0||value!==index)refuse('SCHEMA_INVALID');role.table.schema|=1<<index;return;}
  if(type==='strings'){if(!string)refuse('SCHEMA_INVALID');t.stringTable.push([value==='UserTiming'?1:0]);return;}
  if(type==='row'){
   const name=role.table.name;if(key>=role.row.length)refuse('SCHEMA_INVALID');role.fields=Math.max(role.fields,key+1);
   if(name==='samples'&&key===3)return;
   if(name==='markers'&&key===5){if(value!==null)refuse('SCHEMA_INVALID');return;}
   if(name==='frameTable'&&key===1){if(value!==null&&value!==true&&value!==false)refuse('SCHEMA_INVALID');role.row[key]=value===null?NaN:Number(value);return;}
   role.row[key]=numeric(value);return;
  }
  if(type==='mark'){
   if(key==='type')role.mark.type=string&&value==='UserTiming';
   else if(key==='name')role.mark.name=string&&value==='p25.F5'?5:string&&value==='p25.F6'?6:0;
   else if(key==='entryType')role.mark.entry=string&&value==='mark';
   else if(key==='innerWindowID')role.mark.window=numeric(value);
   return;
  }
  if(type==='process'){if(['meta','threads','processes','pages'].includes(key))refuse('SCHEMA_INVALID');return;}
  if(['table','rows','categories','threads','processes','pages'].includes(type))refuse('SCHEMA_INVALID');
 }
 close(role,length){
  const {type,p,t}=role;
  if(type==='category'){if(!role.name||!role.subcategories)refuse('SCHEMA_INVALID');p.categories++;}
  if(type==='subcategories'&&length!==CATEGORIES[role.category.index]?.[1].length)refuse('SCHEMA_INVALID');
  if(type==='categories'&&length!==CATEGORIES.length)refuse('SCHEMA_INVALID');
  if(type==='row'){
   const {name}=role.table;const r=role.row;role.table.rows++;
   if(name==='markers'){
    // The native writer omits cell5 when its payload tag is zero.
    if(role.fields<5||role.fields>6||!integer(r[0])||!finite(r[1])||!finite(r[2])||!integer(r[3])||r[3]>3||!integer(r[4])||r[4]>=CATEGORIES.length)refuse('SCHEMA_INVALID');
    (t.markerNames??=new Table(1,this,'markers',PROFILE_LIMITS.markers)).push([r[0]]);
    if(role.mark.type&&role.mark.name&&role.mark.entry){if(r[3]!==0||r[2]!==0||r[4]!==8||!integer(role.mark.window)||role.mark.window===0)refuse('SCHEMA_INVALID');if(t.marks.length>=4)t.markOverflow=true;else t.marks.push({which:role.mark.name,time:r[1],window:role.mark.window,nameIndex:r[0]});}
    return;
   }
   if(name==='stackTable'){if(role.fields!==2)refuse('SCHEMA_INVALID');(t.stacks??=new Table(2,this,'stacks',PROFILE_LIMITS.stacks)).push(r);}
   else if(name==='frameTable'){if(role.fields<1)refuse('SCHEMA_INVALID');(t.frames??=new Table(8,this,'frames',PROFILE_LIMITS.frames)).push(r);}
   else if(name==='samples'){if(role.fields<2)refuse('SCHEMA_INVALID');(t.samples??=new Table(2,this,'samples',PROFILE_LIMITS.samples)).push(r);}
  }
 }
 validate(){
  for(const p of this.processes){
   if(p.meta.version!==36)refuse('VERSION_UNSUPPORTED');
   if(!finite(p.meta.startTime)||p.categories!==26)refuse('SCHEMA_INVALID');
   // Exact requested feature set, independent of native serialization order.
   const c=p.configuration;if(!c||c.capacity!==16777216||c.interval!==1||c.features!==7||c.threads!==1||c.activeTabID!==0)refuse('CONFIG_INVALID');
   for(const t of p.threads){
    for(const [name,columns]of Object.entries(SCHEMAS)){const table=t.tables[name];if(!table||!table.hasData||table.schema!==(1<<columns.length)-1)refuse('SCHEMA_INVALID');}
    if(!t.hasStrings)refuse('SCHEMA_INVALID');
    t.stacks??=new Table(2,this,'stacks',PROFILE_LIMITS.stacks);t.frames??=new Table(8,this,'frames',PROFILE_LIMITS.frames);t.samples??=new Table(2,this,'samples',PROFILE_LIMITS.samples);
    const index=(v,n,nullable=false)=>{if(nullable&&optional(v))return;if(!integer(v)||v>=n)refuse('REFERENCE_INVALID');};
    for(let i=0;i<t.frames.length;i++){
     index(t.frames.at(i,0),t.stringTable.length);index(t.frames.at(i,3),t.stringTable.length,true);
     for(const k of [2,4,5]){const v=t.frames.at(i,k);if(!optional(v)&&!integer(v))refuse('REFERENCE_INVALID');}
     const cat=t.frames.at(i,6),sub=t.frames.at(i,7);index(cat,26,true);if(!optional(sub)){if(optional(cat))refuse('REFERENCE_INVALID');index(sub,CATEGORIES[cat][1].length);}
    }
    for(let i=0;i<t.stacks.length;i++){index(t.stacks.at(i,0),t.stacks.length,true);index(t.stacks.at(i,1),t.frames.length);}
    this.reserve(t.stacks.length);const visited=new Uint8Array(t.stacks.length);
    for(let i=0;i<t.stacks.length;i++){let n=i;while(!optional(n)&&visited[n]===0){visited[n]=1;n=t.stacks.at(n,0);}if(!optional(n)&&visited[n]===1)refuse('REFERENCE_INVALID');n=i;while(!optional(n)&&visited[n]===1){visited[n]=2;n=t.stacks.at(n,0);}}
    let prior=-Infinity;for(let i=0;i<t.samples.length;i++){index(t.samples.at(i,0),t.stacks.length,true);const time=t.samples.at(i,1);if(!finite(time)||time<0||time<prior)refuse('REFERENCE_INVALID');prior=time;}
    for(let i=0;i<(t.markerNames?.length??0);i++)index(t.markerNames.at(i,0),t.stringTable.length);
    for(const m of t.marks){index(m.nameIndex,t.stringTable.length);if(t.stringTable.at(m.nameIndex,0)!==1)refuse('REFERENCE_INVALID');}
   }
  }
 }
}

function base(status,reason,rawBytes,numericBytesPeak){return {schema:1,status,reason,rawBytes,numericBytesPeak,sampleCount:0,alignment:null,samples:[],categoryCounts:[0,0,0,0,0,0],coverage:'NOT_CERTIFIED',attribution:'UNATTRIBUTED',timingQualified:false};}
function contextValid(c){
 if(!exactKeys(c,CONTEXT)||!CONTEXT.every(k=>finite(c[k])&&c[k]>=0&&c[k]<=Number.MAX_SAFE_INTEGER))return false;
 if(c.f5WallMs>=c.f6WallMs||c.f5MonotonicMs>=c.f6MonotonicMs||c.f5WallMs>c.p4WallMs||c.p4WallMs>c.f6WallMs||c.queueReadEntryMonotonicMs>c.queueReadCallbackMonotonicMs||c.queueReadEntryMonotonicMs<c.f5MonotonicMs||c.queueReadCallbackMonotonicMs>c.f6MonotonicMs)return false;
 return Math.abs(c.realmTimeOriginMs+c.f5MonotonicMs-c.f5WallMs)<=5&&Math.abs(c.realmTimeOriginMs+c.f6MonotonicMs-c.f6WallMs)<=5;
}
function project(profile,c,rawBytes){
 const unknown=reason=>base('unknown',reason,rawBytes,profile.numericBytes);
 if(c===null||c===undefined)return unknown('CONTEXT_UNAVAILABLE');if(!contextValid(c))return base('refused','CONTEXT_INVALID',rawBytes,profile.numericBytes);
 const targets=[];
 for(const p of profile.processes)for(const t of p.threads)if(t.isMain&&t.isContent&&t.marks.length){
  const f5=t.marks.filter(m=>m.which===5),f6=t.marks.filter(m=>m.which===6);
  if(t.markOverflow||f5.length!==1||f6.length!==1)return unknown('TARGET_AMBIGUOUS');
  if(f5[0].window!==f6[0].window)return unknown('TARGET_AMBIGUOUS');targets.push({p,t,f5:f5[0],f6:f6[0]});
 }
 if(!targets.length)return unknown('TARGET_UNAVAILABLE');if(targets.length!==1)return unknown('TARGET_AMBIGUOUS');
 const {p,t,f5,f6}=targets[0],origin=p.meta.startTime;
 const r5=origin+f5.time-c.f5WallMs,r6=origin+f6.time-c.f6WallMs,delta=(f6.time-f5.time)-(c.f6MonotonicMs-c.f5MonotonicMs);
 if(f5.time>=f6.time||Math.abs(r5)>5||Math.abs(r6)>5||Math.abs(delta)>5)return unknown('CLOCK_UNKNOWN');
 const start=c.realmTimeOriginMs+c.queueReadEntryMonotonicMs-origin,end=c.realmTimeOriginMs+c.queueReadCallbackMonotonicMs-origin;
 const meta=p.meta;
 if(!['profilingStartTime','contentEarliestTime','profilingEndTime','shutdownTime'].every(k=>finite(meta[k]))||Math.max(meta.profilingStartTime,meta.contentEarliestTime)>Math.min(start,f5.time)||Math.min(meta.profilingEndTime,meta.shutdownTime)<Math.max(end,f6.time)||!t.samples.length)return unknown('COVERAGE_UNKNOWN');
 if(t.samples.at(0,1)>start||t.samples.at(t.samples.length-1,1)<end)return unknown('COVERAGE_UNKNOWN');
 const result=base('projected','NONE',rawBytes,profile.numericBytes);result.alignment={f5ResidualMs:r5,f6ResidualMs:r6,deltaResidualMs:delta,wallClockUnitMs:1,clockUncertaintyMs:null};let frames=0,outputBytes=4096,criticalSamples=0;
 for(let i=0;i<t.samples.length;i++){
  const time=t.samples.at(i,1),relative=origin+time-c.p4WallMs;if(relative< -500||relative>1000)continue;
  if(time>=start&&time<=end)criticalSamples++;
  if(result.samples.length>=PROFILE_LIMITS.selectedSamples)refuse('OUTPUT_LIMIT');
  let stack=t.samples.at(i,0),codes=[];
  while(!optional(stack)){
   if(codes.length>=PROFILE_LIMITS.stackDepth||++frames>PROFILE_LIMITS.projectedFrames)refuse('OUTPUT_LIMIT');
   const frame=t.stacks.at(stack,1),category=t.frames.at(frame,6),window=t.frames.at(frame,2);
   if(!optional(window)&&window!==0&&window!==f5.window)return unknown('TARGET_AMBIGUOUS');
   codes.push(optional(category)?5:category===0?0:category===3?2:category===4?3:category===5?4:1);stack=t.stacks.at(stack,0);
  }
  codes.reverse();const sample=[relative,codes];outputBytes+=JSON.stringify(sample).length+1;if(outputBytes>PROFILE_LIMITS.outputBytes)refuse('OUTPUT_LIMIT');
  result.samples.push(sample);let bucket=5;for(let j=codes.length-1;j>=0;j--)if(codes[j]!==5){bucket=codes[j];break;}result.categoryCounts[bucket]++;
 }
 result.sampleCount=result.samples.length;if(!result.sampleCount||!criticalSamples)return unknown('COVERAGE_UNKNOWN');return result;
}

/** Context may arrive after browser shutdown begins; parsing never waits for it.
 * The FIFO owner must resolve it to null on teardown/failure and own iterator
 * cancellation. This module neither opens descriptors nor changes deadlines. */
export async function projectFirefoxProfile(chunks,context){
 const contextResult=Promise.resolve(context).then(value=>({value}),()=>({value:null}));
 let rawBytes=0;const profile=new Profile(),parser=new Parser(profile),lexer=new Lexer((...token)=>parser.token(...token)),decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
 try{
  for await(const chunk of chunks){
   if(!(chunk instanceof Uint8Array))refuse('INPUT_FAILURE');
   if(chunk.byteLength>PROFILE_LIMITS.chunkBytes)refuse('CHUNK_LIMIT');
   if(rawBytes+chunk.byteLength>PROFILE_LIMITS.rawBytes)refuse('RAW_LIMIT');rawBytes+=chunk.byteLength;
   let text;try{text=decoder.decode(chunk,{stream:true});}catch{refuse('JSON_INVALID');}lexer.feed(text);
  }
  let tail;try{tail=decoder.decode();}catch{refuse('JSON_INVALID');}lexer.feed(tail);lexer.finish();parser.finish();profile.validate();
  return project(profile,(await contextResult).value,rawBytes);
 }catch(error){return base('refused',failures.get(error)??'INPUT_FAILURE',rawBytes,profile.numericBytes);}
}

/** Caller-side shape/size validation before crossing the owned IPC boundary. */
export function isFirefoxProfileProjection(value){
 try{
  if(!exactKeys(value,['schema','status','reason','rawBytes','numericBytesPeak','sampleCount','alignment','samples','categoryCounts','coverage','attribution','timingQualified']))return false;
  if(value.schema!==1||!['projected','unknown','refused'].includes(value.status)||!REASONS.has(value.reason)||value.coverage!=='NOT_CERTIFIED'||value.attribution!=='UNATTRIBUTED'||value.timingQualified!==false)return false;
  if(!integer(value.rawBytes)||value.rawBytes>PROFILE_LIMITS.rawBytes||!integer(value.numericBytesPeak)||value.numericBytesPeak>PROFILE_LIMITS.numericBytes||!integer(value.sampleCount)||value.sampleCount>PROFILE_LIMITS.selectedSamples)return false;
  if(!Array.isArray(value.samples)||value.samples.length!==value.sampleCount||!Array.isArray(value.categoryCounts)||value.categoryCounts.length!==6||!Array.from(value.categoryCounts).every(integer))return false;
  if(value.status==='projected'){if(!value.sampleCount||value.reason!=='NONE'||!exactKeys(value.alignment,['f5ResidualMs','f6ResidualMs','deltaResidualMs','wallClockUnitMs','clockUncertaintyMs'])||value.alignment.wallClockUnitMs!==1||value.alignment.clockUncertaintyMs!==null||!['f5ResidualMs','f6ResidualMs','deltaResidualMs'].every(k=>finite(value.alignment[k])&&Math.abs(value.alignment[k])<=5))return false;}
  else if(value.reason==='NONE'||value.alignment!==null||value.sampleCount!==0)return false;
  let frames=0,previous=-Infinity;const counts=[0,0,0,0,0,0];
  for(const row of value.samples){if(!Array.isArray(row)||row.length!==2||!finite(row[0])||row[0]<-500||row[0]>1000||row[0]<previous||!Array.isArray(row[1])||row[1].length>PROFILE_LIMITS.stackDepth||!Array.from(row[1]).every(c=>integer(c)&&c<6))return false;previous=row[0];frames+=row[1].length;let c=5;for(let i=row[1].length-1;i>=0;i--)if(row[1][i]!==5){c=row[1][i];break;}counts[c]++;}
  return frames<=PROFILE_LIMITS.projectedFrames&&counts.every((v,i)=>v===value.categoryCounts[i])&&JSON.stringify(value).length<=PROFILE_LIMITS.outputBytes;
 }catch{return false;}
}
