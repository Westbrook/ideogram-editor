// The caller owns the admitted final surface and pixel leases for this entire
// synchronous write. New preview canvases start at 0×0; any prior backing must
// also remain owned until it is cleared. This describes application ownership,
// not when a browser allocates or reclaims its internal canvas storage.
export function paintTextPreview(canvas: HTMLCanvasElement, preview: {
  width: number; height: number; pixels: Uint8ClampedArray<ArrayBuffer>;
}) {
  const { width, height, pixels } = preview;
  const bytes = width * height * 4;
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0 ||
      !Number.isSafeInteger(bytes) || pixels.byteLength !== bytes) throw new RangeError('TEXT_PREVIEW_DIMENSIONS');
  // Final extent has already been admitted. Zero width prevents an old or
  // default height from multiplying the new width into a larger intermediate.
  canvas.width = 0;
  canvas.height = height;
  canvas.width = width;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('TEXT_PREVIEW_CONTEXT_UNAVAILABLE');
  context.putImageData(new ImageData(pixels, width, height), 0, 0);
}
