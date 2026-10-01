Linux arm64 and x64 codec profile producer, version 1.0.0
================================================

This is a separately executed profile of Sharp 0.35.4 and its six exact Linux
arm64 or x64/glibc dependency packages. The original macOS codec receipt and generated
identity are preserved and checked. A profile is adopted only after actual clean
npm ci using Node 26.10.0, npm 12.1.0, an empty node_modules and an empty cache.
The producer never labels the macOS binary or its versions as Linux evidence.

The expected package records are frozen independently in expected-packages.json
and expected-packages-x64.json, one actually executed architecture at a time.
Capture checks the selected root lock records, actual installed package names and
versions, every package file, directory and resolution realpath, the exact Sharp
native binding in Node's require cache, and the actual libvips shared object in
Node's process report. Symlinked package roots/files, nested Sharp dependencies,
local native builds and additional loaded libvips binaries are rejected. The
original ICC files and all actual Sharp component versions are included.

Use an immutable Ubuntu 24.04 digest, not a mutable tag, and retain the built image
ID. apt repository state is mutable; the builder ID identifies the actual image.
The clean install receipt records both image identities, package/lock hashes,
command/log hashes, timestamps and glibc version. It preserves the exact install
package.json and package-lock.json beside the new profile. Each producer input
and each original sealed source input is hashed separately. CODECS identity is
deterministic for the installed bytes; install timestamps are outside CODECS.

  docker build --platform linux/arm64 --build-arg BASE_IMAGE=<immutable-image> \
    --iidfile artifacts/linux-codecs-image.txt \
    -f tooling/raster/linux-codecs/Dockerfile .

  docker run --name <unique-name> --cpus 2 --memory 1g --cap-drop ALL \
    --security-opt no-new-privileges \
    -e IE_LINUX_CODECS_EXECUTION=native \
    -e IE_LINUX_CODECS_BUILD_IMAGE=<saved-image-id> <saved-image-id> --adopt

For x64 use --platform linux/amd64 and the corresponding separately built image.
Set IE_LINUX_CODECS_EXECUTION=emulated when the Docker host architecture differs.
Emulated execution establishes functional evidence only, not performance.

The image runs as unprivileged uid 1000; npm's native dependency installer must
not run as root with all capabilities dropped because its extraction may attempt
chown. Network is needed by npm ci only to fetch frozen integrity-checked packages.
The root file: vendor archives are copied unchanged into the isolated image.
No host node_modules, build outputs or evidence directories are copied. Retain
the container and artifacts/linux-codecs-install on both success and failure.

Copy these new paths from the retained container after successful capture:
  /workspace/tooling/raster/linux-codecs/1.0.0/linux-arm64
  /workspace/server/raster/identities/linux-arm64-v1.ts

Then verify the manifest, producer and archived install inputs on any platform:
  node tooling/raster/linux-codecs/verify.mjs

Use --arch x64 to verify the separate linux-x64 target and generated identity.
On a matching Linux architecture the command requires every currently installed codec
file and actual loaded Sharp/libvips profile to match. Current unrelated package
scripts may change; the six selected codec lock records may not. Reproduction
uses the archived package/lock, unchanged vendor files, exact producer and the
same retained image in another empty install; compare the resulting CODECS and
generated identity exactly. A failed run never overwrites an existing version.

This producer establishes dependency byte identity. Raster fixture pixels,
native FFI/color behavior, application storage/security, whole-process resource
limits and the full product qualification remain separate executable gates.
