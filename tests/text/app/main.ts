import { TextRenderer, releasePrepared, textMemory } from '../../../src/text/client';
import { planText, engineReservationBytes, engineResidentBytes } from '../../../src/text/memory';
import { loadBundledFont, bundledFonts } from '../../../src/text/bundled-fonts';
import { textIndices, admitRequest } from '../../../src/text/admission';
import { inspectFont } from '../../../src/text/font';
import { paragraphDirection } from '../../../src/text/bidi';
import { hashBytes } from '../../../src/text/contracts';
import type { TextRequest } from '../../../src/text/contracts';
const renderer = new TextRenderer();
let generation = 0;
Object.assign(window, { textFixture: {
  renderer, TextRenderer, releasePrepared, textMemory, planText, engineReservationBytes, engineResidentBytes,
  loadBundledFont, bundledFonts, textIndices, admitRequest, inspectFont, paragraphDirection, hashBytes,
  async heapControl(){
    const worker=new Worker(new URL('./heap-worker.ts',import.meta.url),{type:'module'});
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{worker.terminate();reject(Error('Heap control deadline'));},20000);
      worker.onmessage=event=>{clearTimeout(timer);worker.terminate();resolve(event.data);};
      worker.onerror=event=>{clearTimeout(timer);worker.terminate();reject(Error(event.message));};
    });
  },
  async request(text: string, ids = ['NotoSans'], changes: Partial<TextRequest> = {}) {
    const fonts = await Promise.all(ids.map(id => loadBundledFont(id)));
    return { token: { documentId: 'document-1', documentRevision: '1', layerId: 'layer-1', layerVersion: '1', sessionId: 'session-1', generation: ++generation },
      text, fonts, style: { primaryFont: fonts[0].hash, explicitFallbacks: fonts.slice(1).map(f => f.hash), sizePx: 32,
        lineHeightMultiplier: 1.2, fill: [40,90,190,255], align: 'start', direction: 'auto' }, frame: { width: 360, height: 180 }, ...changes };
  },
  async render(text: string, ids?: string[]) {
    const request = await (window as any).textFixture.request(text, ids), result = await renderer.prepare(request).catch((e:any)=>{throw new Error(e.code+' '+JSON.stringify(e.details));});
    return { ...result, dependencies: result.dependencies.map(({bytes,...d})=>({...d,bytes:bytes.size})),
      textUtf8: await result.textUtf8.text(), layout: JSON.parse(await result.layout.text()), rgba: Array.from(new Uint8Array(await result.rgba.arrayBuffer())),
      frozen: Object.isFrozen(result) && Object.isFrozen(result.dependencies) && Object.isFrozen(result.token), lifecycle: renderer.lifecycle };
  },
} });
