import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonical} from '../../dist/local/src/protocol/json.js';
import {emptyComposition,emptyElement} from '../../dist/local/src/composition/core.js';
import {historyCompositionReader,retainedCompositionReference} from '../../dist/local/server/storage/history-composition.js';
import {readComposition} from '../../dist/local/server/storage/composition.js';

// These fixtures exercise the narrow reader's boundary. The existing real
// chained HTTP adoption/copy fixture covers Objects and durable ownership.
function fixture(){
  const composition=emptyComposition(2,2,'composition_1');
  for(let i=0;i<40;i++){const element=emptyElement('obj','element_'+i);element.excluded=true;element.desc.value='x'.repeat(2048);composition.elements.push(element);}
  const bytes=Buffer.from(canonical(composition)),value={hash:'sha256:'+createHash('sha256').update(bytes).digest('hex'),byteLength:String(bytes.length),mediaType:'application/json'};
  assert(bytes.length>65536&&bytes.length<=1048576);
  const calls=[],objects={
    verify(ref,read=false){calls.push({kind:'verify',ref,read});if(read&&BigInt(ref.byteLength)>65536n)throw Object.assign(Error('PAYLOAD_TOO_LARGE'),{code:'PAYLOAD_TOO_LARGE'});assert.deepEqual(ref,value);return read?bytes:undefined;},
    readRange(ref,offset,length){calls.push({kind:'range',ref,offset,length});assert.deepEqual(ref,value);assert(length<=1048576);return bytes.subarray(Number(offset),Number(offset)+length);},
  };
  return {composition,bytes,value,ref:{id:composition.id,value,bindings:{}},objects,calls};
}

test('typed Composition values above 64 KiB preserve exact bytes through the 1 MiB history reader',()=>{
  const f=fixture(),read=historyCompositionReader(f.objects,[f.ref]);
  assert.deepEqual(readComposition(f.ref,read),f.composition);
  assert.deepEqual(Buffer.from(read(f.value)),f.bytes);
  assert(f.calls.some(call=>call.kind==='verify'&&call.read===false));
  assert(f.calls.filter(call=>call.kind==='range').every(call=>call.length<=1048576));
});

test('unlisted metadata and changed length/media descriptors keep the generic 64 KiB bound',()=>{
  const f=fixture();
  for(const [refs,value] of [[[],f.value],[[f.ref],{...f.value,byteLength:String(f.bytes.length+1)}],[[f.ref],{...f.value,mediaType:'text/plain'}]]){
    f.calls.length=0;const read=historyCompositionReader(f.objects,refs);
    assert.throws(()=>read(value),{code:'PAYLOAD_TOO_LARGE'});
    assert.deepEqual(f.calls,[{kind:'verify',ref:value,read:true}]);
  }
});

test('Composition references above 1 MiB or wrong media reject before any object read/allocation',()=>{
  const f=fixture();
  for(const value of [{...f.value,byteLength:'1048577'},{...f.value,mediaType:'text/plain'}])assert.throws(()=>historyCompositionReader(f.objects,[{...f.ref,value}]));
  assert.deepEqual(f.calls,[]);
});

test('large exact bytes do not bypass Composition identity or binding validation',()=>{
  const f=fixture();
  for(const ref of [{...f.ref,id:'different_composition'},{...f.ref,bindings:{unbound:'layer_1'}}])assert.throws(()=>readComposition(ref,historyCompositionReader(f.objects,[ref])));
});

test('a large arbitrary metadata object is not accepted as a typed Composition',()=>{
  const f=fixture(),bytes=Buffer.from(canonical({kind:'some-metadata',padding:'x'.repeat(70000)}));
  const value={hash:'sha256:'+createHash('sha256').update(bytes).digest('hex'),byteLength:String(bytes.length),mediaType:'application/json'},ref={...f.ref,value};
  const objects={verify(actual,read=false){assert.deepEqual(actual,value);assert.equal(read,false);},readRange(actual,offset,length){assert.deepEqual(actual,value);return bytes.subarray(Number(offset),Number(offset)+length);}};
  assert.throws(()=>readComposition(ref,historyCompositionReader(objects,[ref])));
});

test('only validated ImageState or lineage records expose a retained Composition reference',()=>{
  const f=fixture(),state={schemaVersion:5,width:2,height:2,layers:[],composition:f.ref};
  assert.deepEqual(retainedCompositionReference(state),f.ref);
  assert.equal(retainedCompositionReference({kind:'unrelated',composition:f.ref}),null);
  assert.throws(()=>retainedCompositionReference({...state,unexpected:true}));
  assert.throws(()=>retainedCompositionReference({kind:'adopted-candidate-lineage-1',composition:f.ref}));
});

test('failed content verification does not read or allocate the wider payload',()=>{
  const f=fixture(),calls=[],objects={verify(ref,read=false){calls.push({ref,read});throw Object.assign(Error('CORRUPT_OBJECT'),{code:'CORRUPT_OBJECT'});},readRange(){assert.fail('Unverified content must not be read');}};
  assert.throws(()=>historyCompositionReader(objects,[f.ref])(f.value),{code:'CORRUPT_OBJECT'});
  assert.deepEqual(calls,[{ref:f.value,read:false}]);
});
