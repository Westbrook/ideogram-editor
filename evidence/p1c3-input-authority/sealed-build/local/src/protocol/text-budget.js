// Shared arithmetic for the one R35 lane, not another allowance per worker.
export function verificationBudget(text, width, height, fontBytes, wasmBytes) {
    let scalars = 0;
    for (const _ of text)
        scalars++;
    const glyphs = Math.max(64, 8 * scalars), lines = Math.max(text.split('\n').length, glyphs);
    const layout = 16384 + 1024 * (glyphs + scalars + lines), raster = Math.ceil(width) * Math.ceil(height) * 4;
    const indexes = 128 * (text.length + new TextEncoder().encode(text).length + scalars + 3);
    const startup = 33554432 + 6 * wasmBytes + 4194304, resident = 33554432 + 2 * wasmBytes + 4194304;
    // Backend receives paths, not cloned caller Blobs: construction <=2F;
    // retained Blob + parser ArrayBuffer + digest snapshot <=3F. Native copies
    // are inside the booked heap. Browser inputs remain separately reserved.
    const request = 3 * fontBytes + 4 * raster + 6 * layout + indexes + 65536;
    const scratch = 2 * layout + 2097152;
    const bytes = Math.max(startup, resident + request) + scratch;
    if (layout > 8388608 || !Number.isSafeInteger(bytes) || bytes > 134217728)
        throw Error('TEXT_VERIFICATION_CAPACITY');
    return { bytes, startup, resident, request, scratch, layout };
}
