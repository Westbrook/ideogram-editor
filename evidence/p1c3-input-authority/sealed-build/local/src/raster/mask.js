import { extent, q16 } from './core.js';
import { validateMaskMapping, retainedMask, r16Mask } from './mapping.js';
const exact = (v, fields) => { if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== fields.length || fields.some(k => !Object.hasOwn(v, k)))
    throw Error('MASK_FIELDS'); };
const finite = (n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 32768;
function points(v) { if (!Array.isArray(v) || !v.length || v.some(p => !Array.isArray(p) || p.length !== 2 || !p.every(finite)))
    throw Error('MASK_POINTS'); }
export function validateShape(v) {
    if (v?.kind === 'polygon') {
        exact(v, ['kind', 'points']);
        points(v.points);
        if (v.points.length < 3)
            throw Error('MASK_POLYGON');
    }
    else {
        exact(v, ['kind', 'x', 'y', 'width', 'height']);
        if (!['rectangle', 'ellipse'].includes(v.kind) || ![v.x, v.y, v.width, v.height].every(finite) || v.width <= 0 || v.height <= 0)
            throw Error('MASK_SHAPE');
    }
}
export function validateMaskPlan(v) {
    exact(v, ['width', 'height', 'feather', 'operations', ...(v.schemaVersion === 2 ? ['schemaVersion'] : [])]);
    extent(v.width, v.height);
    if (typeof v.feather !== 'number' || !Number.isFinite(v.feather) || v.feather < 0 || v.feather > 64 || !Array.isArray(v.operations))
        throw Error('MASK_PLAN');
    for (const op of v.operations) {
        if (op.kind === 'shape') {
            exact(op, ['kind', 'shape', 'mode']);
            validateShape(op.shape);
            if (!['replace', 'add', 'subtract', 'intersect'].includes(op.mode))
                throw Error('MASK_MODE');
        }
        else if (op.kind === 'stroke') {
            exact(op, ['kind', 'points', 'size', 'hardness', 'mode']);
            points(op.points);
            if (!finite(op.size) || op.size <= 0 || op.size > 8192 || typeof op.hardness !== 'number' || !Number.isFinite(op.hardness) || op.hardness < 0 || op.hardness > 1 || !['add', 'subtract'].includes(op.mode))
                throw Error('MASK_STROKE');
        }
        else if (op.kind === 'import') {
            exact(op, ['kind', 'assetId', 'x', 'y', 'width', 'height', 'inverted']);
            if (typeof op.assetId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(op.assetId) || ![op.x, op.y, op.width, op.height].every(Number.isSafeInteger) || op.width < 1 || op.height < 1 || op.width > 8192 || op.height > 8192 || typeof op.inverted !== 'boolean')
                throw Error('MASK_IMPORT');
        }
        else if (op.kind === 'retained-hard-v1') {
            exact(op, ['kind', 'mask', 'hard']);
            validateMaskMapping(op.mask);
            if (v.schemaVersion !== 2 || !retainedMask(op.mask))
                throw Error('MASK_BASELINE_VERSION');
            if (r16Mask(op.mask)) {
                exact(op.hard, ['hash', 'byteLength', 'mediaType']);
                if (!/^sha256:[a-f0-9]{64}$/.test(op.hard.hash) || op.hard.byteLength !== String(op.mask.width * op.mask.height * 2) || op.hard.mediaType !== 'application/x-ideogram-r16le')
                    throw Error('MASK_HARD_IDENTITY');
            }
            else if (op.hard !== null)
                throw Error('MASK_LEGACY_BASELINE');
        }
        else if (['fill', 'clear', 'invert'].includes(op.kind))
            exact(op, ['kind']);
        else
            throw Error('MASK_OPERATION');
    }
    // Same bounded control/manifest envelope as the writer; never truncate a stroke.
    if (new TextEncoder().encode(JSON.stringify(v)).length > 48000)
        throw Error('MASK_DRAFT_TOO_LARGE');
}
export function shapeContains(s, x, y) {
    if (s.kind === 'rectangle')
        return x >= s.x && y >= s.y && x < s.x + s.width && y < s.y + s.height;
    if (s.kind === 'ellipse')
        return ((x - s.x - s.width / 2) / (s.width / 2)) ** 2 + ((y - s.y - s.height / 2) / (s.height / 2)) ** 2 <= 1;
    if (s.kind !== 'polygon')
        return false;
    let inside = false;
    for (let i = 0, j = s.points.length - 1; i < s.points.length; j = i++) {
        const [xi, yi] = s.points[i], [xj, yj] = s.points[j];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi)
            inside = !inside;
    }
    return inside;
}
function distance(p, a, b) { const dx = b[0] - a[0], dy = b[1] - a[1], n = dx * dx + dy * dy, t = n ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / n)) : 0; return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy); }
export function authoredCoverage(plan, imported = () => 0) {
    return { width: plan.width, height: plan.height, get(x, y) {
            if (x < 0 || y < 0 || x >= plan.width || y >= plan.height)
                return 0;
            let value = 0;
            for (const op of plan.operations) {
                if (op.kind === 'fill') {
                    value = 65535;
                    continue;
                }
                if (op.kind === 'clear') {
                    value = 0;
                    continue;
                }
                if (op.kind === 'invert') {
                    value = 65535 - value;
                    continue;
                }
                if (op.kind === 'import' || op.kind === 'retained-hard-v1') {
                    value = imported(op, x, y);
                    continue;
                }
                let amount = 0;
                if (op.kind === 'shape')
                    amount = shapeContains(op.shape, x + .5, y + .5) ? 65535 : 0;
                else if (op.kind === 'stroke') {
                    let d = Infinity;
                    for (let i = 0; i < op.points.length; i++)
                        d = Math.min(d, distance([x + .5, y + .5], op.points[i], op.points[Math.max(0, i - 1)]));
                    const r = op.size / 2, inner = r * op.hardness;
                    amount = d >= r ? 0 : d <= inner ? 65535 : q16((r - d) / (r - inner) * 65535);
                }
                if (op.kind === 'shape' || op.kind === 'stroke')
                    value = op.mode === 'replace' ? amount : op.mode === 'add' ? Math.max(value, amount) : op.mode === 'subtract' ? Math.max(0, value - amount) : Math.min(value, amount);
            }
            return value;
        } };
}
// Separable finite triangle, document-zero extension; intermediate rows stay f64.
// Only the final two-dimensional sum is quantized to R16.
export function featherRows(source, radius) {
    const reach = Math.max(0, Math.ceil(radius) - 1), weights = Array.from({ length: 2 * reach + 1 }, (_, i) => radius <= 1 ? 1 : Math.max(0, 1 - Math.abs(i - reach) / radius));
    const sum = weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < weights.length; i++)
        weights[i] /= sum;
    const rows = new Map();
    return (y) => {
        const out = new Uint16Array(source.width);
        for (const k of rows.keys())
            if (k < y - reach)
                rows.delete(k);
        for (let j = -reach; j <= reach; j++) {
            const iy = y + j;
            if (iy < 0 || iy >= source.height)
                continue;
            let row = rows.get(iy);
            if (!row) {
                row = new Float64Array(source.width);
                for (let x = 0; x < source.width; x++)
                    for (let i = -reach; i <= reach; i++)
                        row[x] += source.get(x + i, iy) * weights[i + reach];
                rows.set(iy, row);
            }
        }
        for (let x = 0; x < source.width; x++) {
            let n = 0;
            for (let j = -reach; j <= reach; j++)
                n += (rows.get(y + j)?.[x] ?? 0) * weights[j + reach];
            out[x] = q16(n);
        }
        return out;
    };
}
export function maskDraftValue(v) {
    exact(v, ['schema', 'layerVersion', 'radius', 'plan']);
    if (!['local-mask-1', 'local-mask-2'].includes(v.schema) || !/^(0|[1-9][0-9]*)$/.test(v.layerVersion) || typeof v.radius !== 'string')
        throw Error('MASK_DRAFT');
    validateMaskPlan(v.plan);
    if ((v.schema === 'local-mask-2') !== (v.plan.schemaVersion === 2))
        throw Error('MASK_DRAFT_VERSION');
}
export function maskImports(plan) { return [...new Set(plan.operations.flatMap(op => op.kind === 'import' ? [op.assetId] : op.kind === 'retained-hard-v1' ? [op.mask.assetId] : []))]; }
export function resolveMaskPlan(plan, bindings) {
    maskBindings(plan, bindings);
    const out = structuredClone(plan);
    for (const op of out.operations) {
        if (op.kind === 'import')
            op.assetId = bindings[op.assetId];
        else if (op.kind === 'retained-hard-v1')
            op.mask.assetId = bindings[op.mask.assetId];
    }
    return out;
}
// Both live preparation and portable validation bind the declared retained grid
// and exact hard object. A display preview is never an R16 baseline.
export function maskSource(plan, id, info, hard) {
    for (const op of plan.operations) {
        if (op.kind === 'import' && op.assetId === id) {
            if (info.role !== 'native' || info.width !== op.width || info.height !== op.height)
                throw Error('MASK_IMPORT_GRID');
        }
        if (op.kind === 'retained-hard-v1' && op.mask.assetId === id) {
            const m = op.mask;
            if (!retainedMask(m) || m.width !== info.width || m.height !== info.height || r16Mask(m) !== (info.role === 'mask'))
                throw Error('MASK_BASELINE_GRID');
            if (r16Mask(m) && (!hard || !op.hard || hard.hash !== op.hard.hash || hard.byteLength !== op.hard.byteLength || hard.mediaType !== op.hard.mediaType))
                throw Error('MASK_HARD_IDENTITY');
        }
    }
}
export function maskBindings(plan, bindings) {
    const ids = maskImports(plan);
    if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings) || Object.keys(bindings).length !== ids.length || ids.some(id => !Object.hasOwn(bindings, id) || typeof bindings[id] !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(bindings[id])))
        throw Error('MASK_BINDINGS');
    return ids.map(id => bindings[id]);
}
