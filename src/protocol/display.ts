/** Ephemeral display products never change retained pixels or export bytes. */
export const DISPLAY_PROFILE = 'cp1-display-v1';
export const DISPLAY_TILE_SIZE = 512;
export const DISPLAY_MAX_LOD = 6;
export const DISPLAY_HEADERS = {
  profile: 'X-Display-Profile', source: 'X-Display-Source', basis: 'X-Display-Basis',
  width: 'X-Display-Width', height: 'X-Display-Height', sourceWidth: 'X-Display-Source-Width',
  sourceHeight: 'X-Display-Source-Height', lod: 'X-Display-LOD',
} as const;
export type DisplayBasis = 'pixels' | 'encoded';
export type DisplayRequest = { basis: DisplayBasis; identity: string } & (
  { kind: 'preview'; edge: 256 | 1024 } | { kind: 'tile'; lod: number; x: number; y: number }
);
export type DisplayInfo = {
  profile: typeof DISPLAY_PROFILE; source: string; basis: DisplayBasis;
  width: number; height: number; sourceWidth: number; sourceHeight: number; lod: number;
  byteLength: string; hash: string; mediaType: 'image/png' | 'application/x-ideogram-rgba8';
};
export function validDisplayRequest(value: DisplayRequest): boolean {
  if (!value || !/^sha256:[a-f0-9]{64}$/.test(value.identity) || !['pixels', 'encoded'].includes(value.basis)) return false;
  return value.kind === 'preview' ? value.edge === 256 || value.edge === 1024 : value.kind === 'tile' &&
    Number.isInteger(value.lod) && value.lod >= 0 && value.lod <= DISPLAY_MAX_LOD &&
    Number.isSafeInteger(value.x) && value.x >= 0 && Number.isSafeInteger(value.y) && value.y >= 0;
}
export function displayDimensions(width: number, height: number, request: DisplayRequest) {
  if (!validDisplayRequest(request) || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 25000000) throw Error('DISPLAY_REQUEST');
  const scale = request.kind === 'tile' ? 2 ** -request.lod : Math.min(1, request.edge / Math.max(width, height));
  return { width: Math.max(1, Math.ceil(width * scale)), height: Math.max(1, Math.ceil(height * scale)) };
}
export function displayPath(assetId: string, request: DisplayRequest): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(assetId) || !validDisplayRequest(request)) throw Error('DISPLAY_REQUEST');
  const query = new URLSearchParams({ identity: request.identity, basis: request.basis });
  if (request.kind === 'preview') query.set('edge', String(request.edge));
  else { query.set('lod', String(request.lod)); query.set('x', String(request.x)); query.set('y', String(request.y)); }
  return `/api/v1/assets/${encodeURIComponent(assetId)}/${request.kind === 'preview' ? 'display' : 'display-tile'}?${query}`;
}
