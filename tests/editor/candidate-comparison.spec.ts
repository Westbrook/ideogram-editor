import {test as base,expect} from '@playwright/test';
import {createServer,type ViteDevServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import type {} from './candidate-comparison-app/main.js';

const test=base.extend<{}, {fixtureOrigin:string}>({
  fixtureOrigin:[async({},use,workerInfo)=>{
    let server:ViteDevServer|undefined;
    try{
      server=await createServer({configFile:fileURLToPath(new URL('./candidate-comparison.vite.config.ts',import.meta.url)),cacheDir:resolve(workerInfo.project.outputDir,'vite-cache-'+workerInfo.workerIndex)});
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
function previewPNG(){const width=1024,height=768,header=Buffer.alloc(13),rows=Buffer.alloc((width*4+1)*height);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;for(let y=0;y<height;y++)for(let x=0;x<width;x++){const at=y*(width*4+1)+1+x*4;rows[at]=x%256;rows[at+1]=y%256;rows[at+2]=180;rows[at+3]=255;}const bytes=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);return {bytes:[...bytes],hash:hash(bytes),identity:hash(Buffer.from('retained-original-identity'))};}
test('real public shared zoom transforms both admitted previews, retains dimensions, focus and bounded owners',async({page,fixtureOrigin})=>{
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(fixtureOrigin);await page.waitForFunction(()=>!!window.candidateComparisonFixture);const before=await page.evaluate(()=>window.candidateComparisonFixture.snapshot());await page.evaluate(png=>window.candidateComparisonFixture.prepare(png),previewPNG());
 const pair=page.locator('[data-comparison-pair="source"]');await expect(pair.locator('svg[data-comparison-side]')).toHaveCount(2);await expect(pair.locator('svg[data-comparison-side]').first()).toHaveAttribute('viewBox','0 0 4000 3000');
 const initial=await page.evaluate(()=>window.candidateComparisonFixture.snapshot());expect(initial.reads).toHaveLength(2);expect(initial.reads.every(path=>path.includes('/display?')&&path.includes('edge=1024'))).toBe(true);expect(initial.ownership.imageConsumers).toBe(4);expect(initial.ledger.gpuBytes-before.ledger.gpuBytes).toBe(4*1024*768*4);
 await pair.getByRole('spinbutton',{name:'Source and prepared shared zoom (% of fit)'}).fill('200');await pair.getByRole('button',{name:'Apply shared view',exact:true}).click();for(const side of ['a','b'])await expect(pair.locator(`svg[data-comparison-side="${side}"]`)).toHaveAttribute('viewBox','1000 750 2000 1500');
 await expect(pair.locator('image').first()).toHaveAttribute('width','4000');await expect(pair.locator('image').first()).toHaveAttribute('height','3000');expect((await page.evaluate(()=>window.candidateComparisonFixture.snapshot())).reads).toEqual(initial.reads);
 await pair.getByRole('button',{name:'Pan both right',exact:true}).click();for(const side of ['a','b'])await expect(pair.locator(`svg[data-comparison-side="${side}"]`)).toHaveAttribute('viewBox','1200 750 2000 1500');
 const showB=pair.getByRole('button',{name:'Show B: Prepared replacement',exact:true});await showB.focus();await page.keyboard.press('Enter');await expect(pair.locator('svg[data-comparison-side="b"]')).toHaveCount(1);await expect(showB).toBeFocused();await page.evaluate(()=>window.candidateComparisonFixture.refresh());await expect(showB).toBeFocused();
 const reveal=pair.getByRole('spinbutton',{name:'Source and prepared reveal percentage'});await reveal.fill('25');await reveal.press('Tab');
 await expect(pair.getByRole('status')).toContainText('Reveal 25% B on the left and A on the right');await expect(pair.locator('svg[data-comparison-side="reveal"]')).toHaveAttribute('viewBox','1200 750 2000 1500');
 await expect(pair.locator('clipPath rect').first()).toHaveAttribute('x','1000');await expect(pair.locator('clipPath rect').first()).toHaveAttribute('width','3000');await expect(pair.locator('clipPath rect').last()).toHaveAttribute('width','1000');
 expect((await page.evaluate(()=>window.candidateComparisonFixture.snapshot())).reads).toEqual(initial.reads);await showB.click();await expect(pair.locator('svg[data-comparison-side="b"]')).toHaveCount(1);
 await pair.getByRole('spinbutton',{name:'Source and prepared shared zoom (% of fit)'}).fill('0');await pair.getByRole('button',{name:'Apply shared view',exact:true}).click();await expect(pair.getByRole('alert')).toContainText('25');await expect(pair.locator('svg[data-comparison-side="b"]')).toHaveAttribute('viewBox','1200 750 2000 1500');
 const cleared=await page.evaluate(()=>window.candidateComparisonFixture.clear());expect(cleared.ownership).toMatchObject({activeReads:0,previewURLs:0,imageConsumers:0,cleanupFailures:0});expect(cleared.ledger).toEqual(before.ledger);expect(errors).toEqual([]);
});
