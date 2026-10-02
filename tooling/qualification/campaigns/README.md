# Executable PERF-8+A3 campaigns

This directory implements the fixed P and Q3 inventories in
[`docs/spec/performance.md`](../../../docs/spec/performance.md). Core selects
22 P jobs or 16 Q3 jobs; the current adapter capability adds eight P or three
Q3 jobs. Training is not an implemented capability and cannot be selected.

Use Node 26.10.0 and npm 12.1.0. The default command only prints a plan:

```sh
.toolchain/bin/node tooling/qualification/campaigns/run.mjs plan \
  --campaign P --features adapters
```

The existing `tooling/qualification/runtime.mjs --campaign P` entry point routes
to this controller. Without an explicit campaign, that older entry point remains
the separately labelled exploratory raster smoke.

## Preparation and execution

Prepare actual immutable product fixtures using [FIXTURES.md](FIXTURES.md).
`--fixture-manifest` takes a sealed fixture descriptor or verified fixture catalog,
including exact `WC:<bytes>` keys when a job needs several portable sizes. The
controller rehashes the selected workload and retains the consumed manifest.
Missing producers, inputs or native capabilities are prerequisites; the runner
does not reduce workload sizes or substitute passing functional tests.

Build and browser preparation belong to the developer C0–C6/H0 stages. The
configuration names their `developerStateDirectory`; later runtime jobs resolve
the completed, sealed source copy and its actual build outputs. `--repo` names
the subject checkout, which can differ from the controller checkout. Both source
identities are recorded. The product build must match its original subject and
the retained build commands and logs. H0 verifies the C2 artifact handoff and
prepares its own native dependencies and browser cache.

```sh
.toolchain/bin/node tooling/qualification/campaigns/run.mjs run \
  --campaign P --features adapters --jobs C9 \
  --repo /absolute/subject-checkout \
  --configuration /absolute/retained-configuration.json \
  --fixture-manifest /absolute/fixture-catalog.json \
  --host-attestation /absolute/host-attestation.json \
  --output artifacts/qualification/new-c9-run
```

Output must be a new canonical directory under the subject's `artifacts/`.
Configurations and host attestations are parsed and hashed from the same opened
bytes, then retained in the receipt. A host attestation names hashed evidence,
the actual host identity, and an observation interval. The default interval is
24 hours; an explicit `validUntil` may extend it to at most 72 hours for a long
paired campaign. Independently observed hardware or OS mismatches cannot be
overridden by an attestation. `--diagnostic` permits work on a nonqualifying
host while retaining the ineligible verdict.

The CI controller under `../ci/` owns serial C/H job ordering, artifact handoff,
base then candidate execution, the adapter branch and selected Q3 work. It
derives and seals per-session configurations. Run developer and product jobs as
separate invocations so each runtime invocation validates completed preparation;
a mixed developer/runtime invocation is rejected. A selected-job PASS never
claims that the whole P or Q3 graph has completed.

## Observations and receipts

Cold starts have separate child processes. Each warm cell has one additional
process that retains its declared product/browser owner through unscored primes
and scored operations. Reset work is explicit and retained. For WJ/WC the
warm-input proof binds every actual scheduled attempt, including primes, to the
same live owner and exact operation input. Zero-prime correctness cases retain
that declared schedule; they claim initialized connection/module state, not an
unobserved earlier operation or decoded-cache hit. Caption parsing/projection,
native source validation and portable hashing remain real per-operation work;
these paths do not substitute a persistent decoded/derived result cache. OS
page-cache state remains unobserved. Earlier immutable outputs are disclosed
rather than erased to manufacture a fresh global store. Editor memory
lifecycles keep the same main processes through B0 and all cycles, with actual
30-second idles, scheduled worker restarts and five real 30-minute windows for
100-cycle campaigns. There is no forced GC or timer substitution.

Each attempt is recorded in an append-only hash-chained journal, alongside its
reset, actual operation, assertions, phases, measurement methods and source
evidence. Missing, failed, interrupted and right-censored observations remain in
the planned denominator. A failed or incomplete group stops execution; later
required starts remain explicitly missing. Success-only summaries are diagnostic.
R10 consumes the complete same-worker synchronous kernel union, verified against
the actual composition dimensions and layer count. The bounded interval prefix
does not replace its complete scalar total. File I/O, encode/decode and yields
remain in a separately retained wall parent; that wall duration cannot stand in
for active computation or manufacture an R10 ceiling failure.

Interaction evaluation joins only the exact sibling P-I session, ten reset
first-use observations and three hot edits. Q3 uses its independent session and
hot-edit cohorts. Canonical Web Vitals reports come from pinned `web-vitals`
6.2.2, finalized by a real visit lifecycle; interaction samples and animation
callbacks are not INP substitutes. A declared 60-second observation window is
distinct from actual capture stop and timer lateness, which remain recorded.

Brush sessions retain one explicit unscored image/Mask/64px/view setup and a
fresh local mask draft before the segment. Each scored stroke uses the public viewport
geometry after pan, zoom and layout gestures. Its native down, 118 moves and up
are bound to the successful product draft's geometry hash and actual target;
there are no hidden per-stroke Fit or toolbar actions. Setup remains in whole-job
time and the canonical page-visit INP. Scheduled 60 Hz delivery, actual native
event times and physical presentation evidence are recorded separately.
The 80 discrete gestures include 20 actual Undo-mask-stroke actions and ten each
of pan, zoom, layer selection, theme, density and split control. Each counted Undo
proves the draft operation count changes from one to zero, preserving every
immutable stroke witness and keeping the authored draft inside its real cap.

D11 uses additional predeclared byte-audit cohorts with the same workload,
browser, cache, prime and sample inventory. They execute in fresh isolated
processes after the scored groups. Precise JavaScript coverage changes code
optimization, so audit visits never contribute timing samples. Their actual
module, resource, font and artifact observations have separate receipts linked
to the same immutable source/build/tool identities. Audit setup, execution and
cleanup count toward the original whole-job ceiling; no budget is enlarged to
hide this additional work. `byteAuditGroups` retains these independent attempts,
`jobExecutions` records job stages, and `controllerTiming` charges host/source
preparation and final evidence hashing to the enclosing jobs. I5a/I5b use their
declared combined envelope; an isolated half cannot certify that paired budget.

The host timing lease excludes other owned campaign controllers on the same
physical machine. A developer child can borrow that lease only through a
validated live parent and exclusive borrower record. Timeout cleanup targets
only recorded owned process groups, with process birth identity checks.

```sh
.toolchain/bin/node tooling/qualification/campaigns/run.mjs verify \
  --receipt /absolute/subject-checkout/artifacts/qualification/new-c9-run/receipt.json
```

Verification rehashes the complete retained metadata inventory, input bytes,
build logs, source/build identities, journals and controller results; it rebuilds
the current exact plan and recomputes the verdict. An edited summary, missing
tool row, stale product build or detached action record cannot certify a run.
Raw receipts have a 90-day minimum and aggregate summaries a 365-day minimum;
release-defining evidence additionally follows the supported release lifetime.
The harness never prunes evidence automatically.

Lifecycle resource receipts preserve the distinction between queried texture
limits and a renderer that owns no texture API. The Canvas2D declaration can
make the texture-size check inapplicable only with an exact reviewed source
closure, sealed native renderer and matching production build proof. The
controller retains that proof once before B0; each 100ms sample records its
compact identity and actual RGBA backing estimate. Device-limit fields remain
null. Offline verification replays the retained bytes and rejects mixed proof
identities. An unreviewed renderer or incomplete allocation ownership remains
INCONCLUSIVE; memory, cache, handle and process RSS requirements still apply.

## Capability limits

Implementation and test execution are separate from a qualified campaign. The
prescribed C/H hardware, physical N network, complete application allocation
ledger, true native IME input and physical display presentation require actual
evidence. Stock renderer Paint/DrawFrame events, DOM witnesses, simulated network
pacing and declared allocation constants cannot supply it. Unsupported evidence
keeps the relevant result INCONCLUSIVE while preserving real action diagnostics.

A source checkout or passing pure tests do not establish performance
qualification. Run the coordinated repository gates, actual fixture preparation
and complete selected campaign before making that claim. The pure harness
tests are under `tests/campaigns/`; the protocol
evaluators also have tests under `tests/qualification/campaigns/`. Large fixture,
native browser, transfer and soak tests require their documented explicit setup
and must not run concurrently with timed campaigns.

## Actual native IME admission

The two existing I10H `text.native-ime` cold cells have an optional live admission
route. It preserves the exact 60-second Japanese/WXn and Simplified-Chinese/WXs
sessions: ten compositions, eight commits, two cancels, six presentation requests.
It does not change IText's synthetic 106-action plan or supply physical paint,
scanout, complete R07, canonical INP, or a language-distribution claim. Those
missing authorities still keep the corresponding metrics inconclusive.

Use the existing pinned campaign runner, sealed native fixture catalog, prepared
browser/build identity and real headed browser. Add only this browser setting to
the consumed campaign configuration (paths identify externally authored files):

```json
{
  "nativeIme": {
    "kind": "native-ime-selection-1",
    "operatorPaths": {
      "WXn": "/absolute/original/japanese-operator.json",
      "WXs": "/absolute/original/chinese-operator.json"
    },
    "armTimeoutMs": 30000,
    "reviewTimeoutMs": 120000
  }
}
```

Each operator file is `native-ime-operator-1` with `actualNative: true`, an
`operatorId`, `method: {kind: "human" | "os-automation", description}`, actual
`os: {name, version, build}`, `inputSource: {language, id, build}` (language is
`japanese` or `simplified-chinese`), and nonempty `dictionary`, `settings` and
`evidence`. Every evidence entry has an original absolute ordinary-file `path`,
exact positive `bytes`, prefixed SHA-256 `sha256`, and a `role`; at least one must
have role `os-input-settings`. Metadata and original evidence must describe the
real selected OS/input source. The collector never creates this attestation or
changes OS settings. Review beforehand that the operator can finish the declared
sequences in 60 seconds. A true OS automation method must use the actual input
source; browser synthetic dispatch or `isTrusted` flags alone cannot establish it.

The browser owner opens the retained native text layer and verifies its fonts
before arming. Wait for `native-ime-ready` in the existing worker journal and its
private `native-ime-<nonce>/ready.json`. The armed observer is passive: it does
not type, set a value/range, transfer focus, or dispatch input. The first trusted
editor input starts the exact 60-second window. The nonce directory contains the
sealed plan, source/build/browser/worker/fixture binding, and instructions. Use
the existing corpus fragment at index 10 (`日本語`) for Japanese or index 3
(`中文`) for Chinese. Native preedit is permitted; only the requested final
fragment earns a commit. Retain actual source settings and native-session review
evidence separately; avoid private user text in screenshots or recordings.

Perform plan sequences 0–9 in order. Sequences 0–6 and 8 commit; 7 cancels the
composition and restores its starting text; 9 cancels the editor session through
its existing **Cancel text edit** control while composition is active, then ends
native composition. Before sequences 0, 1 and 2, request the public presentation
switch with a forward, backward and collapsed native selection respectively.
During sequence 8, finish the intended preedit text, then request two switches;
the latest must settle only after native end. Do not change the candidate text
between those requests and commit. During sequence 9, request one switch before
explicit Cancel; its token must be rejected at the actual Cancel/native-end
boundary. Keep the same textarea connected and focused throughout composition.
Use native selection to replace sufficient existing text if the fixture is near
its text-byte cap; the oracle derives the expected result from the actual range.
Do not Apply, start another composition, or change accepted document/layer state.

After capture, the collector first retains bounded `raw.json`, then seals its
identity in `raw-seal.json`. An independent real reviewer must atomically place
`review.json` in that fresh directory within the configured review wait. The
review must contain `kind: "native-ime-review-1"`, `complete: true`,
`actualNative: true`, `synthetic: false`, `collectorGenerated: false`, a distinct
`reviewerId`, actual review `method` and `observations`, `reviewedAt` ISO time,
matching `inputSource` and `nonce`, and exact `binding`, `raw`, `plan` identity
objects copied from the sealed request. Its original `evidence` entries use the
same bounded pin schema and include role `native-session-observation`. The
reviewer must actually inspect the native session and OS/source evidence; copying
these flags is not a substitute. The collector produces no passing template and
cannot self-review. Evidence copies are private, at most four files of 1 MiB per
operator/review; structured authority files are limited to 64 KiB and raw events
to 8 MiB. Original files must be nonsymlink ordinary files with matching pins.

The review wait is outside the measured 60 seconds but remains inside the
original attempt, controller timing and existing job ceiling. Missing, late,
incomplete, synthetic or invalid review is INCONCLUSIVE. No receipt is rewritten
or promoted later: an independent retrospective note cannot turn an old capture
into a fresh campaign attempt. The existing receipt verifier replays the retained
bytes and joins the current worker journal, exact source/build and owned browser,
fixture, accepted-state invariant, operator/source evidence and independent
review before issuing its private process-local compatibility token. Serialized
booleans or copied tokens cannot confer that authority. Pure test fixtures are
explicitly synthetic and never constitute physical/operator qualification.

Browser epoch timestamps must also fall inside the fresh worker capture/ready/seal
UTC brackets. This identity check permits at most 100 ms of conservative epoch
rounding; it is not observed clock precision or a latency/physical-presentation
bound. The raw interval and event windows remain exactly 60 seconds. A shifted
trace or clock movement outside this admission tolerance cannot be qualified.


### Ordinary text application observations

The owned browser driver observes the existing Preview, Apply and reload actions
for `text.font-set`, `text.active-layout`, `text.apply` and `text.mixed-ready`.
It adds no user action, mutation or presentation request, changes no scheduler
order, and retains a per-attempt nonce, fixture/source/build/browser/process
binding and bounded raw observation. The receipt verifier replays those sealed
bytes and joins the existing worker journal and consumed developer runtime state
before issuing a process-local proof. Serialized tokens or result rows cannot
establish that proof.

After the original action, read-only public protocol collection verifies the
complete current document image root, every current text layer (including hidden
layers), typed font/source identities, and each distinct font file's actual bytes.
Only `R35CurrentFontFaces`, `R35SingleFontBytes` and `R35CurrentFontSetBytes` may be
filled by this path. A visible native draft additionally requires the exact
independently admitted unchanged Preview lineage and current native text hash.
Reads are sequential, abort-owned and bounded: 100 layers, 16 distinct font files,
16 MiB per file and 64 MiB per current union. These are current-state counts, not
CPU/GPU peaks, zero substitution violations, or a complete R07 memory ledger.

The phase rows retain their actual meanings. `text.font-ready.worker` measures
only the worker's font-ready span and excludes engine startup.
`text.preview.render-submitted` ends after preparation and canvas submission;
`text.apply.authority-durable` ends at the actual accepted authority response.
The new navigation observation binds the current session, document generation,
validated recovery publication, document/image/composite root and browser time
origin. It separately records stored authoritative model availability, exact
canonical canvas submission (or observed existing residency), and committed
public document edit controls. Navigation values are current-episode upper
bounds, with `durationMs: null`; they cannot prove a ceiling failure or fresh
all-text shaping. Recovery normally uses accepted retained layouts and an
accepted composite, so no extra shaping is requested to manufacture a metric.

These observations do not establish first presented pixels, physical scanout,
refresh-slot/missed-frame attribution, canonical input latency or full R07.
Missing physical authorities remain INCONCLUSIVE and the existing scheduler
still stops at its first non-PASS cell. The phase reducer also refuses dropped
or invalid diagnostic traces: the existing 32-worker-trace ring may lose child
timing admission in a long warm group. No counter is reset and no sealed
renderer profile input is changed to conceal that bounded limitation.

The ordinary raw artifact is limited to 4 MiB, its binding to 128 KiB, and each
public JSON read to 256 KiB (the full font collector separately bounds its image
projection). Native text is hashed with a 16 KiB ceiling and is never retained;
preview readback is limited to 1,048,576 pixels. The new navigation state uses
the existing diagnostic allocator with a fixed 32 KiB allowance. Synthetic
protocol/replay and actual-controller unit tests validate refusal and ownership
logic; they do not provide a physical or native-IME qualification receipt.
