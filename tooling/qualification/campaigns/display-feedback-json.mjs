/**
 * Streaming decoder for the raw JSON returned by Chromium's tracing stream.
 *
 * Every yielded event is provisional: exhaust the generator successfully before
 * publishing a result. A later event, discarded metadata, UTF-8 tail or trailer
 * can invalidate the document. Numeric JSON tokens are never converted to JS
 * numbers. Only isRawTraceNumber identifies markers produced by this decoder;
 * an object in an untrusted trace can otherwise imitate their public shape.
 */

const numericTokens = new WeakSet();
const DECODE_SLICE_BYTES = 16 * 1024;
const MAX_CONSECUTIVE_EMPTY_CHUNKS = 4096;
const DEFAULT_LIMITS = Object.freeze({
  maxEventBytes: 64 * 1024,
  maxDepth: 64,
  maxTotalBytes: 128 * 1024 * 1024,
  maxEvents: 1_000_000,
  maxObjectKeys: 4096,
});
const LIMIT_CEILINGS = Object.freeze({
  maxEventBytes: 4 * 1024 * 1024,
  maxDepth: 64,
  maxTotalBytes: 128 * 1024 * 1024,
  maxEvents: 1_000_000,
  maxObjectKeys: 65_536,
});

export class TraceJSONDecodeError extends Error {
  constructor(code, message, byteOffset) {
    super(message);
    this.name = 'TraceJSONDecodeError';
    this.code = code;
    this.byteOffset = byteOffset;
  }
}

export function isRawTraceNumber(value) {
  return typeof value === 'object' && value !== null && numericTokens.has(value);
}

function numberToken(raw) {
  const token = Object.freeze({ kind: 'trace-number', raw });
  numericTokens.add(token);
  return token;
}

function limitsFrom(options) {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new TypeError('Trace decoder options must be an object');
  }
  for (const key of Object.keys(options)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, key)) {
      throw new TypeError('Unknown trace decoder limit');
    }
  }
  const limits = {};
  for (const [key, fallback] of Object.entries(DEFAULT_LIMITS)) {
    const value = Object.hasOwn(options, key) ? options[key] : fallback;
    if (!Number.isSafeInteger(value) || value < 1 || value > LIMIT_CEILINGS[key]) {
      throw new TypeError(`Invalid trace decoder ${key} limit`);
    }
    limits[key] = value;
  }
  return limits;
}

class UTF8Reader {
  constructor(chunks, limits) {
    if (chunks === null || chunks === undefined ||
        typeof chunks[Symbol.asyncIterator] !== 'function') {
      throw new TypeError('Trace input must be an async iterable of Uint8Array chunks');
    }
    this.iterator = chunks[Symbol.asyncIterator]();
    this.limits = limits;
    // Preserve a BOM as a character so JSON grammar rejects it explicitly.
    this.decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    this.chunk = undefined;
    this.chunkOffset = 0;
    this.text = '';
    this.textOffset = 0;
    this.receivedBytes = 0;
    this.byteOffset = 0;
    this.emptyChunks = 0;
    this.iteratorEnded = false;
    this.decoderEnded = false;
    this.eventStart = undefined;
  }

  fail(code, message) {
    throw new TraceJSONDecodeError(code, message, this.byteOffset);
  }

  decode(bytes, stream) {
    try {
      return this.decoder.decode(bytes, { stream });
    } catch {
      this.fail('TRACE_UTF8_INVALID', 'Trace contains malformed or truncated UTF-8');
    }
  }

  async fill() {
    while (this.textOffset >= this.text.length) {
      this.text = '';
      this.textOffset = 0;
      if (this.chunk !== undefined && this.chunkOffset < this.chunk.byteLength) {
        const end = Math.min(this.chunkOffset + DECODE_SLICE_BYTES, this.chunk.byteLength);
        this.text = this.decode(this.chunk.subarray(this.chunkOffset, end), true);
        this.chunkOffset = end;
        if (end === this.chunk.byteLength) this.chunk = undefined;
        if (this.text.length !== 0) return true;
        continue;
      }
      if (this.iteratorEnded) {
        if (this.decoderEnded) return false;
        this.decoderEnded = true;
        this.text = this.decode(undefined, false);
        if (this.text.length !== 0) return true;
        return false;
      }
      let next;
      try {
        next = await this.iterator.next();
      } catch {
        this.fail('TRACE_STREAM_INVALID', 'Trace input stream could not be read');
      }
      if (typeof next !== 'object' || next === null) {
        this.fail('TRACE_STREAM_INVALID', 'Trace input stream returned an invalid result');
      }
      if (next.done) {
        this.iteratorEnded = true;
        continue;
      }
      if (!(next.value instanceof Uint8Array)) {
        this.fail('TRACE_STREAM_INVALID', 'Trace chunks must be Uint8Array values');
      }
      if (next.value.byteLength > this.limits.maxTotalBytes - this.receivedBytes) {
        this.fail('TRACE_JSON_LIMIT', 'Trace exceeds the total byte limit');
      }
      this.receivedBytes += next.value.byteLength;
      if (next.value.byteLength === 0) {
        this.emptyChunks += 1;
        if (this.emptyChunks > MAX_CONSECUTIVE_EMPTY_CHUNKS) {
          this.fail('TRACE_JSON_LIMIT', 'Trace input made no byte progress');
        }
        continue;
      }
      this.emptyChunks = 0;
      this.chunk = next.value;
      this.chunkOffset = 0;
    }
    return true;
  }

  async peek() {
    if (!await this.fill()) return undefined;
    return String.fromCodePoint(this.text.codePointAt(this.textOffset));
  }

  async take() {
    const character = await this.peek();
    if (character === undefined) {
      this.fail('TRACE_JSON_INVALID', 'Trace JSON is truncated');
    }
    this.textOffset += character.length;
    const point = character.codePointAt(0);
    this.byteOffset += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (this.eventStart !== undefined &&
        this.byteOffset - this.eventStart > this.limits.maxEventBytes) {
      this.fail('TRACE_JSON_LIMIT', 'Trace event exceeds its byte limit');
    }
    return character;
  }

  async close() {
    this.chunk = undefined;
    this.text = '';
    this.eventStart = undefined;
    if (!this.iteratorEnded && typeof this.iterator.return === 'function') {
      this.iteratorEnded = true;
      try {
        await this.iterator.return();
      } catch {
        this.fail('TRACE_STREAM_INVALID', 'Trace input stream could not be closed');
      }
    }
  }
}

function digit(character) {
  return character !== undefined && character >= '0' && character <= '9';
}

function hexDigit(character) {
  if (character >= '0' && character <= '9') return character.charCodeAt(0) - 48;
  if (character >= 'a' && character <= 'f') return character.charCodeAt(0) - 87;
  if (character >= 'A' && character <= 'F') return character.charCodeAt(0) - 55;
  return -1;
}

class JSONParser {
  constructor(reader, limits) {
    this.reader = reader;
    this.limits = limits;
    // Tiny event limits must still allow the required root member's key.
    this.maxKeyBytes = Math.max(64, limits.maxEventBytes);
  }

  invalid(message) {
    this.reader.fail('TRACE_JSON_INVALID', message);
  }

  depth(depth) {
    if (depth > this.limits.maxDepth) {
      this.reader.fail('TRACE_JSON_LIMIT', 'Trace exceeds the nesting depth limit');
    }
  }

  async whitespace() {
    for (;;) {
      const character = await this.reader.peek();
      if (character !== ' ' && character !== '\t' && character !== '\n' && character !== '\r') return;
      await this.reader.take();
    }
  }

  async expect(expected) {
    if (await this.reader.take() !== expected) this.invalid('Trace JSON has an unexpected token');
  }

  objectKeys() {
    return { seen: new Set(), bytes: 0 };
  }

  async key(keys) {
    const start = this.reader.byteOffset;
    const key = await this.string(true, true);
    keys.bytes += this.reader.byteOffset - start;
    if (keys.bytes > this.maxKeyBytes || keys.seen.size >= this.limits.maxObjectKeys) {
      this.reader.fail('TRACE_JSON_LIMIT', 'Trace object exceeds its key tracking limit');
    }
    if (keys.seen.has(key)) this.invalid('Trace JSON contains a duplicate object key');
    keys.seen.add(key);
    return key;
  }

  async string(capture, isKey = false) {
    const start = this.reader.byteOffset;
    await this.expect('"');
    const pieces = capture ? [] : undefined;
    let piece = '';
    for (;;) {
      let character = await this.reader.take();
      if (isKey && this.reader.byteOffset - start > this.maxKeyBytes) {
        this.reader.fail('TRACE_JSON_LIMIT', 'Trace object key exceeds its byte limit');
      }
      if (character === '"') {
        if (!capture) return undefined;
        pieces.push(piece);
        return pieces.join('');
      }
      if (character.charCodeAt(0) < 0x20) this.invalid('Trace JSON string contains an unescaped control character');
      if (character === '\\') {
        const escape = await this.reader.take();
        switch (escape) {
          case '"': character = '"'; break;
          case '\\': character = '\\'; break;
          case '/': character = '/'; break;
          case 'b': character = '\b'; break;
          case 'f': character = '\f'; break;
          case 'n': character = '\n'; break;
          case 'r': character = '\r'; break;
          case 't': character = '\t'; break;
          case 'u': {
            let point = 0;
            for (let index = 0; index < 4; index += 1) {
              const hex = hexDigit(await this.reader.take());
              if (hex === -1) this.invalid('Trace JSON string contains an invalid Unicode escape');
              point = point * 16 + hex;
            }
            character = String.fromCharCode(point);
            break;
          }
          default: this.invalid('Trace JSON string contains an invalid escape');
        }
        if (isKey && this.reader.byteOffset - start > this.maxKeyBytes) {
          this.reader.fail('TRACE_JSON_LIMIT', 'Trace object key exceeds its byte limit');
        }
      }
      if (capture) {
        piece += character;
        if (piece.length >= 1024) {
          pieces.push(piece);
          piece = '';
        }
      }
    }
  }

  async number(capture) {
    let raw = '';
    const take = async () => {
      const character = await this.reader.take();
      if (capture) raw += character;
    };
    if (await this.reader.peek() === '-') await take();
    let character = await this.reader.peek();
    if (character === '0') {
      await take();
    } else if (character !== undefined && character >= '1' && character <= '9') {
      do { await take(); } while (digit(await this.reader.peek()));
    } else {
      this.invalid('Trace JSON contains an invalid number');
    }
    if (await this.reader.peek() === '.') {
      await take();
      if (!digit(await this.reader.peek())) this.invalid('Trace JSON contains an invalid fraction');
      do { await take(); } while (digit(await this.reader.peek()));
    }
    character = await this.reader.peek();
    if (character === 'e' || character === 'E') {
      await take();
      character = await this.reader.peek();
      if (character === '+' || character === '-') await take();
      if (!digit(await this.reader.peek())) this.invalid('Trace JSON contains an invalid exponent');
      do { await take(); } while (digit(await this.reader.peek()));
    }
    return capture ? numberToken(raw) : undefined;
  }

  async literal(word, value, capture) {
    for (const character of word) await this.expect(character);
    return capture ? value : undefined;
  }

  async value(capture, depth) {
    await this.whitespace();
    const character = await this.reader.peek();
    if (character === '{') return this.object(capture, depth);
    if (character === '[') return this.array(capture, depth);
    if (character === '"') return this.string(capture);
    if (character === '-' || digit(character)) return this.number(capture);
    if (character === 't') return this.literal('true', true, capture);
    if (character === 'f') return this.literal('false', false, capture);
    if (character === 'n') return this.literal('null', null, capture);
    this.invalid('Trace JSON contains an invalid or truncated value');
  }

  async object(capture, depth) {
    this.depth(depth);
    await this.expect('{');
    const result = capture ? {} : undefined;
    const keys = this.objectKeys();
    await this.whitespace();
    if (await this.reader.peek() === '}') {
      await this.reader.take();
      return result;
    }
    for (;;) {
      const key = await this.key(keys);
      await this.whitespace();
      await this.expect(':');
      const value = await this.value(capture, depth + 1);
      if (capture) {
        Object.defineProperty(result, key, { value, enumerable: true, writable: true, configurable: true });
      }
      await this.whitespace();
      const separator = await this.reader.take();
      if (separator === '}') return result;
      if (separator !== ',') this.invalid('Trace JSON object has an invalid separator');
      await this.whitespace();
    }
  }

  async array(capture, depth) {
    this.depth(depth);
    await this.expect('[');
    const result = capture ? [] : undefined;
    await this.whitespace();
    if (await this.reader.peek() === ']') {
      await this.reader.take();
      return result;
    }
    for (;;) {
      const value = await this.value(capture, depth + 1);
      if (capture) result.push(value);
      await this.whitespace();
      const separator = await this.reader.take();
      if (separator === ']') return result;
      if (separator !== ',') this.invalid('Trace JSON array has an invalid separator');
      await this.whitespace();
    }
  }
}

/**
 * @param {AsyncIterable<Uint8Array>} chunks Raw trace bytes, never parsed JSON.
 * @param {{maxEventBytes?: number, maxDepth?: number, maxTotalBytes?: number,
 *   maxEvents?: number, maxObjectKeys?: number}} [options]
 * Event bytes include the complete object token, including internal whitespace.
 * Depth counts containers, with root=1, traceEvents=2 and event=3. Every object,
 * including discarded metadata, has a bounded set of decoded keys: at most
 * maxObjectKeys and at most max(64, maxEventBytes) original key token bytes total.
 * A stream of more than 4,096 consecutive empty chunks is refused.
 */
export async function* decodeRawTraceEvents(chunks, options = {}) {
  const limits = limitsFrom(options);
  const reader = new UTF8Reader(chunks, limits);
  const parser = new JSONParser(reader, limits);
  let traceEventsSeen = false;
  let eventCount = 0;
  let failed = false;
  try {
    parser.depth(1);
    await parser.whitespace();
    await parser.expect('{');
    const rootKeys = parser.objectKeys();
    await parser.whitespace();
    if (await reader.peek() === '}') parser.invalid('Trace JSON is missing traceEvents');
    for (;;) {
      const key = await parser.key(rootKeys);
      await parser.whitespace();
      await parser.expect(':');
      await parser.whitespace();
      if (key === 'traceEvents') {
        traceEventsSeen = true;
        parser.depth(2);
        await parser.expect('[');
        await parser.whitespace();
        if (await reader.peek() === ']') {
          await reader.take();
        } else {
          for (;;) {
            if (eventCount >= limits.maxEvents) reader.fail('TRACE_JSON_LIMIT', 'Trace exceeds the event count limit');
            if (await reader.peek() !== '{') parser.invalid('Every trace event must be a JSON object');
            reader.eventStart = reader.byteOffset;
            const event = await parser.object(true, 3);
            reader.eventStart = undefined;
            eventCount += 1;
            yield event;
            await parser.whitespace();
            const separator = await reader.take();
            if (separator === ']') break;
            if (separator !== ',') parser.invalid('traceEvents has an invalid separator');
            await parser.whitespace();
          }
        }
      } else {
        await parser.value(false, 2);
      }
      await parser.whitespace();
      const separator = await reader.take();
      if (separator === '}') break;
      if (separator !== ',') parser.invalid('Trace root has an invalid separator');
      await parser.whitespace();
    }
    if (!traceEventsSeen) parser.invalid('Trace JSON is missing traceEvents');
    await parser.whitespace();
    if (await reader.peek() !== undefined) parser.invalid('Trace JSON contains a non-whitespace trailer');
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      await reader.close();
    } catch (error) {
      // Preserve the first parser/stream failure if cleanup also fails.
      if (!failed) throw error;
    }
  }
}
