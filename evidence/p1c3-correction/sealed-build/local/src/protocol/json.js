export class JSONError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
    }
}
export const CONTROL_BYTES = 64 * 1024;
const malformed = () => { throw new JSONError('MALFORMED_REQUEST'); };
// JSON.parse alone silently accepts duplicate keys, overflow, and lone surrogates.
// Validate tokens first, including decoded property names, then use the native parser.
export function parseControlJSON(bytes, maxBytes = CONTROL_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 8388608 || bytes.byteLength > maxBytes)
        throw new JSONError('PAYLOAD_TOO_LARGE');
    let source;
    try {
        source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    }
    catch {
        return malformed();
    }
    let at = 0;
    const whitespace = () => { while (/[\x20\t\n\r]/.test(source[at] ?? '\0'))
        at++; };
    function string() {
        const start = at++;
        while (at < source.length) {
            if (source[at] === '\\') {
                at += 2;
                continue;
            }
            if (source[at++] === '"') {
                let value;
                try {
                    value = JSON.parse(source.slice(start, at));
                }
                catch {
                    return malformed();
                }
                for (const character of value) {
                    const point = character.codePointAt(0);
                    if (point >= 0xd800 && point <= 0xdfff)
                        return malformed();
                }
                return value;
            }
        }
        return malformed();
    }
    function value(depth) {
        // Session controls have no nested values; bound hostile parser recursion.
        if (depth > 64)
            return malformed();
        whitespace();
        const token = source[at];
        if (token === '"') {
            string();
            return;
        }
        if (token === '{' || token === '[') {
            const object = token === '{';
            const end = object ? '}' : ']';
            const keys = new Set();
            at++;
            whitespace();
            if (source[at] === end) {
                at++;
                return;
            }
            while (at < source.length) {
                if (object) {
                    if (source[at] !== '"')
                        return malformed();
                    const key = string();
                    if (keys.has(key))
                        return malformed();
                    keys.add(key);
                    whitespace();
                    if (source[at++] !== ':')
                        return malformed();
                }
                value(depth + 1);
                whitespace();
                if (source[at] === end) {
                    at++;
                    return;
                }
                if (source[at++] !== ',')
                    return malformed();
                whitespace();
            }
            return malformed();
        }
        const literal = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(source.slice(at));
        if (!literal)
            return malformed();
        if (!['true', 'false', 'null'].includes(literal[0]) && !Number.isFinite(Number(literal[0])))
            return malformed();
        at += literal[0].length;
    }
    value(0);
    whitespace();
    if (at !== source.length)
        return malformed();
    const result = JSON.parse(source);
    if (!result || typeof result !== 'object' || Array.isArray(result))
        return malformed();
    return result;
}
function scalarOrder(a, b) {
    const aa = Array.from(a, ch => ch.codePointAt(0));
    const bb = Array.from(b, ch => ch.codePointAt(0));
    for (let i = 0; i < Math.min(aa.length, bb.length); i++)
        if (aa[i] !== bb[i])
            return aa[i] - bb[i];
    return aa.length - bb.length;
}
export function canonical(value) {
    if (value === null)
        return 'null';
    if (typeof value === 'boolean')
        return String(value);
    if (typeof value === 'number') {
        if (!Number.isFinite(value))
            throw new JSONError('MALFORMED_REQUEST');
        return JSON.stringify(value);
    }
    if (typeof value === 'string') {
        let text = '"';
        for (const ch of value) {
            const cp = ch.codePointAt(0);
            if (cp >= 0xd800 && cp <= 0xdfff)
                throw new JSONError('MALFORMED_REQUEST');
            text += cp < 32 ? `\\u${cp.toString(16).padStart(4, '0')}` : ch === '"' || ch === '\\' ? `\\${ch}` : ch;
        }
        return text + '"';
    }
    if (Array.isArray(value))
        return `[${value.map(canonical).join(',')}]`;
    if (typeof value !== 'object' || !value || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
        throw new JSONError('MALFORMED_REQUEST');
    const object = value;
    return `{${Object.keys(object).sort(scalarOrder).map(key => `${canonical(key)}:${canonical(object[key])}`).join(',')}}`;
}
