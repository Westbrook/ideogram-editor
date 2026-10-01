WebP file output bridge (separate immutable native version)
=========================================================

This producer adds file output transport around the already sealed decoder and
color converter. It never changes those libraries, source archives, identities or
pixel algorithms. dependencies.json binds each of Darwin arm64, glibc Linux arm64
and glibc Linux x64 to its exact existing decoder and converter hashes.

The bridge creates one anonymous private RGBA mmap inside a synchronous C call.
It calls the existing decoder, then writes successful output to a private owned
file using checked pwrite requests of at most64KiB. The color path reads the same
file in bounded pread chunks, invokes the existing converter, and writes back.
The anonymous mapping is unmapped before returning. No native pixel pointer or
handle survives a JavaScript safepoint. A disk error is a normal status result;
pixels are never backed by MAP_SHARED output pages that could SIGBUS on ENOSPC.

The caller supplies descriptors and verified native symbol addresses and retains
their owning libraries for the whole call. Output files must be owned0600 regular
singly-linked files opened O_RDWR; decode requires an empty output distinct from
the source. Dimensions are limited to8192 per side and25MP. Caller code owns path
authorization, source identity admission, private directory and temp reservations,
fsync and cleanup. Every nonzero status requires discarding the output. Descriptor
positions are unchanged. C metrics include the whole actual page-rounded output
mapping; native decoder/color and process/runtime memory are separately reserved.

This transport avoids retaining a full-image Buffer in the JavaScript allocator.
It does not alone qualify combined writer+worker RSS, all image formats, concurrent
jobs, or repeated application imports. Those remain application-level campaigns.

Use Node26.10.0 from the pinned repository toolchain. For each target, use --adopt
once and --verify thereafter. Adoption refuses an existing target directory.

  PATH="$PWD/.toolchain/bin:$PATH" node tooling/raster/webp-output/build.mjs --adopt
  PATH="$PWD/.toolchain/bin:$PATH" node tooling/raster/webp-output/build.mjs --verify
  PATH="$PWD/.toolchain/bin:$PATH" node tooling/raster/webp-output/verify-seal.mjs \
    vendor/raster/webp-output/1.0.0-ideogram.1/darwin-arm64/identity.json

Darwin uses the existing Xcode clang/SDK and records its identity and exact flags.
Linux uses the existing retained native producer image for the matching actual
architecture (or explicitly reported emulator), with no new package installation.
Supply IE_WEBP_OUTPUT_BUILD_IMAGE=sha256:<retained-image-id>. Copy this complete
producer directory, each existing dependency artifact named in dependencies.json,
and tests/raster/fixtures into the container's /workspace, preserving repository
paths. Run offline with --network none. The Linux manifest records the image ID,
package inventory and compiler identity/specs. Retain container evidence on failure.

Both modes build twice in fresh directories and compare complete dylib/ELF bytes
including UUID/signature/build ID. The library exports exactly three IE symbols
and imports no decoder, color converter, heap allocator, thread or dynamic loader.
The producer tests descriptor rejection, offsets, source/output mutation, native
failure cleanup, mapping/I/O errors, retry, busy refusal and an injected failed
unmap that must retain its lease/live count. Native fixture verification compares
the new file bytes with the unchanged decoder for all seven static fixtures,
including alpha/hidden RGB and maximum25MP lossy/lossless, plus repeat and refusal.
Source, environment, tests, native dependencies, validation and complete artifact
bytes are sealed. The generated server identity binds decoderHash/converterHash
to the same sha256:-prefixed values used by runtime profile selection.
