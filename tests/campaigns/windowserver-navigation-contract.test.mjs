import test from 'node:test';
import assert from 'node:assert/strict';
import {joinNavigationWindowServerPixels, navigationNativeUpper, nativeNavigationConfiguration, validateNavigationOracle}
  from '../../tooling/qualification/campaigns/windowserver-navigation-contract.mjs';
import {windowServerNavigationSpecimen, sha, json} from './support/windowserver-navigation-specimen.mjs';

// These helpers reseal only in-memory protocol specimens. They never run a
// collector or claim that synthetic pixels are reviewed physical evidence.
const ndjson=rows=>Buffer.from(rows.map(row=>JSON.stringify(row)+'\n').join(''));
const pin=(path,bytes)=>({path,bytes:bytes.length,sha256:sha(bytes)});
const copyRaw=value=>({manifestBytes:Buffer.from(value.manifestBytes),framesBytes:Buffer.from(value.framesBytes),
  pixels:new Map([...value.pixels].map(([path,bytes])=>[path,Buffer.from(bytes)]))});
function joinInput(f,endpoint='shell'){
  const directory=f.oracleFolders[endpoint],oracleBytes=Buffer.from(f.members.get(directory+'/oracle.json'));
  return {raw:{anchor:copyRaw(f.rawCaptures.anchor),target:copyRaw(f.rawCaptures[endpoint])},
    options:{endpoint,oracleBytes,oracleSha256:sha(oracleBytes),
      oraclePixels:new Map(['before.bgra','after.bgra'].map(path=>[path,Buffer.from(f.members.get(directory+'/'+path))])),
      anchor:structuredClone(f.observation.anchor),readiness:structuredClone(f.observation.readiness[endpoint]),binding:structuredClone(f.observation.binding)}};
}
function resealCapture(raw,change){
  const manifest=JSON.parse(raw.manifestBytes),rows=raw.framesBytes.toString('utf8').trimEnd().split('\n').map(JSON.parse);
  change({manifest,rows,pixels:raw.pixels});
  raw.framesBytes=ndjson(rows);manifest.frames=pin('frames.ndjson',raw.framesBytes);
  manifest.pixelFiles=[...raw.pixels].map(([path,bytes])=>pin(path,bytes));
  const samples=rows.filter(row=>row.event==='sample');
  manifest.counts={sampleRecords:samples.length,completeFrames:samples.filter(row=>row.file!==null).length,
    clockRecords:rows.filter(row=>row.event==='clock').length,pixelBytes:[...raw.pixels.values()].reduce((sum,bytes)=>sum+bytes.length,0),
    unretainedSamples:samples.filter(row=>row.file===null).length};
  raw.manifestBytes=json(manifest);
}
function resealOracle(input,change){
  const oracle=JSON.parse(input.options.oracleBytes);change(oracle,input.options.oraclePixels);
  input.options.oracleBytes=json(oracle);input.options.oracleSha256=sha(input.options.oracleBytes);return oracle;
}
const joined=input=>joinNavigationWindowServerPixels(input.raw,input.options);
const selected=input=>nativeNavigationConfiguration(input.options.binding.selection,input.options.binding.browser,
  {cell:{workload:input.options.binding.attempt.workload},sample:{cache:input.options.binding.attempt.cache}});
const validateOracle=input=>validateNavigationOracle(JSON.parse(input.options.oracleBytes),input.options.oraclePixels,
  {endpoint:input.options.endpoint,selection:selected(input),environment:input.options.binding.environment,attempt:input.options.binding.attempt});

test('native bounds round upward to whole microseconds using exact lossless ticks',()=>{
  assert.equal(navigationNativeUpper('0','0',{numer:1,denom:1}),0);
  assert.equal(navigationNativeUpper('0','1',{numer:1,denom:1}),0.001);
  assert.equal(navigationNativeUpper('0','1000',{numer:1,denom:1}),0.001);
  assert.equal(navigationNativeUpper('0','1001',{numer:1,denom:1}),0.002);
  assert.equal(navigationNativeUpper('0','3001',{numer:1,denom:3}),0.002);
  assert.equal(navigationNativeUpper('18446744073709551614','18446744073709551615',{numer:1,denom:1}),0.001);
});
test('native arithmetic rejects reversed, lossy, overflowing and malformed clocks',()=>{
  for(const [start,end,timebase] of [
    ['2','1',{numer:1,denom:1}],['01','2',{numer:1,denom:1}],['0','1.5',{numer:1,denom:1}],
    ['0','18446744073709551616',{numer:1,denom:1}],['0','1',{numer:0,denom:1}],['0','1',{numer:1,denom:0}],
    ['0','1',{numer:1,denom:0.5}],['0','1',{numer:Number.MAX_SAFE_INTEGER+1,denom:1}],
    ['0','18446744073709551615',{numer:1,denom:1}],
  ])assert.throws(()=>navigationNativeUpper(start,end,timebase));
});
test('semantic bound uses the later native frame or public readiness ACK and never invents exact latency',async t=>{
  const f=await windowServerNavigationSpecimen(t),normal=joined(joinInput(f));
  assert.equal(normal.upperBoundMs,50);assert.equal(normal.nativeUpperEndpoint,'60000000');
  const laterFrame=joinInput(f);
  resealCapture(laterFrame.raw.target,({manifest,rows})=>{
    const frame=rows.find(row=>row.event==='sample');frame.displayTimeMach='70000000';frame.callbackMach='70500000';frame.windowObservationMach='70500001';
    manifest.endedMach='71000000';rows.sort((a,b)=>Number(BigInt(a.mach??a.windowObservationMach)-BigInt(b.mach??b.windowObservationMach)));
  });
  const frameBound=joined(laterFrame);assert.equal(frameBound.upperBoundMs,60);assert.equal(frameBound.nativeUpperEndpoint,'70000000');
  const laterAck=joinInput(f);laterAck.options.readiness.ack.mach='80000000';
  resealCapture(laterAck.raw.target,({manifest,rows})=>{rows.find(row=>row.event==='clock').mach='80000000';manifest.endedMach='81000000';});
  const readyBound=joined(laterAck);assert.equal(readyBound.upperBoundMs,70);assert.equal(readyBound.nativeUpperEndpoint,'80000000');
  for(const value of [normal,frameBound,readyBound]){
    assert.equal(value.status,'observed');assert.equal(value.qualification,false);assert.equal(value.exactLatencyMs,null);
    assert.equal(value.physicalScanout,'unavailable');assert.equal(value.firstPresentedFrameCoverage,'unavailable');
  }
});
test('navigation requires owned requested-stop even when a capped stream contains matching pixels',async t=>{
  const f=await windowServerNavigationSpecimen(t);assert.equal(joined(joinInput(f)).status,'observed');
  for(const stage of ['anchor','target'])for(const terminalReason of ['stdin-eof','duration-limit','frame-limit','pixel-byte-limit']){
    const input=joinInput(f);resealCapture(input.raw[stage],({manifest})=>{manifest.terminalReason=terminalReason;});
    assert.throws(()=>joined(input),/exhausted|owned request/,stage+':'+terminalReason);
  }
});
test('pure native joins independently bind oracle manifests, semantic pixels and native frame bytes',async t=>{
  const f=await windowServerNavigationSpecimen(t);
  for(const change of [
    input=>{input.options.oracleSha256='0'.repeat(64);},
    input=>{input.options.oracleBytes=Buffer.concat([input.options.oracleBytes,Buffer.from(' ')]);},
    input=>{input.options.oraclePixels.get('after.bgra')[0]^=1;},
    input=>{input.raw.target.pixels.get('frame-1.bgra')[0]^=1;},
    input=>{input.raw.target.framesBytes=Buffer.concat([input.raw.target.framesBytes,Buffer.from('\n')]);},
  ]){const input=joinInput(f);change(input);assert.throws(()=>joined(input));}
});
test('a smaller complete canvas reserves and joins its actual ROI rather than a full viewport frame',async t=>{
  const f=await windowServerNavigationSpecimen(t),input=joinInput(f,'canvas');
  input.options.binding.selection.capture.canvas.maxBytes=4;
  const roi={x:5,y:3,width:1,height:1};
  const oracle=resealOracle(input,(value,pixels)=>{
    value.roi=roi;value.coverage.cssRectangle={x:1,y:0,width:1,height:1};
    for(const name of ['before','after']){
      const path=name+'.bgra',bytes=Buffer.from(pixels.get(path).subarray(4,8));pixels.set(path,bytes);
      value[name]={...value[name],...pin(path,bytes)};
    }
  });
  input.options.binding.selection.profiles[0].canvas.sha256=input.options.oracleSha256;
  input.options.readiness.witness.viewport={...input.options.readiness.witness.viewport,x:1,y:0,width:1,height:1};
  resealCapture(input.raw.target,({manifest,rows,pixels})=>{
    manifest.config.roi=roi;manifest.config.maxBytes=4;manifest.windowAdmission.roiPoints={...roi};
    const bytes=Buffer.from(pixels.get('frame-1.bgra').subarray(4,8));pixels.set('frame-1.bgra',bytes);
    const frame=rows.find(row=>row.event==='sample');frame.roi=roi;frame.byteLength=bytes.length;frame.sha256=sha(bytes);
  });
  const configuration=selected(input);assert.equal(configuration.configs.canvas.maxBytes,4);
  assert.equal(Object.hasOwn(configuration.configs.canvas,'roi'),false);
  assert.equal(configuration.capturePlan.maxPixelBytes,68);assert.equal(configuration.capturePlan.reservedPixelBytes,96);
  assert.equal(validateOracle(input),true);assert.deepEqual(oracle.coverage.cssRectangle,{x:1,y:0,width:1,height:1});
  const value=joined(input);assert.equal(value.status,'observed');assert.equal(value.upperBoundMs,250);
});
test('actual canvas ROI, whole shell coverage and total reservation cannot exceed their selected bounds',async t=>{
  const f=await windowServerNavigationSpecimen(t),smallBudget=joinInput(f,'canvas');
  // Initial configuration can validate a 1px placeholder, but the sealed 2px
  // canvas is independently rejected before any capture can be admitted.
  smallBudget.options.binding.selection.capture.canvas.maxBytes=4;
  assert.equal(selected(smallBudget).configs.canvas.maxBytes,4);
  assert.throws(()=>validateOracle(smallBudget));
  const total=joinInput(f,'canvas');total.options.binding.selection.maxTotalBytes=95;
  assert.throws(()=>selected(total),/reservation/);
  const zero=joinInput(f,'canvas');zero.options.binding.selection.profiles[0].roi.width=0;
  assert.throws(()=>selected(zero),/pixel rectangle/);
  const partialShell=joinInput(f,'shell');
  resealOracle(partialShell,(value,pixels)=>{
    value.roi={...value.roi,width:1};value.coverage.cssRectangle.width=1;
    for(const name of ['before','after']){
      const path=name+'.bgra',bytes=Buffer.from(pixels.get(path).subarray(0,4));pixels.set(path,bytes);
      value[name]={...value[name],...pin(path,bytes)};
    }
  });
  assert.throws(()=>validateOracle(partialShell),/excludes meaningful shell pixels/);
  const outside=joinInput(f,'canvas');
  resealOracle(outside,value=>{value.roi={...value.roi,x:6};});
  assert.throws(()=>validateOracle(outside),/outside full browser viewport/);
});
