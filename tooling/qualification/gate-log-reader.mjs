import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open, lstat} from 'node:fs/promises';
import {StringDecoder} from 'node:string_decoder';

const FIELDS = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
const PREFIXES = FIELDS.map(field => '# ' + field + ' ');
export const LOG_READ_CHUNK_BYTES = 65536;
// Finite summary-line state: no pending line or diagnostic payload is retained.
// StringDecoder handles UTF-8 split across chunks; each decoded chunk is bounded
// by its caller. Every byte still belongs to the independently computed log hash.
export function createTapCounter() {
  const decoder = new StringDecoder('utf8'), values = {};
  let prefix = '', field = null, digits = '', mode = 'prefix', invalid = false, closed = false;
  const reset = () => { prefix = ''; field = null; digits = ''; mode = 'prefix'; };
  const finishLine = () => {
    if ((mode === 'digits' || mode === 'space') && digits) {
      const value = Number(digits);
      if (!Number.isSafeInteger(value)) { values[field] = null; invalid = true; }
      else values[field] = value;
    } else if (mode === 'overflow') { values[field] = null; invalid = true; }
    reset();
  };
  function segment(text) {
    let offset = 0;
    while (offset < text.length && mode === 'prefix') {
      prefix += text[offset++];
      const found = PREFIXES.indexOf(prefix);
      if (found !== -1) { field = FIELDS[found]; mode = 'digits'; }
      else if (!PREFIXES.some(value => value.startsWith(prefix))) mode = 'ignore';
    }
    while (offset < text.length && mode === 'digits') {
      const character = text[offset];
      if (character >= '0' && character <= '9') { offset++; if (digits === '0') digits = ''; if (digits.length < 16) digits += character; else mode = 'overflow'; }
      else { mode = digits && /\s/u.test(character) ? 'space' : 'ignore'; }
    }
    // Oversized numeric text is invalid only if the rest of the line is a
    // numeric footer, not an unrelated comment such as '# tests 123... title'.
    if (mode === 'overflow') {
      const rest = text.slice(offset);
      const match = /^[0-9]*/.exec(rest)[0]; offset += match.length;
      if (offset < text.length) mode = /^\s*$/u.test(text.slice(offset)) ? 'overflow-space' : 'ignore';
    } else if (mode === 'overflow-space' && !/^\s*$/u.test(text.slice(offset))) mode = 'ignore';
    else if (mode === 'space' && !/^\s*$/u.test(text.slice(offset))) mode = 'ignore';
  }
  function decoded(text) {
    let offset = 0, match; const terminator = /[\n\r\u2028\u2029]/g;
    while ((match = terminator.exec(text)) !== null) {
      segment(text.slice(offset, match.index));
      if (mode === 'overflow-space') mode = 'overflow';
      finishLine(); offset = terminator.lastIndex;
    }
    segment(text.slice(offset));
  }
  return {
    append(bytes) { if (closed) throw Error('TAP counter closed'); decoded(decoder.write(bytes)); },
    finish() {
      if (closed) throw Error('TAP counter closed'); closed = true; decoded(decoder.end());
      if (mode === 'overflow-space') mode = 'overflow';
      finishLine();
      return {counts: Object.fromEntries(FIELDS.filter(field => Object.hasOwn(values, field)).map(field => [field, values[field]])), error: invalid ? 'TAP summary contains an unsafe integer' : null};
    },
  };
}
export function summarizeLogBytes(bytes) {
  const counter = createTapCounter(), digest = createHash('sha256');
  for (let offset = 0; offset < bytes.length; offset += LOG_READ_CHUNK_BYTES) { const chunk = bytes.subarray(offset, offset + LOG_READ_CHUNK_BYTES); digest.update(chunk); counter.append(chunk); }
  return {bytes: bytes.length, sha256: digest.digest('hex'), ...counter.finish()};
}
const stamp = value => [value.dev, value.ino, value.mode, value.nlink, value.size, value.mtimeNs, value.ctimeNs].map(String).join(':');
// Same held-file, no-follow, asynchronous 64KiB read pattern as evidence-volume
// fileIdentity, with parsing on the exact bytes hashed in this one traversal.
export async function readGateLog(path) {
  const before = await lstat(path, {bigint: true});
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('Regular bounded-size gate log required');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK), digest = createHash('sha256'), counter = createTapCounter(), buffer = Buffer.alloc(LOG_READ_CHUNK_BYTES);
  try {
    if (stamp(await handle.stat({bigint: true})) !== stamp(before)) throw Error('Gate log changed before read');
    let bytes = 0, remaining = Number(before.size);
    while (remaining) { const read = await handle.read(buffer, 0, Math.min(buffer.length, remaining), null); if (!read.bytesRead) throw Error('Gate log shortened during read'); const chunk = buffer.subarray(0, read.bytesRead); digest.update(chunk); counter.append(chunk); bytes += read.bytesRead; remaining -= read.bytesRead; }
    if ((await handle.read(buffer, 0, 1, null)).bytesRead) throw Error('Gate log grew during read');
    if (BigInt(bytes) !== before.size || stamp(await handle.stat({bigint: true})) !== stamp(before) || stamp(await lstat(path, {bigint: true})) !== stamp(before)) throw Error('Gate log changed during read');
    return {bytes, sha256: digest.digest('hex'), ...counter.finish()};
  } finally { await handle.close(); }
}
