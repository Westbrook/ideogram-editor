import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonical} from '../../dist/local/src/protocol/json.js';
import {footprint} from '../../dist/local/src/raster/core.js';
import {contributionReferences,validateContributionClosure,assertContributionRecomputation,remapContributionClosure} from '../../dist/local/server/portable/contributions.js';

const hash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const ref=(bytes,mediaType)=>({hash:hash(bytes),byteLength:String(bytes.length),mediaType});
const pipeline='cp1-f64-triangle-area-v1/sha256:'+'1'.repeat(64),transform=[1,0,0,1,0,0];
function fixture(){
 const objects=new Map(),assets=new Map();
 const write=value=>{const bytes=Buffer.from(canonical(value)),reference=ref(bytes,'application/json');objects.set(reference.hash,bytes);return reference;};
 const read=async reference=>{const bytes=objects.get(reference.hash);assert.ok(bytes,'retained object '+reference.hash);assert.deepEqual(ref(bytes,reference.mediaType),reference);return JSON.parse(bytes);};
 const layers=['source_a','source_b'].map(assetId=>({assetId,transform,opacity:1,mask:null}));
 const base=pixels=>({schemaVersion:1,pipeline,width:1,height:1,format:'straight-srgb-rgba8',layout:'row-major-tile-views-v1',tileSize:512,pixels,tiles:[{x:0,y:0,width:1,height:1,hash:pixels.hash}]});
 const children=layers.map((layer,index)=>{
  const source=write({native:layer.assetId}),bytes=Buffer.from(index?[200,180,90,128]:[27,45,90,255]),pixels=ref(bytes,'application/x-ideogram-rgba8');objects.set(pixels.hash,bytes);
  assets.set(layer.assetId,{manifest:source,role:'composite',width:1,height:1});
  const child={...base(pixels),dependencies:[source],plan:{kind:'cp1-layer-contribution-v1',layer,source,mask:null,maskMapping:'document-luminance-alpha-v1',precision:'binary64',kernel:'triangle-area-source-axis-row-norm-v1',edge:'transparent-zero-no-renormalization',footprint:footprint({x:0,y:0,width:1,height:1},transform)}};
  return {child,entry:{manifest:write(child),pixels,pixelIdentity:hash(canonical({pipeline,width:1,height:1,tiles:child.tiles}))}};
 });
 const state=write({captured:'state'}),stack={schemaVersion:1,kind:'cp1-contribution-stack-v1',pipeline,width:1,height:1,contributions:children.map(c=>c.entry)},stackRef=write(stack);
 const parent={...base(children[0].entry.pixels),dependencies:[stackRef,state],plan:{kind:'request-source-capture-v1',capture:{schemaVersion:1,documentId:'document_1',documentRevision:'2',image:{state,semanticDigest:hash('state'),compositeAssetId:'composite_1'},scope:'visible-document',layerIds:['layer_a','layer_b']},layers,maskMapping:'document-luminance-alpha-v1',precision:'binary64',kernel:'triangle-area-source-axis-row-norm-v1',edge:'transparent-zero-no-renormalization',footprints:children.map(c=>c.child.plan.footprint),contributions:stackRef}};
 const withStack=changed=>{const reference=write(changed);return {...parent,dependencies:[reference,state],plan:{...parent.plan,contributions:reference}};};
 return {objects,assets,read,write,layers,children,stack,parent,withStack,lookup:id=>assets.get(id)};
}

test('portable closure follows every ordered K manifest, raw bytes and native source dependency',async()=>{
 const f=fixture(),needed=[];
 await validateContributionClosure(f.parent,f.read,f.lookup,ref=>needed.push(ref));
 const refs=await contributionReferences(f.parent,f.read),expected=[f.parent.plan.contributions,...f.children.flatMap(({child,entry})=>[entry.manifest,entry.pixels,...child.dependencies])];
 assert.deepEqual(new Set(refs.map(r=>r.hash)),new Set(expected.map(r=>r.hash)));assert.equal(refs.length,7);
 assert.deepEqual(new Set(needed.map(r=>r.hash)),new Set(expected.map(r=>r.hash)));
});

test('portable closure rejects a validly hashed reordered K stack',async()=>{
 const f=fixture(),parent=f.withStack({...f.stack,contributions:[...f.stack.contributions].reverse()});
 await assert.rejects(validateContributionClosure(parent,f.read,f.lookup,()=>{}));
});

test('portable closure rejects native source substitution even when child dependencies agree',async()=>{
 const f=fixture(),child=structuredClone(f.children[0].child);child.plan.source=f.children[1].child.plan.source;child.dependencies=[child.plan.source];
 const parent=f.withStack({...f.stack,contributions:[{...f.stack.contributions[0],manifest:f.write(child)},f.stack.contributions[1]]});
 await assert.rejects(validateContributionClosure(parent,f.read,f.lookup,()=>{}));
});

test('portable closure rejects a raw descriptor that does not match its child manifest',async()=>{
 const f=fixture(),parent=f.withStack({...f.stack,contributions:[{...f.stack.contributions[0],pixels:f.stack.contributions[1].pixels},f.stack.contributions[1]]});
 await assert.rejects(validateContributionClosure(parent,f.read,f.lookup,()=>{}));
});

test('recomputation rejects self-consistent forged K pixels and tile identities',async()=>{
 const f=fixture(),child=structuredClone(f.children[0].child),bytes=Buffer.from([99,100,101,255]),pixels=ref(bytes,'application/x-ideogram-rgba8');f.objects.set(pixels.hash,bytes);child.pixels=pixels;child.tiles[0].hash=pixels.hash;
 const forged={manifest:f.write(child),pixels,pixelIdentity:hash(canonical({pipeline,width:1,height:1,tiles:child.tiles}))},parent=f.withStack({...f.stack,contributions:[forged,f.stack.contributions[1]]});
 await validateContributionClosure(parent,f.read,f.lookup,()=>{});
 assert.throws(()=>assertContributionRecomputation(parent,f.parent));assert.doesNotThrow(()=>assertContributionRecomputation(f.parent,f.parent));
});

test('namespace import maps K metadata and stack references while retaining original bytes and pixel identity',async()=>{
 const f=fixture(),before=new Map([...f.objects].map(([hash,bytes])=>[hash,Buffer.from(bytes)])),refs=new Map();
 for(const [id,asset] of [...f.assets]){const mapped=f.write({native:'mapped_'+id});refs.set(asset.manifest.hash,mapped);f.assets.set('mapped_'+id,{...asset,manifest:mapped});}
 const mapped=await remapContributionClosure(f.parent,{read:f.read,write:f.write,mapAsset:id=>'mapped_'+id,mapRef:r=>refs.get(r.hash)??r,remember:(old,value)=>refs.set(old.hash,value)});
 // The containing importer owns ordinary parent layer/capture namespace mapping.
 mapped.plan.layers=mapped.plan.layers.map(layer=>({...layer,assetId:'mapped_'+layer.assetId}));
 await validateContributionClosure(mapped,f.read,f.lookup,()=>{});
 const stack=await f.read(mapped.plan.contributions);assert.notDeepEqual(mapped.plan.contributions,f.parent.plan.contributions);assert.deepEqual(mapped.dependencies[0],mapped.plan.contributions);
 for(let i=0;i<stack.contributions.length;i++){
  const next=stack.contributions[i],prior=f.stack.contributions[i],child=await f.read(next.manifest);
  assert.deepEqual(next.pixels,prior.pixels);assert.equal(next.pixelIdentity,prior.pixelIdentity);assert.notDeepEqual(next.manifest,prior.manifest);
  assert.equal(child.plan.layer.assetId,'mapped_'+f.layers[i].assetId);assert.deepEqual(child.plan.source,refs.get(f.children[i].child.plan.source.hash));assert.deepEqual(child.dependencies,[child.plan.source]);
 }
 for(const [hash,bytes]of before)assert.deepEqual(f.objects.get(hash),bytes);
});

test('historical captures without retained K manifests keep their existing portable interpretation',async()=>{
 const f=fixture(),legacy=structuredClone(f.parent);delete legacy.plan.contributions;legacy.dependencies=legacy.dependencies.slice(1);
 assert.deepEqual(await contributionReferences(legacy,f.read),[]);await validateContributionClosure(legacy,f.read,f.lookup,()=>{});
 assert.doesNotThrow(()=>assertContributionRecomputation(legacy,f.parent));
 assert.equal(await remapContributionClosure(legacy,{read:()=>assert.fail('legacy read'),write:()=>assert.fail('legacy write'),mapAsset:()=>assert.fail(),mapRef:()=>assert.fail(),remember:()=>assert.fail()}),legacy);
});

test('stack schema and layer count cannot conceal missing or extra contributions',async()=>{
 const f=fixture();for(const stack of [{...f.stack,contributions:[]},{...f.stack,extra:true},{...f.stack,width:2},{...f.stack,contributions:[...f.stack.contributions,f.stack.contributions[0]]}])await assert.rejects(validateContributionClosure(f.withStack(stack),f.read,f.lookup,()=>{}));
});
