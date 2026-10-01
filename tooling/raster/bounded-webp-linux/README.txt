Linux bounded WebP producer (separate version; macOS seal preserved)
===================================================================

This producer targets glibc Linux arm64 and x64, one actually executed and sealed
architecture at a time. The source is the existing upstream libwebp1.6.0 archive,
SHA-256 e4ab7009bf0629fd11982d4c2aa83964cf244cffba7347ecd39019a9e38c4564.
It verifies the existing macOS producer manifest and inherited C sources before
use. The local allocator wrapper differs only in its explicit platform guard;
the original sealed files remain unchanged. No Linux runtime support is implied
until an actual artifact and CODECS platform profile pass their separate gates.

The GCC recipe preserves upstream sources, forces the same allocation redirects,
disables upstream threading, and exports exactly the nine IE wrapper functions.
The ELF dependency audit permits only glibc and its architecture-specific loader.
Every allocation charges the complete page-rounded anonymous mapping before mmap;
all decoder cleanup finishes inside a synchronous native call. Linux pages must
divide16KiB, otherwise decode refuses before allocation. The cap covers live codec
allocations; whole-process RSS, RGBA output and fixed-profile LCMS remain separate.
The README for the original producer documents the allocator and C ABI contract.

Use the immutable image built by Dockerfile with Node26.10.0. Initial selection of
the public Ubuntu24.04 tag is an explicit mutable selection; capture its digest
and use that exact value for the build. Retain the resulting image ID too: apt
repositories are mutable, so the base digest alone does not pin compiler packages.
The manifest captures the resulting image ID, full dpkg package list, compiler,
assembler/linker hashes, compiler specs, flags, commands and exact source bytes.
No claim of reproducible OS package installation is made. Native reproduction
uses the same retained builder image and compares the entire resulting ELF twice,
including its content-derived GNU build ID, with no normalization.

  docker pull ubuntu:24.04
  docker image inspect ubuntu:24.04 --format '{{index .RepoDigests 0}}'

Supply the captured ubuntu:24.04@sha256:<digest> in the following build argument.
Build with --platform linux/arm64 or linux/amd64 matching the requested target.
An emulated execution is functional evidence only; record it as emulated.

  docker build --platform linux/arm64 --build-arg BASE_IMAGE=<immutable-image> \
    --iidfile artifacts/bounded-webp-linux-image.txt \
    -f tooling/raster/bounded-webp-linux/Dockerfile .

Run offline with IE_BOUNDED_WEBP_BUILD_IMAGE set to the exact saved sha256 image
ID. Use a named container and retain logs/results even on failure. --adopt refuses
an existing versioned target. It writes a new vendor target with artifact,
manifest, source archive, notices and identity.json; it never edits runtime code.

  docker run --name <unique-name> --network none --cap-drop ALL \
    --security-opt no-new-privileges \
    -e IE_BOUNDED_WEBP_BUILD_IMAGE=<image-id> <image-id> --adopt

Copy /workspace/vendor/raster/bounded-webp/1.6.0-ideogram.2-linux/linux-<arch>
from the retained container into the same repository path. Verify its bytes with:

  node tooling/raster/bounded-webp-linux/verify-seal.mjs <target>/identity.json

To reproduce an adopted target, copy it into a new container of the SAME saved
image before starting it, then run --verify. The producer refuses any source,
compiler/environment, exact manifest or artifact mismatch. No sealed target is
silently replaced. Runtime catalog adoption is a distinct reviewable change.

The producer runs allocation overflow/refusal/lease/cleanup tests and the fixed
profile mock-CMM lifetime harness. It compiles a separate unmodified upstream
decoder without allocator redirects and checks seven actual fixtures in both
dynamic-library load orders, guards both output boundaries, checks fd offsets,
refusal/retry and zero live allocations. Existing alpha oracle bytes and
independently calculable white-output hashes must also match. This is a pinned
codec differential, not an independent decoder implementation. Native fixture
passes do not qualify application behavior, color conversion or process RSS.

Linux CODECS adoption additionally requires a clean npm ci from the frozen lock
and vendor inputs and exact Linux Sharp/libvips files. Never relabel the macOS
CODECS manifest or allow the native wrapper to bypass a missing platform profile.
