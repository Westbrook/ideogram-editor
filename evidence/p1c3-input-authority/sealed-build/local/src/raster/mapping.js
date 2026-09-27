import { extent } from './core.js';
export const retainedMask = (m) => 'outside' in m;
export const r16Mask = (m) => m.mapping === 'document-r16-v1' || m.mapping === 'retained-r16-v1';
export function validateMaskMapping(m) {
    const retained = ['retained-luminance-alpha-v1', 'retained-r16-v1'].includes(m?.mapping);
    const fields = ['assetId', 'mapping', 'inverted', ...(retained ? ['offsetX', 'offsetY', 'width', 'height', 'outside'] : [])];
    if (!m || typeof m !== 'object' || Array.isArray(m) || Object.keys(m).length !== fields.length || fields.some(k => !Object.hasOwn(m, k)) || typeof m.assetId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(m.assetId) || typeof m.inverted !== 'boolean' || !['document-luminance-alpha-v1', 'document-r16-v1', 'retained-luminance-alpha-v1', 'retained-r16-v1'].includes(m.mapping))
        throw Error('MASK_MAPPING');
    if (retained) {
        extent(m.width, m.height);
        if (m.outside !== 'zero' || ![m.offsetX, m.offsetY, m.offsetX + m.width, m.offsetY + m.height].every(Number.isSafeInteger))
            throw Error('MASK_ORIGIN');
    }
}
export function maskGrid(m, width, height) { return retainedMask(m) ? { x: m.offsetX, y: m.offsetY, width: m.width, height: m.height } : { x: 0, y: 0, width, height }; }
export function translateMask(m, width, height, dx, dy) {
    const g = maskGrid(m, width, height), next = { assetId: m.assetId, inverted: m.inverted, mapping: r16Mask(m) ? 'retained-r16-v1' : 'retained-luminance-alpha-v1', offsetX: g.x + dx, offsetY: g.y + dy, width: g.width, height: g.height, outside: 'zero' };
    validateMaskMapping(next);
    return next;
}
