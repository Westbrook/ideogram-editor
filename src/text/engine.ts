import CanvasKitInit from 'canvaskit-wasm';
import wasmUrl from 'canvaskit-wasm/bin/canvaskit.wasm?url';
import profile from './profile.json';
import { fail, hashBytes, readSealedAsset } from './contracts';
import type { Kit } from './core';
export { prepareText } from './core';

export async function createTextEngine(): Promise<Kit> {
  const url = new URL(wasmUrl, location.href);
  if (url.origin !== location.origin) fail('TEXT_ENGINE_ORIGIN');
  const bytes = await (await readSealedAsset(url, profile.engine.wasm.bytes)).arrayBuffer();
  if (bytes.byteLength !== profile.engine.wasm.bytes || await hashBytes(bytes) !== 'sha256:' + profile.engine.wasm.sha256) fail('TEXT_ENGINE_HASH');
  const module = await WebAssembly.compile(bytes);
  const memoryName = WebAssembly.Module.exports(module).find(e => e.kind === 'memory')?.name;
  if (!memoryName) fail('TEXT_ENGINE_ABI');
  const options = {
    locateFile: () => url.href,
    instantiateWasm(importObject: WebAssembly.Imports, receive: (instance: WebAssembly.Instance) => void) {
      const instance = new WebAssembly.Instance(module, importObject);
      const memory = instance.exports[memoryName] as WebAssembly.Memory;
      if (memory.buffer.byteLength !== 16 * 1024 ** 2) fail('TEXT_HEAP_PROFILE');
      receive(instance); return instance.exports;
    },
  };
  const kit = await CanvasKitInit(options) as Kit;
  if (kit.ParagraphBuilder.RequiresClientICU()) fail('TEXT_UNICODE_PROFILE');
  return kit;
}

