import { openSync, writeSync, closeSync } from 'node:fs';

// Bound memory by each pipe chunk; disk failure cancels the same owned child
// tree and is reported only after its bounded cleanup has completed.
export function createGateLog(path, external, { write = writeSync } = {}) {
  const fd = openSync(path, 'wx', 0o600), controller = new AbortController();
  let failure, closed = false;
  const relay = () => controller.abort(external.reason);
  external?.addEventListener('abort', relay, { once: true });
  if (external?.aborted) relay();
  const fail = error => { failure ??= error; controller.abort('Qualification log write failed: ' + String(error)); };
  return {
    signal: controller.signal,
    get error() { return failure; },
    append(chunk) {
      if (failure || closed) return;
      try {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        for (let offset = 0; offset < bytes.length;) {
          const count = write(fd, bytes, offset, bytes.length - offset);
          if (!Number.isSafeInteger(count) || count <= 0) throw Error('Log write made no progress');
          offset += count;
        }
      } catch (error) { fail(error); }
    },
    close() {
      if (closed) return;
      closed = true; external?.removeEventListener('abort', relay);
      try { closeSync(fd); } catch (error) { fail(error); }
    },
  };
}
