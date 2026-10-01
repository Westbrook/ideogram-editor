# Qualification tooling

Select Node 26.10.0 and npm 12.1.0 with `PATH="$PWD/.toolchain/bin:$PATH"`.
These tools retain bounded observations. None silently grants release acceptance,
PERF H/C hardware qualification, physical accessibility support or live Fal use.

## Functional suite runner

```sh
npm run qualify -- plan --select all
npm run qualify -- run --select base
npm run qualify -- run --select features
npm run qualify -- run --select base-features
npm run qualify -- run --select node:request,node:queue
node tooling/qualification/run.mjs verify artifacts/qualification/<run>/receipt.json
```

`base` includes the six repository Node suites in their prescribed order;
`features` includes provider, request, queue, adapters, candidates, export, composition, text-state,
portable and recovery; `helpers` includes browser/editor/text/qualification/campaigns Node
checks. `all` means these Node suite groups, not every browser/manual journey.
`base-features` executes the six base suites followed by these feature suites
with one shared type/vendor/import/raster-input/app/server dependency sequence. This is the
bounded base+feature selection, not a claim of full release coverage. Container
feature scope selects `all`, including helper/campaign integrity tests.
Each plan expands the current exact file selection before running. File counts
are not test-case counts and are not the WD fixed 100/10/5 focused selections.
An unassigned Node test directory fails planning instead of silently disappearing
from `all`; new suites require explicit group and network-guard classification.
Source, dependency and browser changes still require their affected gates.
The authoritative `node:campaigns` gate explicitly sets
`IE_CAMPAIGN_PRODUCT_INTEGRATION=1` after the fresh build dependency, so its real
backend reset/transfer/fixture cases run. Ambient opt-ins remain stripped; the
required flag is part of the plan and retained receipt. Skips remain incomplete.

Typecheck, vendor/import/raster-input checks and fresh app/server builds are dependencies.
The checked-in no-network/no-egress preload remains in every Node command.
Children receive an allowlisted environment without provider credentials,
proxy variables or ambient `NODE_OPTIONS`. Test workers retain the Node
`--import` behavior used by the existing standalone suites.

Five Node-hosted composition/history/portable/text-state test files launch real
Chromium; their exact paths appear in `browserPrerequisites`. Install the pinned
Playwright Chromium before these gates. The text-state gate builds its browser
fixture into the current receipt directory and seals all emitted files before
execution. Completion helper cases prepare fresh application/issuer identities,
the retained original monitor and current handler capture in the same receipt,
with all explicit input paths propagated and matched to full sealed preparer output
trees, including the independent capture and producer receipts. The runner rechecks those complete inventories after the child exits. These
prerequisites count inside their gate deadlines and cannot be replaced by stale output directories.

`npm run test:qualification` uses the same closed recursive discovery and
network guard for only the qualification tooling tests, including nested metric
cases. `node tooling/qualification/test.mjs --list` prints its exact selection.
This helper command does not build the product or execute runtime campaigns.

Every execution creates a new directory under ignored `artifacts/qualification`.
The runner never overwrites a receipt. It stops at the first failed or incomplete
gate. Actual discovered test/pass/fail/skip/cancel counts, exact argv, monotonic
duration, source byte manifests, environment, raw logs and SHA-256 are retained.
A skipped/empty test suite is incomplete; source changes during the run make it
inconclusive. No prior failure is erased by a later pass. A process-group deadline
terminates owned npm/test descendants. Synchronous bounded log writes apply
disk backpressure; a log failure aborts and awaits the same owned child cleanup. The active lock prevents two instances of
this runner from concurrently mutating shared build outputs; it cannot exclude
unrelated tools, so the source comparison and external coordination still matter.

`--without-dependencies` is an explicit diagnostic shortcut. Its receipt says
dependencies were omitted and does not prove build/source freshness. Use the
default for authoritative execution. `verify` checks the retained manifests,
logs, outcome counts and aggregate verdict; it does not rerun product tests.

## Performance inventory and bounded observations

```sh
node tooling/qualification/run.mjs campaign --campaign P --features core
node tooling/qualification/run.mjs campaign --campaign Q3 --features training
node tooling/qualification/run.mjs validate-schedule <schedule.json>
node tooling/qualification/dev.mjs --plan
node tooling/qualification/runtime.mjs --help
npm run perf:runtime -- plan --campaign P --jobs C1,H1
npm run perf:runtime -- plan --campaign I3
```

The schedule JSON contains `campaign` (`P` or `Q3`), `features` (`core`,
`adapters`, or `training`, which includes adapters), `revisions` (one candidate
SHA or distinct base then candidate SHAs), and `jobs` (`{revision,id}`). The
validator rejects missing, orphan and duplicate jobs. Exact inventories are
22/30/40 P jobs and 16/19/22 Q3 jobs. This is an inventory check, not executed
timing evidence. All prescribed cells, samples, resets, primes, continuous B0
cohorts and resource/paint oracles remain required by `docs/spec/performance.md`.

The existing `perf:runtime` command routes an explicit `--campaign` to the full
P/Q3 runner. It accepts `P`/`Q3` plus `--jobs`, or a comma-separated set of job
IDs from one campaign. The default remains a read-only plan; actual `run`
requires a fresh output directory and the sealed fixture, configuration, build
and host inputs described by `campaigns/run.mjs`. An exploratory local run or a
diagnostic host does not become H/C qualification through the command alias.

`dev.mjs` provides real isolated D03/D04 observations. Its default is a read-only
plan; `--run --install` snapshots the selected source to a new temporary tree,
installs with npm ci, runs types/build, edits each declared scope, primes and
measures incremental work, then restores original bytes and output identities.
Both successful and failed commands are retained. This bounded campaign does
not replace I1's five-cold/five-warm command groups or claim the C hardware.

Explicit `npm run perf:dev -- --campaign I0|I1|I2` dispatches to the full
[developer campaign runner](developer-campaigns/README.md). It retains the
declared serial CI graph, exact command cohorts, and ten scoped producer
updates separately from the older bounded observation mode. Consult that
runner's sealed-input and fresh-directory requirements before execution.

The runtime tool's own plan describes its public writer/real-codec raster cells,
independent cold processes and warm prime/sample phases. W1/W2-sized rasters do
not mean complete W1/W2 layer/history/resource qualification. Failed historical
25MP WebP memory observations remain open until corrected and requalified.

`statistics.mjs` evaluates declared timing cells without changing their sample
templates. It requires exact scored/prime ordinals and cohort identities, applies
correctness/cap/timeout failures before missing/infrastructure evidence, reports
nearest-rank all-attempt p95 separately from success-only diagnostics, and retains
right-censored upper bounds as explicitly unavailable. Matched timing/byte/memory
regression helpers preserve PERF thresholds. The evaluator does not validate a
host, wire oracle or full campaign on behalf of its caller.

`campaigns/metrics.mjs` evaluates the session, lifecycle and finalized-visit
protocols separately from fixed operation timings. See
[campaigns/metrics.md](campaigns/metrics.md) for its raw observation contracts.
It preserves actual idle and resource sampling time, enforces the prescribed
100/106-action sessions and 2/100-cycle cohorts, and leaves unsupported physical
presentation or process attribution inconclusive. WA's two resource cycles
never become an editor growth claim.

## Browser, native and container execution

After fresh app/server builds, run the focused public accessibility harness:

```sh
QUALIFICATION_BROWSER=chromium \
QUALIFICATION_A11Y_OUTPUT=artifacts/qualification-a11y-<new-run> \
npm exec -- playwright test --config tests/qualification/a11y.config.ts
```

Its retained scope names exactly the keyboard, reflow, reduced-motion and
forced-color checks. It cannot substitute for complete J1–J24,
manual contrast, physical zoom, native IME, Safari or actual VoiceOver/NVDA.
The exact native specimens remain in `manualProtocols` and the TEST §9 source.

The separate pinned axe-core 4.13.0 AX01 harness scans 19 explicit whole-document
states without panel exclusions or rule waivers:

```sh
QUALIFICATION_BROWSER=chromium \
QUALIFICATION_AXE_OUTPUT=artifacts/qualification-axe-<new-run> \
npm exec -- playwright test --config tests/qualification/axe.config.ts
```

Applicable WCAG A/AA violations fail. Every incomplete result is retained in an
adjudication queue; a green automated test does not resolve that manual queue.
The state coverage receipt lists exercised states and remaining failure/recovery,
training and populated jobs/results states; it is not blanket AX01 qualification.

See [container/README.md](container/README.md) for the opt-in CI/Docker path.
Container runtime external networking is disabled; no live provider work is
part of these commands. Container images and local host observations remain
distinct from the specified physical PERF C and H profiles.

Raw evidence including failures has a 90-day minimum retention requirement;
aggregate trends/baselines require 365 days, and release-defining source/fixture
receipts require the supported release lifetime plus 365 days. No cleanup is
performed automatically by this tooling.
