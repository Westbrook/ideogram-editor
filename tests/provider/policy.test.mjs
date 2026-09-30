import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isPublicAddress, validateAnswers, sameAddress, exactURL, validateQueueURL, queuePath, resolvePrivacy, PRODUCTION_MEDIA_HOSTS, PRODUCTION_UPLOAD_ORIGINS } from '../../dist/local/server/provider/policy.js';
import { createProductionProvider } from '../../dist/local/server/provider/index.js';
import { sanitizedHeaders } from '../../dist/local/server/provider/evidence.js';
import { egressAttempts } from './no-egress.mjs';
import { fixtureProfile } from './emulator.mjs';
import { assertCode } from './support.mjs';
for(const address of ['0.0.0.0','10.0.0.1','100.64.0.1','127.0.0.1','169.254.0.1','172.16.0.1','192.168.1.1','192.0.0.1','192.0.2.1','192.88.99.1','198.18.1.1','198.51.100.1','203.0.113.1','224.0.0.1','255.255.255.255','::','::1','::ffff:127.0.0.1','::ffff:0808:0808','64:ff9b::808:808','fc00::1','fe80::1','ff02::1','2001:db8::1','2002:0808:0808::1','2001::1','3fff::1','2130706433','0177.0.0.1','0x7f000001','fe80::1%lo0']){
 test('reject nonpublic or noncanonical address '+address,()=>assert.equal(isPublicAddress(address),false));
}
for(const address of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111','2001:4860:4860::8888'])test('classify global unicast '+address,()=>assert.equal(isPublicAddress(address),true));
test('all DNS answers and family must pass, including mixed A/AAAA',()=>{
 assertCode(()=>validateAnswers([{address:'8.8.8.8',family:4},{address:'::1',family:6}]),'ADDRESS');
 assertCode(()=>validateAnswers([{address:'8.8.8.8',family:6}]),'ADDRESS');assertCode(()=>validateAnswers([]),'ADDRESS');
 validateAnswers([{address:'8.8.8.8',family:4},{address:'2606:4700:4700::1111',family:6}]);
 assert.equal(sameAddress('2606:4700::1','2606:4700:0:0:0:0:0:1'),true);assert.equal(sameAddress('127.0.0.1','127.0.0.2'),false);
});
test('queue selected endpoint, exact request and action identities',()=>{
 const id={endpoint:'ideogram/v4/inpaint/lora',requestId:'request_123'};
 assert.equal(queuePath(id,'result'),'/ideogram/v4/inpaint/lora/requests/request_123');
 validateQueueURL('https://queue.fal.run'+queuePath(id,'status'),id,'status');
 for(const raw of ['https://fal.run'+queuePath(id,'status'),'https://queue.fal.run.evil.test'+queuePath(id,'status'),
 'https://queue.fal.run:444'+queuePath(id,'status'),'https://queue.fal.run'+queuePath({...id,requestId:'other'},'status'),
 'https://queue.fal.run'+queuePath(id,'status')+'?logs=1'])assertCode(()=>validateQueueURL(raw,id,'status'),'IDENTITY');
 for(const endpoint of ['ideogram/v4/stream','ideogram/v4/trainer','ideogram/v4/tiling','other'])assertCode(()=>queuePath({endpoint},'submit'),'IDENTITY');
 for(const requestId of ['../x','%2f','x/y','x?secret',''])assertCode(()=>queuePath({...id,requestId},'result'),'IDENTITY');
});
test('URL normalization cannot bypass exact authority',()=>{
 for(const raw of ['http://2130706433/a','https://queue.fal.run:443/a','https://QUEUE.fal.run/a','https://u:p@queue.fal.run/a',
 'https://queue.fal.run/a#fragment','https://queue.fal.run/x/../a',' https://queue.fal.run/a','https://queue.fal.run\\@evil.test/a'])assertCode(()=>exactURL(raw),'IDENTITY');
});
test('RP-1 uses exact fixture minimum and ACL with Store-IO zero',()=>{
 const p=resolvePrivacy(fixtureProfile(),'ideogram/v4','attempt');
 assert.deepEqual(p.headers,{'X-Fal-Store-IO':'0','X-Fal-Object-Lifecycle-Preference':'{"expiration_duration_seconds":60,"initial_acl":"fixture-private"}'});
 assert.equal(p.applied.enforcement,'observed');assert.equal(p.applied.fallbackAcknowledgementId,null);
});
for(const override of [{lifecycleSeconds:30},{lifecycleSeconds:120},{acl:'private-guessed'},{acl:'fixture-public'},{deferredFetch:'unknown'},
 {requiredLifetimeSeconds:61},{enforcement:'unknown'},{deferredFetch:'renewable',renewalQualified:false},{evidenceDigest:'missing'}])test('RP-1 blocks unsupported privacy '+JSON.stringify(override),()=>assertCode(()=>resolvePrivacy(fixtureProfile(override),'ideogram/v4','attempt'),'POLICY'));
test('RP-1 permits qualified renewable lease without guessing unknown queue lifetime',()=>{
 assert.equal(resolvePrivacy(fixtureProfile({deferredFetch:'renewable',requiredLifetimeSeconds:null,renewalQualified:true}),'ideogram/v4','attempt').applied.appliedLifecycleSeconds,60);
});
test('fallback acknowledgement is bound to frozen attempt, profile evidence and disclosure',()=>{
 const p=fixtureProfile({deferredFetch:'unknown',fallback:{id:'fallback1',disclosureDigest:'b'.repeat(64),lifecycleSeconds:120,acl:'fixture-public'}});
 const a={id:'ack1',attemptId:'attempt',profileId:p.id,profileVersion:p.version,evidenceDigest:p.evidenceDigest,fallbackId:'fallback1',disclosureDigest:'b'.repeat(64)};
 assert.equal(resolvePrivacy(p,'ideogram/v4','attempt',a).applied.fallbackAcknowledgementId,'ack1');
 for(const override of [{attemptId:'different'},{profileVersion:2},{evidenceDigest:'c'.repeat(64)},{disclosureDigest:'c'.repeat(64)},{id:''}])assertCode(()=>resolvePrivacy(p,'ideogram/v4','attempt',{...a,...override}),'POLICY');
});
test('production refuses emulator overrides and remains closed until Q09 sealed',()=>{
 let keys=0;const credentials={queueKey(){keys++;throw Error('credential access prohibited');}};
 for(const config of [{emulator:true},{profile:fixtureProfile()},{origin:'http://127.0.0.1:1'},{tls:{rejectUnauthorized:false}},{unexpected:true}])assertCode(()=>createProductionProvider(credentials,config),'POLICY');
 const production=createProductionProvider(credentials);assertCode(()=>production.policy({identity:{endpoint:'ideogram/v4'},attemptId:'a',profileId:'local-fixture-v1'}),'POLICY');
 assertCode(()=>production.media('https://example.com/file',{}),'POLICY');assert.equal(keys,0);assert.deepEqual(PRODUCTION_MEDIA_HOSTS,[]);assert.deepEqual(PRODUCTION_UPLOAD_ORIGINS,[]);
 assert.equal(readFileSync('server/provider/index.ts','utf8').includes('tests/provider'),false);
 assert.equal(readFileSync('tsconfig.server.json','utf8').includes('tests/provider'),false);
 assert.deepEqual(egressAttempts(),[]);
});
test('header ingestion has a narrow value allowlist and never stores credential fields',()=>{
 assert.deepEqual(sanitizedHeaders({'Authorization':'Key sentinel',Cookie:'sentinel','Set-Cookie':'sentinel','FAL_KEY':'sentinel',
 'Content-Type':'application/json','Content-Length':'42','Retry-After':'5',Location:'https://x/?token=sentinel',ETag:'sentinel','X-Error':'sentinel'}),
 {'content-type':'application/json','content-length':'42','retry-after':'5'});
});
test('egress guard permits only literal loopback lookup and traps external attempts before effects',async()=>{
 const dns=await import('node:dns/promises');assert.deepEqual(await dns.lookup('127.0.0.1',{all:true}),[{address:'127.0.0.1',family:4}]);
 const {spawnSync}=await import('node:child_process');
 for(const source of ["import net from 'node:net';net.connect({host:'8.8.8.8',port:443})","import dns from 'node:dns/promises';await dns.lookup('queue.fal.run')"]){
  const result=spawnSync(process.execPath,['--import','./tests/provider/no-egress.mjs','--input-type=module','-e',source],{encoding:'utf8'});
  assert.equal(result.status,1);assert.match(result.stderr,/P2.1 test denied/);assert.match(result.stderr,/denied egress attempts/);
 }
 assert.deepEqual(egressAttempts(),[]);
});
test('production rejects emulator environment flags without reading provider keys',async()=>{
 const {assertProductionEnvironment}=await import('../../dist/local/server/provider/index.js');
 for(const key of ['IDEOGRAM_PROVIDER_EMULATOR','PROVIDER_EMULATOR','FAL_FIXTURE'])assertCode(()=>assertProductionEnvironment({[key]:'false'}),'POLICY');
 assertProductionEnvironment({PATH:'/local'});
});
test('production launcher refuses emulator before private root creation or browser opening',async()=>{
 const {spawnSync}=await import('node:child_process');
 const source="import assert from 'node:assert/strict';import {launch} from './dist/local/tooling/launcher.js';await assert.rejects(launch({root:'/must-not-be-created-p21',openBrowser:async()=>{throw Error('browser must not open')}}),e=>e.code==='POLICY')";
 const result=spawnSync(process.execPath,['--import','./tests/provider/no-egress.mjs','--input-type=module','-e',source],{encoding:'utf8',env:{PATH:process.env.PATH,IDEOGRAM_PROVIDER_EMULATOR:'true'}});
 assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'');
});
