import { createTextEngine, prepareText } from './engine';
import { TextFailure } from './contracts';
import type { TextRequest } from './contracts';
const scope = self as unknown as { onmessage: ((event: MessageEvent<TextRequest>) => void) | null;
  postMessage(value: unknown): void; close(): void };
let started = false;
const engine = createTextEngine();
engine.then(() => scope.postMessage({ ready: true }), error => scope.postMessage({ ok: false, fatal: true,
  code: 'TEXT_ENGINE_LOAD', details: String(error) }));
scope.onmessage = async event => {
  if (started) return; started = true;
  try { scope.postMessage({ ok: true, value: await prepareText(event.data, await engine) }); }
  catch (error) { scope.postMessage({ ok: false, code: error instanceof TextFailure ? error.code :
    error instanceof RangeError && error.message === 'TEXT_NATIVE_ALLOCATION' ? 'TEXT_NATIVE_CAPACITY' : 'TEXT_WORKER_FAILURE',
    fatal: !(error instanceof TextFailure), details: error instanceof TextFailure ? error.details : String(error) }); }
  finally { started = false; }
};
