// CP-1 cpu-f64-v1. Pure arithmetic; no browser, codec, clock or storage authority.
export const PIXEL_PIPELINE = 'cp1-f64-triangle-area-v1';
export type Affine = readonly [number, number, number, number, number, number];
export type Rect = { x: number; y: number; width: number; height: number };
export type Pixels = { width: number; height: number; get(x: number, y: number, into: Float64Array): void };
export type Coverage = { width: number; height: number; get(x: number, y: number): number };
export const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];
export const q8 = (x: number) => Math.max(0, Math.min(255, Math.floor(255 * x + 0.5)));
export const q16 = (x: number) => Math.max(0, Math.min(65535, Math.floor(x + 0.5)));
export const linear = (x: number) => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
export const srgb = (x: number) => x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
const LINEAR = Float64Array.from({ length: 256 }, (_, i) => linear(i / 255));
export function extent(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 25000000) throw new Error('RASTER_EXTENT');
}
export function inverse(m: Affine): Affine {
  if (m.length !== 6 || !m.every(Number.isFinite)) throw new Error('RASTER_TRANSFORM');
  const [a, b, c, d, e, f] = m; const det = a * d - b * c;
  if (!Number.isFinite(det) || det === 0) throw new Error('RASTER_TRANSFORM');
  const result: Affine = [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
  if (!result.every(Number.isFinite)) throw new Error('RASTER_TRANSFORM');
  return result;
}
export function integerIdentity(m: Affine): boolean {
  return m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && Number.isSafeInteger(m[4]) && Number.isSafeInteger(m[5]);
}
// Integral of max(0,1-|t|), from -infinity to t. No exterior renormalization.
export function triangleIntegral(t: number): number {
  return t <= -1 ? 0 : t < 0 ? (t + 1) ** 2 / 2 : t < 1 ? 1 - (1 - t) ** 2 / 2 : 1;
}
export function coefficient(center: number, cell: number, span: number): number {
  const t = center - (cell + 0.5);
  return span <= 1 ? Math.max(0, 1 - Math.abs(t)) : (triangleIntegral(t + span / 2) - triangleIntegral(t - span / 2)) / span;
}
// Separable source-axis box integration of triangle reconstruction. Projected
// inverse row norms set minification spans; rotation alone remains bilinear.
// This is a sealed kernel, not polygonal pixel-area integration under shear.
export function sampling(m: Affine) {
  const inv = inverse(m);
  const sx = Math.hypot(inv[0], inv[2]), sy = Math.hypot(inv[1], inv[3]);
  if (!Number.isFinite(sx) || !Number.isFinite(sy)) throw new Error('RASTER_TRANSFORM');
  return { inverse: inv, spanX: Math.max(1, sx), spanY: Math.max(1, sy), supportX: sx > 1 ? sx / 2 + 1 : 1, supportY: sy > 1 ? sy / 2 + 1 : 1 };
}
export function footprint(rect: Rect, m: Affine): Rect {
  const s = sampling(m), v = s.inverse;
  const corners = [[rect.x + .5, rect.y + .5], [rect.x + rect.width - .5, rect.y + .5], [rect.x + .5, rect.y + rect.height - .5], [rect.x + rect.width - .5, rect.y + rect.height - .5]];
  const xs = corners.map(([x, y]) => v[0] * x + v[2] * y + v[4]);
  const ys = corners.map(([x, y]) => v[1] * x + v[3] * y + v[5]);
  const x = Math.floor(Math.min(...xs) - s.supportX - .5), y = Math.floor(Math.min(...ys) - s.supportY - .5);
  const right = Math.ceil(Math.max(...xs) + s.supportX + .5), bottom = Math.ceil(Math.max(...ys) + s.supportY + .5);
  if (![x, y, right, bottom].every(Number.isSafeInteger)) throw new Error('RASTER_FOOTPRINT');
  return { x, y, width: right - x, height: bottom - y };
}
function quantize(out: Uint8Array, at: number, r: number, g: number, b: number, a: number) {
  out[at] = a > 0 ? q8(srgb(r / a)) : 0;
  out[at + 1] = a > 0 ? q8(srgb(g / a)) : 0;
  out[at + 2] = a > 0 ? q8(srgb(b / a)) : 0;
  out[at + 3] = q8(a);
}
export function contribution(source: Pixels, rect: Rect, transform: Affine, opacity: number, mask?: Coverage): Uint8Array {
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new Error('RASTER_OPACITY');
  const s = sampling(transform), v = s.inverse;
  const exact = integerIdentity(transform) && opacity === 1 && !mask;
  const out = new Uint8Array(rect.width * rect.height * 4), p = new Float64Array(4);
  for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) {
    const at = ((y - rect.y) * rect.width + x - rect.x) * 4;
    if (exact) { source.get(x - transform[4], y - transform[5], p); out.set(p, at); continue; }
    const cx = v[0] * (x + .5) + v[2] * (y + .5) + v[4], cy = v[1] * (x + .5) + v[3] * (y + .5) + v[5];
    let r = 0, g = 0, b = 0, a = 0;
    // Clip iteration, not coefficients. Missing exterior samples remain zero.
    for (let iy = Math.max(0, Math.ceil(cy - s.supportY - .5)); iy <= Math.min(source.height - 1, Math.floor(cy + s.supportY - .5)); iy++) {
      const wy = coefficient(cy, iy, s.spanY);
      for (let ix = Math.max(0, Math.ceil(cx - s.supportX - .5)); ix <= Math.min(source.width - 1, Math.floor(cx + s.supportX - .5)); ix++) {
        const w = wy * coefficient(cx, ix, s.spanX); if (w === 0) continue;
        source.get(ix, iy, p); const alpha = p[3] / 255 * w;
        r += LINEAR[p[0]] * alpha; g += LINEAR[p[1]] * alpha; b += LINEAR[p[2]] * alpha; a += alpha;
      }
    }
    // Ordering is observable at stage2: transform, document mask, then opacity.
    const coverage = mask ? mask.get(x, y) / 65535 : 1;
    r *= coverage; g *= coverage; b *= coverage; a *= coverage;
    r *= opacity; g *= opacity; b *= opacity; a *= opacity;
    quantize(out, at, r, g, b, a);
  }
  return out;
}
export function fold(accumulator: Float64Array, k: Uint8Array): void {
  if (accumulator.length !== k.length) throw new Error('RASTER_TILE');
  for (let i = 0; i < k.length; i += 4) {
    const a = k[i + 3] / 255, keep = 1 - a;
    accumulator[i] = LINEAR[k[i]] * a + accumulator[i] * keep;
    accumulator[i + 1] = LINEAR[k[i + 1]] * a + accumulator[i + 1] * keep;
    accumulator[i + 2] = LINEAR[k[i + 2]] * a + accumulator[i + 2] * keep;
    accumulator[i + 3] = a + accumulator[i + 3] * keep;
  }
}
export function finish(accumulator: Float64Array): Uint8Array {
  const out = new Uint8Array(accumulator.length);
  for (let i = 0; i < out.length; i += 4) quantize(out, i, accumulator[i], accumulator[i + 1], accumulator[i + 2], accumulator[i + 3]);
  return out;
}
export function composite(contributions: readonly Uint8Array[], byteLength: number): Uint8Array {
  if (contributions.some(k => k.length !== byteLength) || contributions.length > 100) throw new Error('RASTER_LAYERS');
  if (contributions.length === 1) return contributions[0].slice();
  const a = new Float64Array(byteLength); for (const k of contributions) fold(a, k); return finish(a);
}
export function preserve(source: Uint8Array, candidate: Uint8Array, mask: Uint16Array): Uint8Array {
  if (source.length !== candidate.length || source.length !== mask.length * 4) throw new Error('RASTER_MASK');
  const out = new Uint8Array(source.length);
  for (let j = 0; j < mask.length; j++) {
    const i = j * 4, m = mask[j] / 65535;
    if (m === 0) { out.set(source.subarray(i, i + 4), i); continue; }
    if (m === 1) { out.set(candidate.subarray(i, i + 4), i); continue; }
    const a = source[i + 3] / 255 * (1 - m), b = candidate[i + 3] / 255 * m;
    quantize(out, i, LINEAR[source[i]] * a + LINEAR[candidate[i]] * b, LINEAR[source[i + 1]] * a + LINEAR[candidate[i + 1]] * b, LINEAR[source[i + 2]] * a + LINEAR[candidate[i + 2]] * b, a + b);
  }
  return out;
}
export function maskCoverage(rgba: ArrayLike<number>): number {
  return q16((.2126 * LINEAR[rgba[0]] + .7152 * LINEAR[rgba[1]] + .0722 * LINEAR[rgba[2]]) * rgba[3] / 255 * 65535);
}
export function feather(source: Coverage, rect: Rect, radius: number): Uint16Array {
  if (!Number.isFinite(radius) || radius < 0 || radius > 64) throw new Error('RASTER_RADIUS');
  const reach = Math.max(0, Math.ceil(radius) - 1), weights = Array.from({ length: reach * 2 + 1 }, (_, i) => radius <= 1 ? 1 : Math.max(0, 1 - Math.abs(i - reach) / radius));
  const sum = weights.reduce((a, b) => a + b, 0); for (let i = 0; i < weights.length; i++) weights[i] /= sum;
  const out = new Uint16Array(rect.width * rect.height);
  for (let y = 0; y < rect.height; y++) for (let x = 0; x < rect.width; x++) {
    let value = 0;
    for (let j = -reach; j <= reach; j++) for (let i = -reach; i <= reach; i++) value += source.get(rect.x + x + i, rect.y + y + j) * weights[i + reach] * weights[j + reach];
    out[y * rect.width + x] = q16(value);
  }
  return out;
}
