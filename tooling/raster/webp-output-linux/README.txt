Linux WebP output bridge recipe
==============================

This separate recipe preserves the already sealed Darwin producer and all common
C, header, test and verification files in their original directory. It binds that producer's manifest hash and
requires every inherited input to match it exactly. No decoder/color implementation
or artifact is changed. The common NOTICE.txt remains the source provenance notice.

The initial common recipe's Linux dependency audit rejected the glibc arm64 loader
listed alongside libc.so.6. The retained failed attempt is not a product failure.
This Linux recipe permits only libc.so.6 and the matching architecture-specific
glibc ELF loader, as the existing bounded-decoder producer does. It still rejects
RPATH/RUNPATH, heap/codec/thread/dynamic-loader imports and non-IE exports.

Use the retained offline Linux arm64 or x64 native builder, copying both complete
producer directories and the inherited Darwin output manifest/artifact, existing
decoder/color inputs, and fixtures to their repository paths. Set the exact
IE_WEBP_OUTPUT_BUILD_IMAGE=sha256:<retained-image-id>, limit to two CPUs, and run:

  node tooling/raster/webp-output-linux/build.mjs --adopt
  node tooling/raster/webp-output-linux/build.mjs --verify
  node tooling/raster/webp-output-linux/verify-seal.mjs <sealed-identity.json>

Adoption refuses existing targets. The manifest seals inherited producer inputs
and these platform producer inputs separately. Native parity, cleanup/error tests,
toolchain/environment identity, and two fresh exact builds remain mandatory.
Runtime identities bind both input sets and the exact decoder/converter artifacts.

Lease refusal after an injected munmap failure applies to that loaded library
instance. Reloading the library is not a process-wide cleanup or safety mechanism;
nonzero remaining bytes must be reported/refused by the application, with whole
process RSS admission maintained. No complete application resource qualification
is implied by these producer tests.

The first Linux native invariant attempt demonstrated that a same-size write
may not advance file timestamps during the test interval. The original test is
preserved. The Linux-only bridge-test.c snapshot changes that one mutation to a
same-size write followed by explicit mtime advancement, making the stamp-change
fence test deterministic without changing production C or claiming detection
of arbitrary same-size writes that preserve all observable timestamps. This test override is separately sealed in platform inputs.

Docker copy preserves host file ownership. Run the copied input/output workspace
as its matching unprivileged UID/GID (this host501:20), with network disabled,
all capabilities dropped and at most two CPUs. Copy an owned empty server/raster
staging directory too so generated identity files have a writable destination.
The retained Docker configuration is part of execution evidence.
