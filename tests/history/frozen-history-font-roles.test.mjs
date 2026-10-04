import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonical} from '../../dist/local/server/storage/canonical.js';
import {TextTreatments} from '../../dist/local/server/storage/text-treatment.js';
import {planTextTreatment,bindTextTreatmentEnvelope} from '../../dist/local/src/request/text-treatment.js';

const hash=value=>'sha256:'+createHash('sha256').update(value).digest('hex');
const identify=value=>({...value,id:hash(canonical(value))});
// This fixture exercises reference classification only. It neither claims
// native render admission nor installs invented metadata into a writer.
function fixture(collision=null,invalidFontIdentity=false){
 const objects=new Map(),reads=[];
 const put=(value,mediaType='text/plain')=>{const bytes=Buffer.isBuffer(value)?value:Buffer.from(value),ref={hash:hash(bytes),byteLength:String(bytes.length),mediaType};objects.set(ref.hash,bytes);return ref;};
 const json=value=>put(canonical(value),'application/json');
 const fontBytes=put('Font bytes owned only through a typed FontVersion');
 const license=collision==='length'?{...fontBytes,byteLength:String(BigInt(fontBytes.byteLength)+1n)}:collision==='license'?fontBytes:put('Retained license');
 const font=identify({schemaVersion:1,bytes:fontBytes,faceIndex:0,format:'static-ttf',parserProfile:'sfnt-static-1-freetype-canvaskit040',fsType:0,licenseRecord:license,origin:'local-file',embedding:'permitted'});
 if(invalidFontIdentity)font.id=hash('not the immutable font identity');
 const text=identify({schemaVersion:1,textUtf8:put('Frozen text'),style:{primaryFont:fontBytes.hash,explicitFallbacks:[],sizePx:12,lineHeightMultiplier:1,fill:[0,0,0,0],align:'start',direction:'ltr'},frame:{width:1,height:1},layoutPolicy:'text-layout-1',fonts:[font]});
 const render=identify({schemaVersion:1,textVersion:text.id,rendererProfile:{schemaVersion:1,id:hash('renderer identity'),manifest:json({profile:'retained profile metadata'})},dependencyHash:hash('dependency identity'),layout:json({layout:'opaque retained bytes'}),pixels:put(Buffer.alloc(4),'application/x-ideogram-rgba8'),width:1,height:1,overflow:false,resolvedFonts:[font.id]});
 const source=json({schemaVersion:1,text,render});
 const layer={kind:'text',id:'native_text',version:'1',name:'Frozen text',source,assetId:'native_raster',layerToDocument:[1,0,0,1,0,0],opacity:1,visible:false,locked:false,blend:'normal',mask:null};
 const state=json({schemaVersion:2,width:1,height:1,layers:[layer]});
 const inventory={schemaVersion:1,kind:'text-treatment-inventory-1',documentId:'document_1',documentRevision:'3',grid:{width:1,height:1},imageState:state,layers:[{id:layer.id,version:layer.version,kind:'text',visible:false,locked:false,stateHash:hash(canonical(layer)),contribution:null,native:{source,literal:text.textUtf8,textVersion:text.id,renderVersion:render.id,dependencyHash:render.dependencyHash}}],composition:null,semanticText:[]};
 const plan=planTextTreatment({id:'frozen_reference_plan',inventory,choice:{kind:'no-native-text',excludedSemanticIds:[],approvalId:'reviewed'},beforeSource:null,afterSource:null,prompt:{mode:'plain',bytes:collision==='prompt'?fontBytes:put('Requested image'),projection:null},edit:null});
 const envelope=bindTextTreatmentEnvelope(plan,json(plan));
 const store={verify(ref,read=false){reads.push(ref.hash);const bytes=objects.get(ref.hash);assert(bytes,'Unexpected missing metadata read '+ref.hash);assert.equal(hash(bytes),ref.hash);assert.equal(String(bytes.length),ref.byteLength);return read?bytes:undefined;},verifyOwned(ref){return {bytes:Buffer.from(this.verify(ref,true)),release(){}};},readRange(ref,offset,length){return objects.get(ref.hash).subarray(Number(offset),Number(offset)+length);}};
 const treatments=new TextTreatments(store,{},()=>assert.fail('Reference classification cannot resolve live state'),{});
 // Deleting these bytes does not prevent reading immutable metadata. Only the
 // history command may decide whether a classified reference needs a proof.
 objects.delete(fontBytes.hash);
 return {treatments,envelope,fontBytes,license,source,render,text,reads,store};
}

test('text-treatment reference roles preserve the complete strict refs contract',()=>{
 const f=fixture(),roles=f.treatments.refsWithRoles(f.envelope),strict=f.treatments.refs(f.envelope);
 assert.deepEqual(roles.map(entry=>entry.ref),strict);
 assert.deepEqual(roles.filter(entry=>entry.role==='font-bytes').map(entry=>entry.ref),[f.fontBytes]);
 for(const ref of [f.source,f.text.textUtf8,f.render.layout,f.render.pixels,f.render.rendererProfile.manifest,f.license])assert.equal(roles.find(entry=>canonical(entry.ref)===canonical(ref))?.role,'required');
 assert.equal(f.reads.includes(f.fontBytes.hash),false,'Classification must not execute or load an absent font');
});

for(const collision of ['license','prompt'])test('ordinary '+collision+' ownership defeats the font-only missing-byte exception',()=>{
 const f=fixture(collision),roles=f.treatments.refsWithRoles(f.envelope);
 assert.equal(roles.find(entry=>canonical(entry.ref)===canonical(f.fontBytes))?.role,'required');
 assert.deepEqual(roles.map(entry=>entry.ref),f.treatments.refs(f.envelope));
 assert.equal(roles.filter(entry=>entry.role==='font-bytes').length,0);
});

test('font classification requires immutable TextSource identities',()=>{
 const f=fixture(null,true);
 assert.throws(()=>f.treatments.refsWithRoles(f.envelope));
});

test('same-hash inconsistent lengths reject in both strict and role-preserving reference walks',()=>{
 // Font/text/render IDs include the altered license descriptor, so their
 // immutable identities are correct. The invalidity is the conflicting byte
 // length for one hash, which retainedMetadataReferences must still reject.
 const f=fixture('length');
 assert.throws(()=>f.treatments.refs(f.envelope));
 assert.throws(()=>f.treatments.refsWithRoles(f.envelope));
});
