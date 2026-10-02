import {test as base,expect} from '@playwright/test';
import {createServer,type ViteDevServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import type {} from './display-image-app/main.js';

const test=base.extend<{}, {fixtureOrigin:string}>({
  fixtureOrigin:[async({},use,workerInfo)=>{
    let server:ViteDevServer|undefined;
    try{
      server=await createServer({configFile:fileURLToPath(new URL('./display-image.vite.config.ts',import.meta.url)),cacheDir:resolve(workerInfo.project.outputDir,'vite-cache-'+workerInfo.workerIndex)});
      await server.listen();
      const address=server.httpServer?.address();
      if(!address||typeof address==='string'||address.address!=='127.0.0.1'||!Number.isInteger(address.port)||address.port<=0||address.port>65535)throw new Error('Owned fixture server did not expose a bound loopback TCP port');
      await use('http://127.0.0.1:'+address.port);
    }finally{await server?.close();}
  },{scope:'worker',timeout:30_000}],
});

const hash=(bytes:Uint8Array)=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
function crc32(bytes:Uint8Array){let value=0xffffffff;for(const byte of bytes){value^=byte;for(let bit=0;bit<8;bit++)value=(value>>>1)^((value&1)?0xedb88320:0);}return(value^0xffffffff)>>>0;}
function chunk(type:string,payload:Buffer){const result=Buffer.alloc(payload.length+12);result.writeUInt32BE(payload.length);result.write(type,4,'ascii');payload.copy(result,8);result.writeUInt32BE(crc32(result.subarray(4,-4)),result.length-4);return result;}
function rgbaPNG(){
  const pixels=Buffer.from([24,128,232,255]),header=Buffer.alloc(13);header.writeUInt32BE(1);header.writeUInt32BE(1,4);header[8]=8;header[9]=6;
  const bytes=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.concat([Buffer.from([0]),pixels]))),chunk('IEND',Buffer.alloc(0))]);
  return {bytes:[...bytes],hash:hash(bytes),identity:hash(pixels)};
}

test('real Lit disconnection restores native decoding and HTML/SVG aliases own independent RGBA allowances',async({page,fixtureOrigin})=>{
  const pageErrors:string[]=[];page.on('pageerror',error=>pageErrors.push(error.message));
  await page.goto(fixtureOrigin);await page.waitForFunction(()=>!!window.displayImageFixture);
  const baseline=await page.evaluate(()=>window.displayImageFixture.snapshot());
  expect(baseline.ownership).toMatchObject({activeReads:0,previewURLs:0,imageConsumers:0,cleanupFailures:0});
  const png=rgbaPNG(),prepared=await page.evaluate(input=>window.displayImageFixture.prepare(input),png);
  expect(prepared.ownership).toMatchObject({activeReads:0,previewURLs:1,imageConsumers:0,cleanupFailures:0});
  expect(prepared.requests).toHaveLength(1);expect(prepared.requests[0]).toContain('/api/v1/assets/fixture-rgba/display?');
  // The live URL retains its encoded PNG plus a fixed8KiB logical allowance
  // for the descriptor/source/URL/registry. Both retire only on actual revoke.
  // Keep this independent oracle explicit rather than importing the producer.
  const residentCPU=png.bytes.length+8*1024;
  expect(prepared.ledger.cpuBytes-baseline.ledger.cpuBytes).toBe(residentCPU);
  expect(prepared.ledger.blob).toEqual({...baseline.ledger.blob,
    cpuBytes:baseline.ledger.blob.cpuBytes+residentCPU,
    previewCacheBytes:baseline.ledger.blob.previewCacheBytes+png.bytes.length,
    handles:baseline.ledger.blob.handles+2});
  expect(prepared.ledger.previewCacheBytes-baseline.ledger.previewCacheBytes).toBe(png.bytes.length);
  expect(prepared.ledger.handles-baseline.ledger.handles).toBe(2);
  expect(prepared.ledger.activeRecords-baseline.ledger.activeRecords).toBe(1);
  expect(prepared.ledger.gpuBytes).toBe(baseline.ledger.gpuBytes);
  expect(prepared.ledger.bitmap).toEqual(baseline.ledger.bitmap);
  const mounted=await page.evaluate(()=>window.displayImageFixture.mount('html'));
  expect(mounted.src).toBe(prepared.url);expect(mounted.ownership.imageConsumers).toBe(1);
  expect(await page.evaluate(()=>window.displayImageFixture.decodeHTML())).toEqual([{width:1,height:1,src:prepared.url}]);
  expect(mounted.ledger.cpuBytes-prepared.ledger.cpuBytes).toBe(4+256);
  expect(mounted.ledger.gpuBytes-prepared.ledger.gpuBytes).toBe(4);
  expect(mounted.ledger.previewCacheBytes-prepared.ledger.previewCacheBytes).toBe(8);
  expect(mounted.ledger.handles-prepared.ledger.handles).toBe(2);

  const aliases=await page.evaluate(()=>window.displayImageFixture.mount('aliases'));
  expect(aliases.src).toBe(prepared.url);expect(aliases.href).toBe(prepared.url);expect(aliases.ownership.imageConsumers).toBe(2);
  expect(aliases.ledger.cpuBytes-prepared.ledger.cpuBytes).toBe(2*(4+256));
  expect(aliases.ledger.gpuBytes-prepared.ledger.gpuBytes).toBe(2*4);
  expect(aliases.ledger.previewCacheBytes-prepared.ledger.previewCacheBytes).toBe(2*8);
  expect(aliases.ledger.handles-prepared.ledger.handles).toBe(2*2);
  await expect.poll(()=>page.evaluate(()=>window.displayImageFixture.snapshot().svgLoads)).toBeGreaterThanOrEqual(1);
  const firstSVGLoads=await page.evaluate(()=>window.displayImageFixture.snapshot().svgLoads);

  const disconnected=await page.evaluate(()=>window.displayImageFixture.connected(false));
  expect(disconnected.sameHTML).toBe(true);expect(disconnected.sameSVG).toBe(true);
  expect(disconnected.src).toBeNull();expect(disconnected.href).toBeNull();expect(disconnected.ownership.imageConsumers).toBe(0);
  expect(disconnected.ledger).toEqual(prepared.ledger);
  const reconnected=await page.evaluate(()=>window.displayImageFixture.connected(true));
  expect(reconnected.sameHTML).toBe(true);expect(reconnected.sameSVG).toBe(true);
  expect(reconnected.src).toBe(prepared.url);expect(reconnected.href).toBe(prepared.url);
  expect(reconnected.ownership.imageConsumers).toBe(2);expect(reconnected.ledger).toEqual(aliases.ledger);
  // Require a successful native decode of the restored DOM attribute as well
  // as its newly admitted consumer reservation.
  expect(await page.evaluate(()=>window.displayImageFixture.decodeHTML())).toEqual([{width:1,height:1,src:prepared.url}]);
  await expect.poll(()=>page.evaluate(()=>window.displayImageFixture.snapshot().svgLoads)).toBeGreaterThan(firstSVGLoads);

  const removedHTML=await page.evaluate(()=>window.displayImageFixture.mount('svg'));
  expect(removedHTML.htmlCount).toBe(0);expect(removedHTML.svgCount).toBe(1);expect(removedHTML.ownership.imageConsumers).toBe(1);
  expect(removedHTML.ledger).toEqual(mounted.ledger);
  const removedBoth=await page.evaluate(()=>window.displayImageFixture.mount('empty'));
  expect(removedBoth.htmlCount).toBe(0);expect(removedBoth.svgCount).toBe(0);expect(removedBoth.ownership.imageConsumers).toBe(0);
  expect(removedBoth.ledger).toEqual(prepared.ledger);

  const beforeRemountLoads=removedBoth.svgLoads;
  await page.evaluate(()=>window.displayImageFixture.mount('aliases'));
  await page.evaluate(()=>window.displayImageFixture.decodeHTML());
  await expect.poll(()=>page.evaluate(()=>window.displayImageFixture.snapshot().svgLoads)).toBeGreaterThan(beforeRemountLoads);
  const revoked=await page.evaluate(()=>window.displayImageFixture.revoke());
  expect(revoked.src).toBeNull();expect(revoked.href).toBeNull();expect(revoked.ownership).toEqual(baseline.ownership);expect(revoked.ledger).toEqual(baseline.ledger);
  await page.evaluate(()=>window.displayImageFixture.connected(false));
  const retiredReconnect=await page.evaluate(()=>window.displayImageFixture.connected(true));
  expect(retiredReconnect.src).toBeNull();expect(retiredReconnect.href).toBeNull();expect(retiredReconnect.ledger).toEqual(baseline.ledger);
  const cleared=await page.evaluate(()=>window.displayImageFixture.clear());
  expect(cleared.errors).toEqual([]);expect(cleared.ownership).toEqual(baseline.ownership);expect(cleared.ledger).toEqual(baseline.ledger);expect(pageErrors).toEqual([]);
});
