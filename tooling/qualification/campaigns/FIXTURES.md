# PERF-8+A3 fixture preparation

`fixtures.mjs` performs no work at import. Call `setupFixture` with an absolute,
new `artifacts/` output directory and `allowHeavy: true` as a separate preparation
step. Complete W2 or WC4G preparation is deliberately large. It never scales
sizes, reduces event counts, writes sparse placeholders, reuses a single raster
identity as independently imported originals, or reports staged PNGs as retained
provider candidates.

The generated input corpus includes full-dimension patterned opaque JPEG and
alpha PNG originals, one complete grayscale mask, independent candidate bytes,
100 distinct 120-sample brush strokes, and real bounded-memory 8/32 MiB transfer
payloads. WXn/WXs text is exactly 32 KiB/1 MiB UTF-8, with the stated frame and
logical-line limits. Input generation is outside sample timers, while hashing,
staging, decoding, admission, and other actual measured operations stay inside
their own required sample boundaries.

`fixture-product.mjs` uses the production writer and commands for images,
metadata, queue state, checkpoint history, and snapshots. Its only preparation
hook controls when the production snapshot scheduler runs so the sealed root
can retain the required 500-event tail. It does not alter SQL records. The root
is reopened through normal production validation before acceptance. Metadata
counts, event-type histograms, snapshot sequence, and actual current image state
are retained. W0 excludes its unavoidable DocumentCreated event from its zero
user-history count and separately records that one storage event. WQ preparation
leaves the single dispatch slot free: the individual fault sample creates and
observes its own active attempt inside its timing span.

Actual result-bearing and active attempts require a production candidate seeder.
Native mixed documents require actual browser worker layout/render and durable
native admission. Full WC closures require actual production references and
verified portable output. The fixture must fail preparation if these producers
are absent. Merely generating the expected bytes or copying expected counts
into a manifest is not enough. There is no metadata-only compatibility fallback.

The final `fixture.json` records the concrete observed product counts, source
corpus file identities, and every stopped-root file. `verifyFixtureManifest`
rehashes those bytes and rejects incomplete preparation or a changed root. Cold
samples use an isolated copy of that sealed root; the source root is never
opened for mutation. WJ/WC warm cohorts retain their actual writer connection
and module owner through the exact declared primes and scored operations. WJ
public Undo restores the operation's image/native state and history head while
its revision and immutable history advance; the original input closure is
fully rehashed. WC revalidates the full sealed source and compares every output's
ordered entity/event/object closure with the original archive. Import cleanup
must finish before the next input. The sealed per-attempt proof records exact
global count/byte growth separately; that growth is not a fresh-root claim or a
subtraction from WQ's fixed inventory. WQ and repeated fault cells retain their
existing holds unless their own complete workload/reset proof exists. Failed
preparation leaves its output and an incomplete receipt available for inspection.

## Qualification fonts

`fonts.mjs` produces a separate qualification-only corpus from exact official
Noto commits. `fonts.lock.json` seals the 16 unchanged static regular faces and
two complete OFL notices. It never edits shipped `vendor/text` inputs. Acquiring
bytes requires explicit `allowNetwork: true`; offline fixture verification never
fetches a replacement. Every face passes static container/style/embedding checks,
actual hash and license verification, and the selected corpus passes actual cmap
glyph checks for the script corpus. These preflight checks are fixture controls;
production text admission still performs its own font checks and layout.

The four normal faces are Noto Sans Arabic, Devanagari, Symbols2, and the official
SC regional subset. Their combined bytes are 9,447,856, below 16 MiB. The sixteen
stress faces total 11,445,884 bytes, below 64 MiB. The normal SC face supplies Latin
and acute/grave combining marks; no system font fallback is required. The glyph
corpus uses monochrome symbol emoji, without claiming arbitrary color emoji.
The upstream SC file is already a published regional subset; this producer does
not modify or subset font bytes.

Known prepared source manifest:
`artifacts/full-implementation/qualification-fonts/corpus-02/fonts.json`.
Its SHA-256 is
`89c0486f1617830924734c719be1312c8b05eacf819894dd4fa5966c91e69ead`.
The first network attempt failed under the filesystem/network sandbox before
acquisition. The completed acquisition initially detected unsupported U+0308 in
the normal four-face union; the unmeasured script was corrected to use U+0300
alongside U+0301, and both full workload unions were then verified. No performance
sample was run with the unsupported script.

`setupFixture({workload: 'WF', ...})` prepares a real empty product root and the
complete fixed Fast result-input matrix: 512/1024/2048 square PNG/JPEG, four
independent outputs per format/size. The separately identified 8 MiB fault PNG
retains its exact 512-square pixels and uses PNG3-permitted unused trailing IDAT
bytes to make transport/storage work exactly 8 MiB. That padding is disclosed in
its file record; no arbitrary binary is called an image. Each fault or valid
workflow still creates its own queue/attempt inside the measured workflow.
W1/W2/WX fixtures additionally seal actual alpha lossy and lossless WebP inputs
as `raster-codec` records. They do not inflate the independent layer-original
count.

Pass the full setup result to `verifyFixtureManifest`, or pass its manifest path
with the separately retained `{seal: {path, sha256}}`. A manifest cannot certify
its own rewritten metadata. The original product preparation receipt remains an
unchanged, separately hashed file; normalized outer observations do not rewrite
its inner receipt identity. `options.repo` selects the actual product build for
writer/native/candidate preparation, while the fixture generator remains the
shared control harness.

The separate `WNarrow` producer uses actual 8192×3000 PNG/JPEG input files and
real staging, raster preparation, explicit review/approval, and one visible
imported layer. It verifies the retained original, canonical pixels, and exact
image state after a normal writer restart. Its ordinary initialization events
remain visible in the receipt; it has no 10k/100k event-count or snapshot-tail
cohort. The two narrow decode cells select their actual declared codec.

Corpus revision `perf-8-a3-corpus-2` fixes the final stroke specimen coordinate:
pointer-up stays at the final move's position, with its separate 120th timestamp.
This produces the same 120-sample gesture through the documented Playwright mouse
API in all three engines. WQ additionally includes its own real 2048-square PNG
result of exactly8MiB, without prestarting the individual timed fault's attempt.

## Preparation and catalog commands

Use the pinned toolchain and prepare each complete workload outside the campaign:

```sh
.toolchain/bin/node tooling/qualification/campaigns/fixtures-run.mjs prepare \
  --workload W1 --output artifacts/qualification-fixtures/w1 --allow-heavy
```

The command writes `fixture-input.json` only after verifying the complete result.
This descriptor retains the absolute manifest path and its separate SHA-256 seal;
pass it to the campaign's `--fixture-manifest` option. A bare `fixture.json`
cannot establish its own identity. Preparation checks Node 26.10.0 before writing
any fixture bytes and refuses existing output directories.

Native workloads additionally take `--font-corpus` with the verified font manifest
above. Portable workloads take `--workload WC --closure-bytes 536870912` (or
`4294967296`) and `--seed` pointing to the actual mixed seed JSON containing its
root, document ID, and sealed archive descriptor. WA accepts `--official-adapter`
for the retained public example. These prerequisites never trigger a provider
call or silently replace an absent retained input.

For jobs spanning several workloads, assemble a new catalog from verified
descriptors:

```sh
.toolchain/bin/node tooling/qualification/campaigns/fixtures-run.mjs catalog \
  --output artifacts/qualification-fixtures/catalog.json \
  --fixture W1=artifacts/qualification-fixtures/w1/fixture-input.json \
  --fixture WC:536870912=artifacts/qualification-fixtures/wc512/fixture-input.json
```

Catalog keys use workload IDs, with exact portable byte counts in `WC:<bytes>`.
An optional `--cell EXACT_CELL_ID=@W1` selects that verified workload for one cell;
a descriptor path can also be supplied after the equals sign. Catalog creation
verifies every referenced source, refuses duplicate or mismatched keys, and
writes a new file without merging or overwriting previous evidence.
