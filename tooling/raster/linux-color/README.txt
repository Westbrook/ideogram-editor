Linux fixed-strip color bridge, version 1.0.0

This separately versioned bridge supports the frozen Linux arm64 and x64
libvips 8.18.6 profiles. It does not replace the macOS or Linux WebP seals and
contains no copied libvips/LCMS implementation. Public API declarations are
checked against upstream libvips v8.18.6 headers and source:
https://github.com/libvips/libvips/blob/v8.18.6/libvips/include/vips/image.h
https://github.com/libvips/libvips/blob/v8.18.6/libvips/include/vips/header.h
https://github.com/libvips/libvips/blob/v8.18.6/libvips/include/vips/colour.h
https://github.com/libvips/libvips/blob/v8.18.6/libvips/colour/icc_transform.c
https://github.com/libvips/libvips/blob/v8.18.6/libvips/iofuncs/cache.c

The caller supplies addresses resolved only from the verified platform CODECS
library. The ten-symbol ABI is ordered in verify.mjs. The caller must validate
exact P3 profile bytes and retain the library and profile for the complete call.
The native wrapper checks libvips version, disabled operation cache and one
worker concurrency before creating an image. Existing engine configuration
already supplies these settings. The wrapper never mutates shared settings.
Concurrent bridge calls fail busy. Cache/concurrency changes during execution
are forbidden by the application ownership contract.

One synchronous call owns every image and output allocation. Each iteration
packs at most 16,384 RGB pixels into 48 KiB of stack storage, attaches the exact
P3 profile, calls public vips_icc_transform with built-in sRGB / perceptual
intent / 8-bit output, materializes at most 48 KiB, copies RGB back into the
caller's RGBA buffer, and releases all strip objects before continuing. Alpha,
including hidden RGB at alpha zero, is not premultiplied. No whole RGBA copy,
input/output native handle, or callback crosses a JavaScript safepoint. Error
paths release partial outputs and clear libvips's shared error buffer. The application serializes native raster
work so cleanup cannot discard another operation's pending diagnostic.

The fixed known matrix profiles, fixed RGB strip size and one worker prevent
image-size-dependent CMM/output allocations. The existing 32 MiB color reserve
is separate from the exact whole-image RGBA output and is mutually exclusive
with the bounded decoder phase. This is not an interposed hard budget on
libvips internals. The full process RSS contract needs its own measured product
campaign; the producer's tiny functional checks do not qualify that contract.

Production is pinned to existing isolated clean-install image IDs recorded in
each target manifest. These images contain Node26.10.0 and the exact separately
sealed installed Linux CODECS profile. Run only one heavy container at a time,
with --cpus 2 --memory 1g --network none. Mount this producer into
/workspace/tooling/raster/linux-color. Supply IE_LINUX_COLOR_BUILD_IMAGE equal
to the immutable image ID, then use:
  node tooling/raster/linux-color/build.mjs --adopt
for a new absent versioned target, or --verify against its retained artifact.
The producer does not overwrite a target. Adoption copies the new target and
its generated server/raster/linux-color-<arch>-identity.ts out of the container.
The two fresh compile directories must be byte-identical. A second fresh
container must reproduce the complete artifact and manifest without changes.

Each build runs the mock ownership/failure harness and exact pixel checks in
both dynamic-library load orders. The tests cover an independent four-color
oracle, strip boundaries/tails, hidden RGB/alpha, 20,000-pixel lossy/lossless P3
WebP versus the exact frozen Sharp decoder/color output, refusal of unsafe
cache/concurrency settings, and retry. x64 on Apple Silicon is explicitly
emulated functional evidence, never a native x64 timing or RSS result.

Cheap offline seal check (no compiler or container):
  node tooling/raster/linux-color/verify-seal.mjs --arch arm64
  node tooling/raster/linux-color/verify-seal.mjs --arch x64
