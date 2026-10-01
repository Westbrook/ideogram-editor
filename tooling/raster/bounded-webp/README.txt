Bounded WebP producer (Darwin arm64, libwebp 1.6.0)
=================================================

This producer adds a separately versioned decoder. It never changes the existing
Sharp/libvips binaries, libwebp tarballs, historical codec identity, or evidence.
The retained archive is the upstream release from:
https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-1.6.0.tar.gz
SHA-256: e4ab7009bf0629fd11982d4c2aa83964cf244cffba7347ecd39019a9e38c4564
The archive was fetched over HTTPS. Its origin and byte digest are recorded; no
separate upstream signature verification is claimed. COPYING, PATENTS, and AUTHORS
are copied verbatim from it into the versioned vendor directory.

Use the repository's pinned Node 26.10.0 / npm 12.1.0 toolchain. No packages are
installed by the producer. Apple's existing Xcode clang and macOS SDK are used.
The manifest seals their version, compiler-binary digest, exact flags and commands,
all compiled upstream source members, local producer inputs, and native exports.

  PATH="$PWD/.toolchain/bin:$PATH" node tooling/raster/bounded-webp/build.mjs --verify
  PATH="$PWD/.toolchain/bin:$PATH" node tooling/raster/bounded-webp/verify-seal.mjs
  python3 tooling/raster/bounded-webp/verify.py

--verify extracts the pinned archive twice into fresh directories, compiles both,
executes a producer-only allocator invariant harness, compares complete dylib bytes
(including the content-derived Mach-O UUID and code signature), and compares with
the checked-in seal. It does not normalize away differing binary fields. All
upstream sources are unchanged. allocator-redirect.h substitutes libc allocation
functions in every upstream translation unit after including libc declarations.

--adopt is reserved for producing a NEW reviewed version. It writes that version's
new dylib/manifest/notices and server/raster/webp-identity.ts. Once a version is
sealed in history, create a new version instead of editing its archive/artifacts.
All builds remain in temporary directories and are removed after verification.

Native memory boundary
----------------------
Each live codec allocation uses a private anonymous read/write mmap. Its mapped
length is rounded to 16 KiB including a max_align_t-aligned private header, and
that exact mapped length plus a 64-byte per-block allowance is charged BEFORE
mmap. The native OS page size must divide 16 KiB; other page sizes fail closed.
Overflow fails closed. munmap releases the entire mapping before accounting is
debited. A realloc must afford both old and new mappings until the copy is done.
This avoids malloc arena/cache reuse: observed malloc_size exceeded
malloc_good_size by almost 4 MiB for a 12.8 MiB request in this host process. Failed allocations
preserve existing blocks. The cap belongs to a decoder lifetime; creating another
decoder cannot reset it. Any incomplete cleanup keeps the library lease closed.

All upstream C allocations are redirected, their object imports are inspected,
threaded decode is disabled, and only the explicit IE namespace is exported.
The independent upstream functions inside Sharp are not interposed or replaced.
The decoder supports straight RGBA for static VP8, VP8L, and VP8+ALPH sources.
Application parsing/admission remains responsible for allowed RIFF chunks, static
content, expected dimensions, input identity, and output buffer ownership.

Use IEWebPDecodeRGBA for workers. This single synchronous native call owns all
codec resources, reads the already-open fd with pread (leaving its position alone),
decodes incrementally, checks output dimensions and pointer, deletes the decoder,
and reports peak/live/denied before returning. Thus a Node Worker termination
cannot leave native handles across JavaScript safepoints. Discard output on failure.
The exposed incremental interface is for trusted native diagnostics and requires
normal C lifetime discipline: no stale pointers, and exactly one delete per handle.

This cap is a native live-allocation bound, NOT a process RSS bound. The caller's
RGBA allocation, the 64 KiB stack input chunk, kernel mapping metadata, loaded
libraries, JS/runtime memory and file/OS overhead require separate conservative
admission and process measurements. A difficult but valid file can return allocation
failure; it must become a resource refusal without silently switching to an
unbounded decoder. Passing differential fixtures does not qualify all images or
platforms. Other operating systems/architectures need their own sealed build.

verify.py tests complete pixel hashes, transparent hidden RGB, lossy alpha and
25 MP fixtures against the existing sealed libwebp C API in both library load
orders, plus allocation refusal, lease isolation and cleanup. This is a pinned
codec differential, not an independently implemented decoder oracle.

Fixed-profile color conversion
------------------------------
IEWebPConvertP3RGBA performs the already qualified P3-to-sRGB RGB8 transform in
one synchronous C call. Server code verifies the exact two 480-byte ICC inputs
and obtains the six public LCMS function addresses from the existing sealed
libvips library. The wrapper does not dynamically open a library or introduce
another LCMS dependency. It checks LCMS 2.19's version code, uses 96 KiB of stack
scratch, preserves all alpha bytes, and closes every profile/transform on every
return path. Its fixed-profile CMM allocations are separately reserved by the
caller; they are not included in the WebP decoder's mapped-allocation budget.
color-test.c verifies failure cleanup, delete/close order, busy rejection, RGB
conversion including hidden RGB, and alpha preservation through a mock CMM.
