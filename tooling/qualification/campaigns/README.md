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
and scored operations. Reset work is explicit and retained. Editor memory
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
