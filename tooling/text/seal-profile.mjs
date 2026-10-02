import {readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
const sha=b=>createHash('sha256').update(b).digest('hex');
const profile=JSON.parse(await readFile('src/text/profile.json','utf8'));
delete profile.id;
profile.fontProfile='static regular upright normal-width TTF/CFF1 OTF; complete unmodified files; face index0';
profile.lineHeightPolicy='largest supplied font metric span times multiplier; symmetric leading; native rounded baselines';
profile.memory={wasmDeclaredInitialBytes:16777216,wasmDeclaredMaximumBytes:33554432,
  aggregateFontShapingCeilingQualified:false,
  admission:'shared realm preallocation R35 128MiB within R18 512MiB; MEMORY.txt exact model',
  ownership:'booked reusable worker; <=16 retained exact native faces; bounded latest queue and one cold cache-capacity retry; successful terminate releases private leases once, caller/prepared leases remain; actual API failure retains uncertain capacity',
  integration:'durable-state-v1: one realm envelope shared with sole writer font/raster admission; exact output consumption and release',
  limitation:'logical owned-allocation reservations and process admission guards; no RSS/P3 qualification'};
profile.rasterProfile='ck040-custom3-cpu-rgba8888-unpremul-srgb-transparent-zero-1';
profile.unicode.unicodeDataHash='sha256:c12537022ef818991a7bfed41a76d8d6ae962ffbc0e6511ac762a5d0845e7f7c';
profile.unicode.unicodeDataHashScope='actual pinned ICU flutter/icudtl.dat compiled into custom WASM';
profile.sourceRecipe=[];
// Retain the last stable-frame streamed renderer before the ownership change.
const ownershipPriorPath='src/text/retained-profiles/4fd6f6a1.json',ownershipPriorBytes=await readFile(ownershipPriorPath);
profile.sourceRecipe.push({path:ownershipPriorPath,bytes:ownershipPriorBytes.length,sha256:sha(ownershipPriorBytes)});
// Preserve the exact renderer manifest used before the integrated source reseal.
// Core and verification keep its normalized frame bytes and streaming budget.
const integrationPriorPath='src/text/retained-profiles/68efa85f.json',integrationPriorBytes=await readFile(integrationPriorPath);
profile.sourceRecipe.push({path:integrationPriorPath,bytes:integrationPriorBytes.length,sha256:sha(integrationPriorBytes)});
// Preserve the streamed renderer before the combined CPU observer source change.
const combinedCPUPriorPath='src/text/retained-profiles/6d77f925.json',combinedCPUPriorBytes=await readFile(combinedCPUPriorPath);
profile.sourceRecipe.push({path:combinedCPUPriorPath,bytes:combinedCPUPriorBytes.length,sha256:sha(combinedCPUPriorBytes)});
// Preserve the stable streamed renderer before complete adapter ownership hooks.
const adapterOwnershipPriorPath='src/text/retained-profiles/c6ca02c2.json',adapterOwnershipPriorBytes=await readFile(adapterOwnershipPriorPath);
profile.sourceRecipe.push({path:adapterOwnershipPriorPath,bytes:adapterOwnershipPriorBytes.length,sha256:sha(adapterOwnershipPriorBytes)});
// Preserve the stable streamed renderer before local JSON response framing changes.
const httpFramingPriorPath='src/text/retained-profiles/1c399d52.json',httpFramingPriorBytes=await readFile(httpFramingPriorPath);
profile.sourceRecipe.push({path:httpFramingPriorPath,bytes:httpFramingPriorBytes.length,sha256:sha(httpFramingPriorBytes)});
// Preserve the stable streamed renderer before deferring exact manifest loading.
const deferredManifestPriorPath='src/text/retained-profiles/e648eede.json',deferredManifestPriorBytes=await readFile(deferredManifestPriorPath);
profile.sourceRecipe.push({path:deferredManifestPriorPath,bytes:deferredManifestPriorBytes.length,sha256:sha(deferredManifestPriorBytes)});
// Preserve the stable streamed renderer before selecting startup profile fields.
const startupProfilePriorPath='src/text/retained-profiles/891a4688.json',startupProfilePriorBytes=await readFile(startupProfilePriorPath);
profile.sourceRecipe.push({path:startupProfilePriorPath,bytes:startupProfilePriorBytes.length,sha256:sha(startupProfilePriorBytes)});
// Retain the exact profile before eager reservation-source binding and R35 observation.
const textResourcesPriorPath='src/text/retained-profiles/b96236b0.json',textResourcesPriorBytes=await readFile(textResourcesPriorPath);
profile.sourceRecipe.push({path:textResourcesPriorPath,bytes:textResourcesPriorBytes.length,sha256:sha(textResourcesPriorBytes)});
for(const path of ['src/observability/diagnostic-memory.ts','tooling/text/source-closure.json','tooling/text/configure-source.py','tooling/text/canvaskit-source.patch','tooling/text/rebuild.py','tooling/text/MEMORY.txt','server/static.ts','server/http.ts','server/storage/text.ts','server/text/font.ts','server/text/worker.ts','server/text/supervisor.ts','server/observability/adapter-resources.ts','server/text/validation.ts','server/text/render-worker.mjs','tests/text-state/verifier.vite.config.ts','tooling/text/verifier.vite.config.ts','src/protocol/text-budget.ts','src/observability/phases.ts','src/observability/browser-worker-observations.ts','src/text/retained-profiles/b89503d3.json','src/protocol/text.ts','src/text/retained-profiles/c19791ae.json','src/text/retained-profiles/6e8a481e.json','src/text/retained-profiles/d047f5be.json','src/text/retained-profiles/304528c9.json','src/text/retained-profiles/ff24a513.json','src/text/retained-profiles/f5e8bd34.json','src/text/retained-profiles/7a4dbc6c.json']){
  const b=await readFile(path);profile.sourceRecipe.push({path,bytes:b.length,sha256:sha(b)});
}
profile.notices=[];
for(const name of (await readdir('vendor/text/notices')).sort()){
  const path='vendor/text/notices/'+name,b=await readFile(path);
  profile.notices.push({path,bytes:b.length,sha256:sha(b)});
}
profile.adapterSources=[];
for(const name of (await readdir('src/text')).sort().filter(n=>n.endsWith('.ts')||n==='bidi-data.json')){
  const path='src/text/'+name,b=await readFile(path);
  profile.adapterSources.push({path,bytes:b.length,sha256:sha(b)});
}
profile.typeCompatibility={path:'vendor/text/canvaskit.d.ts',sha256:sha(await readFile('vendor/text/canvaskit.d.ts')),
  change:'Only upstream triple-slash WebGPU reference replaced by comment; TypeScript7 lib.dom already supplies WebGPU declarations. Common upstream declarations unchanged; custom APIs are explicitly typed in the adapter.'};
profile.id='sha256:'+sha(JSON.stringify(profile));
for(const path of ['src/text/profile.json','vendor/text/manifest.json'])await writeFile(path,JSON.stringify(profile,null,2)+'\n');
const files=[];
for(const directory of ['tooling/text','vendor/text']){
  async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){
    const path=dir+'/'+e.name;if(e.isDirectory())await walk(path);
    else if(!path.endsWith('/FILES.json')){const b=await readFile(path);files.push({path,bytes:b.length,sha256:sha(b)});}
  }}
  await walk(directory);
}
await writeFile('vendor/text/FILES.json',JSON.stringify(files.sort((a,b)=>a.path.localeCompare(b.path)),null,2)+'\n');
console.log(JSON.stringify({profile:profile.id,fonts:profile.fonts.reduce((n,f)=>n+f.bytes,0),
  customLazyEngineRaw:profile.engine.js.bytes+profile.engine.wasm.bytes,
  customLazyEngineGzip:profile.engine.js.gzipBytes+profile.engine.wasm.gzipBytes,
  qualified:false},null,2));
