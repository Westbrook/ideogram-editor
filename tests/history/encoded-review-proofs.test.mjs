import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {EncodedReviewProofLeases,encodedReviewRaw} from '../../dist/local/server/storage/encoded-review-proofs.js';
import {PROOF_LIMIT,PROOF_METADATA_BYTES,PROOF_METADATA_BUDGET} from '../../dist/local/server/storage/objects.js';

const RGBA='application/x-ideogram-rgba8',R16='application/x-ideogram-r16le';
const hash=value=>'sha256:'+createHash('sha256').update(value).digest('hex');
const ref=(label,mediaType=RGBA)=>({hash:hash(label),byteLength:mediaType===R16?'2':'4',mediaType});
const binding=(overrides={})=>({reviewId:'review_1',reviewHash:hash('review'),writerEpoch:'1',targetClientId:'client_1',documentId:'document_1',sessionHash:'a'.repeat(64),expiresAt:1_060_000,...overrides});
const stale={code:'STALE_REVISION',reason:'ENCODED_REBUILD_REVIEW_REQUIRED'};
const capacity={code:'CAPACITY',reason:'ENCODED_REBUILD_REVIEW_LIMIT'};
const empty={leases:0,proofs:0,metadataBytes:0};

// The fake issues opaque identities and preserves the issued reference, just
// as Objects does. An arbitrary token never becomes evidence by being passed
// to proven(), and changing any BlobRef field invalidates its authority.
function proofAuthority(){
  const issued=new Map(),invalidated=new Set(),checks=[],releases=[];
  let serial=0;
  return {
    issued,checks,releases,
    issue(value){
      const token='issued_proof_'+(++serial);
      issued.set(token,Object.freeze({...value}));
      return {token,ref:{...value}};
    },
    invalidate(token){assert(issued.has(token));invalidated.add(token);},
    proven(value,token){
      checks.push({token,ref:{...value}});
      const saved=issued.get(token);
      if(!saved||invalidated.has(token)||['hash','byteLength','mediaType'].some(key=>saved[key]!==value[key])){
        throw Object.assign(new Error('CORRUPT_OBJECT'),{code:'CORRUPT_OBJECT'});
      }
    },
    releaseProof(token){
      releases.push(token);
      issued.delete(token);
      invalidated.delete(token);
    },
  };
}

// No wall-clock delays or native timers: tests explicitly advance time or
// dispatch a due callback, and observe cancellation and unref calls.
function clock(){
  let now=1_000_000;
  const pending=new Set(),scheduled=[],canceled=[];
  return {
    pending,scheduled,canceled,
    now:()=>now,
    schedule(callback,delay){
      assert(Number.isFinite(delay)&&delay>=0);
      const timer={at:now+delay,callback,unrefs:0,unref(){this.unrefs++;return this;}};
      pending.add(timer);scheduled.push(timer);return timer;
    },
    cancel(timer){canceled.push(timer);pending.delete(timer);},
    set(value){assert(value>=now);now=value;},
    dispatch(){
      let count=0;
      for(;;){
        const next=[...pending].filter(timer=>timer.at<=now).sort((a,b)=>a.at-b.at)[0];
        if(!next)return;
        assert(++count<=100,'expiry scheduling must not spin');
        pending.delete(next);next.callback();
      }
    },
  };
}

function fixture(t){
  const authority=proofAuthority(),time=clock();
  const leases=new EncodedReviewProofLeases(authority,{now:time.now,monotonicNow:time.now,schedule:time.schedule,cancel:time.cancel});
  t.after(()=>{
    leases.close();
    assert.equal(time.pending.size,0,'closing cancels outstanding expiry work');
    assert(time.scheduled.every(timer=>timer.unrefs>0),'expiry work cannot keep the writer alive');
    assert.equal(new Set(authority.releases).size,authority.releases.length,'a token is never released twice');
  });
  return {authority,time,leases};
}

function inventory(leases,count,proofs){
  assert.deepEqual(leases.inventory(),{leases:count,proofs,metadataBytes:proofs*PROOF_METADATA_BYTES});
}

function released(authority,proofs){
  assert.deepEqual([...authority.releases].sort(),proofs.map(proof=>proof.token).sort());
  for(const proof of proofs)assert(!authority.issued.has(proof.token));
}

test('raw selection accepts only canonical RGBA and R16 identities',()=>{
  for(const mediaType of [RGBA,R16])assert.equal(encodedReviewRaw(ref(mediaType,mediaType)),true);
  for(const mediaType of ['application/json','image/png','image/webp','application/octet-stream',RGBA+';charset=binary','application/x-ideogram-r16']){
    assert.equal(encodedReviewRaw(ref(mediaType,mediaType)),false);
  }
});

test('an abandoned owner releases every proof at the four-second monotonic boundary',t=>{
 const {authority,time,leases}=fixture(t),review=binding(),proofs=[authority.issue(ref('disconnected rgba')),authority.issue(ref('disconnected r16',R16))],start=time.now();
 leases.hold(review,proofs);assert.equal(time.scheduled.at(-1).at,start+4000);
 time.set(start+3999);time.dispatch();inventory(leases,1,2);assert.deepEqual(authority.releases,[]);
 time.set(start+4000);time.dispatch();inventory(leases,0,0);released(authority,proofs);
 assert.throws(()=>leases.renew(review),stale);assert.throws(()=>leases.take(review),stale);
});

test('only an exact live authenticated owner renews; stale fields neither extend nor steal the owner',t=>{
 const {authority,time,leases}=fixture(t),review=binding(),proof=authority.issue(ref('renewed owner')),start=time.now();
 leases.hold(review,[proof]);const original=time.scheduled.at(-1);
 time.set(start+3000);
 for(const patch of [{reviewId:'other_review'},{reviewHash:hash('other')},{writerEpoch:'2'},{targetClientId:'other_client'},{documentId:'other_doc'},{sessionHash:'b'.repeat(64)},{expiresAt:review.expiresAt+1}])assert.throws(()=>leases.renew({...review,...patch}),stale);
 assert.equal(time.scheduled.length,1);inventory(leases,1,1);assert.deepEqual(authority.releases,[]);
 leases.renew(review);assert(time.canceled.includes(original));assert.equal(time.scheduled.at(-1).at,start+7000);
 time.set(start+6999);time.dispatch();inventory(leases,1,1);
 time.set(start+7000);time.dispatch();released(authority,[proof]);inventory(leases,0,0);
});

test('a delayed expiry callback cannot permit renewal or acceptance at its already-expired deadline',async t=>{
 for(const operation of ['renew','take'])await t.test(operation,t=>{
  const {authority,time,leases}=fixture(t),review=binding(),proof=authority.issue(ref(operation));leases.hold(review,[proof]);
  time.set(time.now()+4000); // Deliberately do not dispatch the queued timer.
  assert.throws(()=>leases[operation](review),stale);released(authority,[proof]);inventory(leases,0,0);assert.equal(time.pending.size,0);
 });
});

test('wall-clock rollback cannot extend the monotonic ownership grace',t=>{
 const authority=proofAuthority(),time=clock();let wall=time.now();
 const leases=new EncodedReviewProofLeases(authority,{now:()=>wall,monotonicNow:time.now,schedule:time.schedule,cancel:time.cancel});t.after(()=>leases.close());
 const review=binding(),proof=authority.issue(ref('clock rollback'));leases.hold(review,[proof]);wall-=1000;
 time.set(time.now()+4000);time.dispatch();released(authority,[proof]);inventory(leases,0,0);
 assert.throws(()=>leases.renew(review),stale);
});

test('renewal revalidates the same proof authority and releases all held tokens on corruption',t=>{
 const {authority,time,leases}=fixture(t),review=binding(),proofs=[authority.issue(ref('renew rgba')),authority.issue(ref('renew r16',R16))];
 leases.hold(review,proofs);authority.invalidate(proofs[1].token);time.set(time.now()+1000);
 assert.throws(()=>leases.renew(review),stale);released(authority,proofs);inventory(leases,0,0);assert.equal(time.pending.size,0);
});

test('renewal cannot recreate a consumed lease or release the active acceptance owner',t=>{
 const {authority,time,leases}=fixture(t),review=binding(),proof=authority.issue(ref('acceptance owner'));leases.hold(review,[proof]);
 const taken=leases.take(review);assert.throws(()=>leases.renew(review),stale);time.set(time.now()+10000);time.dispatch();
 assert.deepEqual(authority.releases,[]);authority.proven(taken[0].ref,taken[0].token);authority.releaseProof(taken[0].token);
});

test('failed explicit cancellation still releases an abandoned owner within five seconds using a real timer',async t=>{
 const authority=proofAuthority(),leases=new EncodedReviewProofLeases(authority);t.after(()=>leases.close());
 const review=binding({expiresAt:Date.now()+60000}),proof=authority.issue(ref('unreachable canceled owner')),started=performance.now();leases.hold(review,[proof]);
 // No cancel/discard request reaches the server. No public owner read renews it.
 while(!authority.releases.length&&performance.now()-started<5000)await new Promise(resolve=>setTimeout(resolve,25));
 assert(performance.now()-started<5000,'Four-second native lease timer must settle within the five-second owner-release bound');
 released(authority,[proof]);inventory(leases,0,0);assert.throws(()=>leases.renew(review),stale);
});

test('hold snapshots the binding and exact raw proofs; take returns frozen metadata and transfers ownership once',t=>{
  const {authority,time,leases}=fixture(t),original=binding(),inputBinding={...original};
  const rgba=authority.issue(ref('pixels')),metadata=authority.issue(ref('manifest','application/json')),r16=authority.issue(ref('mask',R16));
  const input=[rgba,metadata,r16],expected=structuredClone([rgba,r16]);
  assert.deepEqual([...leases.hold(inputBinding,input)],[rgba.token,r16.token]);
  inventory(leases,1,2);
  assert.deepEqual(authority.releases,[]);

  inputBinding.reviewHash=hash('mutated review');
  inputBinding.expiresAt=0;
  rgba.ref.byteLength='400';rgba.token='unissued';r16.ref.hash=hash('mutated pixels');
  input.splice(0,input.length);
  const taken=leases.take(original);
  assert.deepEqual(taken,expected);
  assert(Object.isFrozen(taken));
  for(const proof of taken){assert(Object.isFrozen(proof));assert(Object.isFrozen(proof.ref));}
  assert.throws(()=>{taken[0].ref.byteLength='800';},TypeError);
  assert.deepEqual(authority.checks.slice(-2),expected);
  assert.deepEqual(leases.inventory(),empty);
  assert.equal(time.pending.size,0);
  assert(time.canceled.length>0);
  assert.throws(()=>leases.take(original),stale);
  leases.discard(original.reviewId);leases.close();leases.close();
  assert.deepEqual(authority.releases,[],'taken proofs now belong to the caller');
  assert(authority.issued.has(metadata.token),'metadata proof ownership never moved');
  for(const proof of taken)authority.releaseProof(proof.token);
  released(authority,expected);
});

test('equal hashes and lengths retain distinct raw media proofs; expiry uses the snapshotted review ID',t=>{
  const {authority,time,leases}=fixture(t),review=binding(),rgba=ref('shared raw bytes');
  const r16={...rgba,mediaType:R16},proofs=[authority.issue(rgba),authority.issue(r16)];
  assert.deepEqual([...leases.hold(review,proofs)],proofs.map(proof=>proof.token));
  inventory(leases,1,2);
  authority.checks.length=0;
  const taken=leases.take(review);
  assert.deepEqual(taken,proofs);
  assert.deepEqual(authority.checks,proofs,'take validates both exact media identities');
  assert.deepEqual(authority.releases,[]);
  for(const proof of taken)authority.releaseProof(proof.token);

  const expiring=binding({reviewId:'review_2'}),original={...expiring};
  const expiringProofs=[authority.issue(rgba),authority.issue(r16)];
  leases.hold(expiring,expiringProofs);
  expiring.reviewId='review_mutated';
  time.set(original.expiresAt);time.dispatch();
  assert.deepEqual(leases.inventory(),empty);
  assert.equal(time.pending.size,0);
  released(authority,[...proofs,...expiringProofs]);
  assert.throws(()=>leases.take(original),stale);
});

test('no raw inputs are refused without claiming or releasing metadata proofs',t=>{
  const {authority,time,leases}=fixture(t),metadata=authority.issue(ref('manifest','application/json'));
  for(const input of [[],[metadata]])assert.throws(()=>leases.hold(binding(),input),stale);
  assert.deepEqual(leases.inventory(),empty);
  assert.deepEqual(authority.releases,[]);
  assert(authority.issued.has(metadata.token));
  assert.equal(time.pending.size,0);
});

test('duplicate references retain one proof; unused and already leased tokens keep their owner',t=>{
  const {authority,leases}=fixture(t),review=binding(),first=authority.issue(ref('duplicate')),second=authority.issue(ref('duplicate'));
  assert.deepEqual([...leases.hold(review,[first,first,second])],[first.token]);
  inventory(leases,1,1);
  assert.throws(()=>leases.hold(binding({reviewId:'review_2'}),[first]),stale);
  inventory(leases,1,1);assert.deepEqual(authority.releases,[]);
  leases.discard(review.reviewId);released(authority,[first]);
  assert(authority.issued.has(second.token),'the unselected proof is still caller-owned');
});

test('hold rejects unissued and invalidated tokens without releasing any caller-owned proof',async t=>{
  for(const kind of ['unissued','invalidated'])await t.test(kind,t=>{
    const {authority,time,leases}=fixture(t),good=authority.issue(ref('good')),bad=authority.issue(ref('bad',R16));
    if(kind==='unissued')bad.token='never-issued';else authority.invalidate(bad.token);
    assert.throws(()=>leases.hold(binding(),[good,bad]),{code:'CORRUPT_OBJECT'});
    assert.deepEqual(leases.inventory(),empty);
    assert.deepEqual(authority.releases,[]);
    assert(authority.issued.has(good.token));
    assert.equal(time.pending.size,0);
  });
});

test('an issued token cannot prove another hash, byte length, or raw media type',async t=>{
  for(const [key,value]of [['hash',hash('substitution')],['byteLength','8'],['mediaType',R16]])await t.test(key,t=>{
    const {authority,leases}=fixture(t),proof=authority.issue(ref('original'));
    proof.ref[key]=value;
    assert.throws(()=>leases.hold(binding(),[proof]),{code:'CORRUPT_OBJECT'});
    assert.deepEqual(leases.inventory(),empty);
    assert.deepEqual(authority.releases,[]);
    assert(authority.issued.has(proof.token));
  });
});

test('invalid bindings and expired, non-finite, or overlong lifetimes leave input ownership with the caller',async t=>{
  const invalid=[
    ['review ID',{reviewId:''}],['review hash',{reviewHash:'a'.repeat(64)}],
    ['writer epoch',{writerEpoch:'01'}],['client ID',{targetClientId:''}],['document ID',{documentId:''}],
    ['session hash',{sessionHash:'sha256:'+'a'.repeat(64)}],
    ['expired',{expiresAt:999_999}],['expires now',{expiresAt:1_000_000}],
    ['beyond thirty minutes',{expiresAt:1_000_000+30*60*1000+1}],
    ['infinite expiry',{expiresAt:Infinity}],['NaN expiry',{expiresAt:NaN}],
    ['fractional expiry',{expiresAt:1_060_000.5}],['string expiry',{expiresAt:'1060000'}],
  ];
  for(const [label,patch]of invalid)await t.test(label,t=>{
    const {authority,time,leases}=fixture(t),proof=authority.issue(ref(label));
    assert.throws(()=>leases.hold(binding(patch),[proof]),stale);
    assert.deepEqual(leases.inventory(),empty);
    assert.deepEqual(authority.releases,[]);
    assert(authority.issued.has(proof.token));
    assert.equal(time.pending.size,0);
  });
});

test('the thirty-minute metadata lifetime remains capped while a live owner renews',t=>{
  const {authority,time,leases}=fixture(t),review=binding({expiresAt:time.now()+30*60*1000}),proof=authority.issue(ref('maximum lifetime'));
  leases.hold(review,[proof]);inventory(leases,1,1);
  for(let at=time.now()+3000;at<review.expiresAt;at+=3000){time.set(at);time.dispatch();leases.renew(review);}
  time.set(review.expiresAt);
  assert.throws(()=>leases.take(review),stale);
  released(authority,[proof]);assert.deepEqual(leases.inventory(),empty);
  assert.equal(time.pending.size,0);
});

test('each changed binding field consumes the identified lease and releases every raw proof',async t=>{
  const changes={reviewHash:hash('other review'),writerEpoch:'2',targetClientId:'client_2',documentId:'document_2',sessionHash:'b'.repeat(64),expiresAt:1_060_001};
  for(const [key,value]of Object.entries(changes))await t.test(key,t=>{
    const {authority,time,leases}=fixture(t),review=binding(),proofs=[authority.issue(ref('rgba')),authority.issue(ref('r16',R16))];
    leases.hold(review,proofs);
    assert.throws(()=>leases.take({...review,[key]:value}),stale);
    released(authority,proofs);assert.deepEqual(leases.inventory(),empty);
    assert.equal(time.pending.size,0);
    assert.throws(()=>leases.take(review),stale);
    released(authority,proofs);
  });
});

test('a missing or different review ID cannot take or discard an unrelated lease',t=>{
  const {authority,leases}=fixture(t),review=binding(),proof=authority.issue(ref('retained'));
  assert.throws(()=>leases.take(review),stale);
  leases.hold(review,[proof]);
  assert.throws(()=>leases.take({...review,reviewId:'review_2'}),stale);
  leases.discard('review_2');inventory(leases,1,1);
  assert.deepEqual(authority.releases,[]);
  assert.deepEqual(leases.take(review),[proof]);
  authority.releaseProof(proof.token);
});

test('take revalidates all exact tokens and releases the entire lease when one was invalidated',t=>{
  const {authority,time,leases}=fixture(t),review=binding(),proofs=[authority.issue(ref('rgba')),authority.issue(ref('r16',R16))];
  leases.hold(review,proofs);
  authority.checks.length=0;
  authority.invalidate(proofs[1].token);
  assert.throws(()=>leases.take(review),stale);
  assert.deepEqual(authority.checks,proofs);
  released(authority,proofs);assert.deepEqual(leases.inventory(),empty);
  assert.equal(time.pending.size,0);
  assert.throws(()=>leases.take(review),stale);
  released(authority,proofs);
});

test('expiry callbacks release only due leases; later reviews stay usable',t=>{
  const {authority,time,leases}=fixture(t),early=binding({expiresAt:time.now()+10}),late=binding({reviewId:'review_2',expiresAt:time.now()+20});
  const first=authority.issue(ref('early')),second=authority.issue(ref('late',R16));
  leases.hold(early,[first]);leases.hold(late,[second]);
  time.set(early.expiresAt-1);time.dispatch();inventory(leases,2,2);
  assert.deepEqual(authority.releases,[]);
  time.set(early.expiresAt);time.dispatch();inventory(leases,1,1);
  released(authority,[first]);assert(authority.issued.has(second.token));
  assert.throws(()=>leases.take(early),stale);
  assert.deepEqual(leases.take(late),[second]);
  assert.equal(time.pending.size,0);
  authority.releaseProof(second.token);
});

test('discard cancels expiry and releases only the named review; close releases all remaining reviews once',t=>{
  const {authority,time,leases}=fixture(t),first=authority.issue(ref('one')),second=authority.issue(ref('two',R16));
  const reviews=[binding(),binding({reviewId:'review_2',expiresAt:1_070_000})];
  leases.hold(reviews[0],[first]);leases.hold(reviews[1],[second]);
  const before=time.canceled.length;
  leases.discard(reviews[0].reviewId);leases.discard(reviews[0].reviewId);
  inventory(leases,1,1);released(authority,[first]);
  assert(time.canceled.length>before);
  leases.close();leases.close();
  assert.deepEqual(leases.inventory(),empty);released(authority,[first,second]);
  assert.equal(time.pending.size,0);
  time.set(1_100_000);time.dispatch();released(authority,[first,second]);
  for(const review of reviews)assert.throws(()=>leases.take(review),stale);
  const afterClose=authority.issue(ref('after close'));
  assert.throws(()=>leases.hold(binding({reviewId:'review_3',expiresAt:1_160_000}),[afterClose]),stale);
  assert(authority.issued.has(afterClose.token));released(authority,[first,second]);
});

test('discard reports whether a live review was released and never reclaims taken proofs',t=>{
  const {authority,time,leases}=fixture(t),review=binding(),held=authority.issue(ref('discard result'));
  assert.equal(leases.discard(review.reviewId),false);
  leases.hold(review,[held]);
  assert.equal(leases.discard(review.reviewId),true);
  assert.equal(leases.discard(review.reviewId),false);
  released(authority,[held]);assert.deepEqual(leases.inventory(),empty);
  assert.equal(time.pending.size,0);

  const takenReview=binding({reviewId:'review_taken'}),proof=authority.issue(ref('taken discard result'));
  leases.hold(takenReview,[proof]);
  const taken=leases.take(takenReview);
  assert.equal(leases.discard(takenReview.reviewId),false);
  authority.proven(taken[0].ref,taken[0].token);
  released(authority,[held]);
  authority.releaseProof(taken[0].token);
});

test('document deletion immediately releases only held source-document reviews and cancels their timers',t=>{
  const {authority,time,leases}=fixture(t),now=time.now();
  const first=binding(),second=binding({reviewId:'review_2'});
  const other=binding({reviewId:'review_other',documentId:'document_10'});
  const adopting=binding({reviewId:'review_adopting'});
  const firstProofs=[authority.issue(ref('source rgba')),authority.issue(ref('source mask',R16))];
  const secondProofs=[authority.issue(ref('another source review'))];
  const otherProofs=[authority.issue(ref('other document'))];
  const adoptionProofs=[authority.issue(ref('adoption rgba')),authority.issue(ref('adoption mask',R16))];
  leases.hold(first,firstProofs);const firstTimer=time.scheduled.at(-1);
  leases.hold(second,secondProofs);const secondTimer=time.scheduled.at(-1);
  leases.hold(other,otherProofs);const otherTimer=time.scheduled.at(-1);
  leases.hold(adopting,adoptionProofs);
  const taken=leases.take(adopting),cancellations=time.canceled.length;
  inventory(leases,3,4);assert.equal(time.pending.size,3);
  first.documentId='document_10'; // Deletion must use the stored binding snapshot.

  assert.equal(leases.discardDocument('document_1'),2);
  assert.equal(time.now(),now,'document deletion needs neither expiry nor clock advancement');
  inventory(leases,1,1);released(authority,[...firstProofs,...secondProofs]);
  assert.equal(time.canceled.length,cancellations+2);
  assert(time.canceled.includes(firstTimer));assert(time.canceled.includes(secondTimer));
  assert(!time.canceled.includes(otherTimer));assert.deepEqual([...time.pending],[otherTimer]);
  assert.throws(()=>leases.take(binding()),stale);
  assert.throws(()=>leases.take(second),stale);
  for(const proof of [...taken,...otherProofs])authority.proven(proof.ref,proof.token);

  assert.equal(leases.discardDocument('document_1'),0);
  assert.equal(leases.discardDocument('document_missing'),0);
  assert.equal(leases.discard(adopting.reviewId),false);
  assert.equal(time.canceled.length,cancellations+2);
  inventory(leases,1,1);released(authority,[...firstProofs,...secondProofs]);
  assert.deepEqual(leases.take(other),otherProofs);
  assert.equal(leases.discardDocument(other.documentId),0);
  assert.deepEqual(leases.inventory(),empty);assert.equal(time.pending.size,0);
  for(const proof of [...taken,...otherProofs])authority.releaseProof(proof.token);
  released(authority,[...firstProofs,...secondProofs,...adoptionProofs,...otherProofs]);
});

test('close and a fresh manager retain no review leases and cannot reclaim adoption-owned proofs',t=>{
  const {authority,time,leases}=fixture(t),heldReview=binding(),takenReview=binding({reviewId:'review_taken'});
  const held=authority.issue(ref('close held')),owned=authority.issue(ref('close taken',R16));
  leases.hold(heldReview,[held]);leases.hold(takenReview,[owned]);
  const taken=leases.take(takenReview);
  leases.close();assert.deepEqual(leases.inventory(),empty);
  assert.equal(leases.discardDocument(heldReview.documentId),0);
  assert.equal(leases.discard(heldReview.reviewId),false);
  assert.equal(time.pending.size,0);released(authority,[held]);

  // Even an authority still holding a valid adoption token cannot recreate a
  // review lease in a fresh manager; the live review capability is not durable.
  const fresh=new EncodedReviewProofLeases(authority,{now:time.now,monotonicNow:time.now,schedule:time.schedule,cancel:time.cancel});
  t.after(()=>fresh.close());
  assert.deepEqual(fresh.inventory(),empty);
  assert.equal(fresh.discardDocument(heldReview.documentId),0);
  for(const review of [heldReview,takenReview]){
    assert.equal(fresh.discard(review.reviewId),false);
    assert.throws(()=>fresh.take(review),stale);
  }
  fresh.close();assert.deepEqual(fresh.inventory(),empty);released(authority,[held]);
  authority.proven(taken[0].ref,taken[0].token);
  authority.releaseProof(taken[0].token);released(authority,[held,owned]);
});

test('failure to schedule expiry rolls back hold without releasing caller-owned input',()=>{
  const authority=proofAuthority(),time=clock(),proof=authority.issue(ref('scheduler rollback'));
  const failure=new Error('scheduler unavailable');
  const leases=new EncodedReviewProofLeases(authority,{now:time.now,schedule(){throw failure;},cancel:time.cancel});
  assert.throws(()=>leases.hold(binding(),[proof]),error=>error===failure);
  assert.deepEqual(leases.inventory(),empty);assert.deepEqual(authority.releases,[]);
  leases.close();assert.deepEqual(authority.releases,[]);
  assert(authority.issued.has(proof.token));assert.equal(time.pending.size,0);
});

test('the ninth lease is refused atomically and discarding one makes room without stealing the refused proof',t=>{
  const {authority,leases}=fixture(t),proofs=Array.from({length:9},(_,i)=>authority.issue(ref('lease '+i)));
  for(let i=0;i<8;i++)leases.hold(binding({reviewId:'review_'+(i+1)}),[proofs[i]]);
  inventory(leases,8,8);
  assert.throws(()=>leases.hold(binding({reviewId:'review_9'}),[proofs[8]]),capacity);
  inventory(leases,8,8);assert.deepEqual(authority.releases,[]);
  assert(authority.issued.has(proofs[8].token));
  leases.discard('review_1');released(authority,[proofs[0]]);
  leases.hold(binding({reviewId:'review_9'}),[proofs[8]]);inventory(leases,8,8);
  leases.close();released(authority,proofs);
});

test('cumulative raw-proof metadata reaches its fixed byte budget and refuses overflow without leaks',t=>{
  const {authority,leases}=fixture(t),proofs=Array.from({length:PROOF_LIMIT},(_,i)=>authority.issue(ref('budget '+i)));
  const split=Math.floor(PROOF_LIMIT/2),overflow=authority.issue(ref('overflow'));
  leases.hold(binding(),proofs.slice(0,split));
  leases.hold(binding({reviewId:'review_2'}),proofs.slice(split));
  inventory(leases,2,PROOF_LIMIT);
  assert.equal(leases.inventory().metadataBytes,PROOF_METADATA_BUDGET);
  assert.throws(()=>leases.hold(binding({reviewId:'review_3'}),[overflow]),capacity);
  inventory(leases,2,PROOF_LIMIT);assert.deepEqual(authority.releases,[]);
  assert(authority.issued.has(overflow.token));
  leases.close();released(authority,proofs);
  assert(authority.issued.has(overflow.token));
});

test('an oversized single hold is refused without retaining or releasing any input proof',t=>{
  const {authority,time,leases}=fixture(t),proofs=Array.from({length:PROOF_LIMIT+1},(_,i)=>authority.issue(ref('oversized '+i)));
  assert.throws(()=>leases.hold(binding(),proofs),capacity);
  assert.deepEqual(leases.inventory(),empty);assert.deepEqual(authority.releases,[]);
  assert.equal(authority.issued.size,proofs.length);assert.equal(time.pending.size,0);
});


test('session invalidation releases only still-held exact-session leases across documents without advancing time',t=>{
  const {authority,time,leases}=fixture(t),session='a'.repeat(64),other='b'.repeat(64),now=time.now();
  const proofs=['first','second','other session','adoption'].map(label=>authority.issue(ref(label)));
  leases.hold(binding({reviewId:'review_1',documentId:'document_1',sessionHash:session}),[proofs[0]]);
  leases.hold(binding({reviewId:'review_2',documentId:'document_2',sessionHash:session}),[proofs[1]]);
  leases.hold(binding({reviewId:'review_3',documentId:'document_1',sessionHash:other}),[proofs[2]]);
  const adoption=binding({reviewId:'review_4',documentId:'document_1',sessionHash:session});
  leases.hold(adoption,[proofs[3]]);const taken=leases.take(adoption);
  assert.equal(leases.discardSession(session),2);
  assert.equal(time.now(),now,'session teardown releases ownership synchronously');
  inventory(leases,1,1);released(authority,proofs.slice(0,2));
  assert.equal(time.pending.size,1);assert.equal(leases.discardSession(session),0);
  authority.proven(taken[0].ref,taken[0].token);
  assert.equal(leases.discardSession(other),1);assert.equal(time.pending.size,0);
  authority.releaseProof(taken[0].token);released(authority,proofs);
});
