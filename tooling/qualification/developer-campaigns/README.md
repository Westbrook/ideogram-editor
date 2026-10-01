# Developer qualification campaigns

Use the repository toolchain: Node 26.10.0 and npm 12.1.0. These commands execute
real compiler, package-manager, producer and test processes in owned source
snapshots. They retain failures and never copy another checkout's dependencies.
An executed local command campaign is not a physical C/H qualification receipt.
The P/Q3 runtime coordinator verifies the additional host, fixture and build
provenance needed for qualification.

## Entry points

```sh
npm run perf:dev -- --campaign I0 --plan
npm run perf:dev -- --campaign I1 --plan
npm run perf:dev -- --campaign I2 --plan
```

Without `--campaign`, `perf:dev` keeps its original bounded D03/D04 behavior.
Plans are read-only. Execution requires explicit `--run --install`; output
directories are new and exclusive. SIGINT/SIGTERM cancel the owned process
tree, retain the failed attempt and release its timing lease after publication.
All runtime and standalone developer timing uses the same host lock. A nested
runtime child can borrow only its live ancestor's exact sealed lease, with one
exclusive borrower at a time. Its canonical host directory is independent of
per-run `TMPDIR`, `TMP` and `TEMP` settings.

## I0: complete normal and cold core pipelines

I0 requires the dedicated C and H hosts and the sealed distributed CI plan in
[../ci/README.md](../ci/README.md). The executable graph performs C preparation
and build, transfers the immutable C2 product artifact, prepares H's native
dependencies and browser, and executes the remaining core jobs on both hosts.
Use the workflow coordinator to schedule dependent stages. A stage invocation
has this form:

```sh
npm run perf:dev -- --campaign I0 --run --install \
  --ci-plan /sealed/ci-plan.json \
  --stage q3-candidate-i0-normal-prepareC \
  --received /received/stage-artifacts --workspace /owned/subjects \
  --output /new/stage-output
```

The stage identifies `base` or `candidate`, `normal` or `cold`, and `prepareC`,
`restC` or `H`. A comparison plan includes both revisions. An initial baseline
plan includes only the candidate's complete Q3 inventory, including both I0
pipelines. Create that sealed plan without a comparison base:

```sh
node tooling/qualification/ci/run.mjs plan --purpose initial-baseline \
  --candidate <40-character-candidate-SHA> --control <protected-control-SHA> \
  --features adapters --cache normal --inputs /sealed/ci-inputs.json \
  --output-root artifacts/initial-unique-run > /sealed/ci-plan.json
```

Initial plans forbid `--base` and approved-main descriptor options. All absolute
and pipeline bounds still apply; relative comparison is explicitly not
applicable. One stage is only part of I0. Join all retained raw node/stage
receipts on the same C host:

```sh
npm run perf:dev -- --campaign I0 --verify \
  --ci-plan /sealed/ci-plan.json --received /received/all-stage-artifacts \
  --output /new/pipeline-result.json
```

The CI verifier reproduces dependencies, exact child commands, source/build
identities and conservative pipeline elapsed boundaries. Child time sums do
not replace whole-pipeline elapsed. Queue/provisioning and release acceptance
remain separate evidence.

## I1: five cold and five warm command groups

```sh
npm run perf:dev -- --campaign I1 --run --install \
  --registry http://127.0.0.1:4801/ \
  --browser-download-host http://127.0.0.1:4802 \
  --output /new/i1-receipts
```

Each of the ten groups independently snapshots source, installs dependencies,
runs full types and cold builds, performs both prescribed incremental edits
and exact restoration, executes focused/full U and L suites, provisions or
verifies Chromium/Firefox/WebKit, then executes focused/full Chromium B suites
and audits outputs. Five-per-cache medians and maxima drive D01–D04/D06–D07;
D10 compares install and incremental-build ratios. D05 belongs to I3's HMR
campaign. D11 retains the sealed source-bound startup, each lazy feature,
text-engine and UI CSS/font byte roles, their five artifact metrics and budgets.
The ten builds must match. Missing role classification is inconclusive; H's
actual startup and font/module traces remain separately required.

Cold groups start with empty npm/browser/build caches. Warm groups still have
fresh source, dependencies and outputs; only this campaign's explicitly primed
npm/browser download caches are shared. Cache identity includes source, lock,
toolchain, commands, selection and observed environment. Browser verification
seals the complete installed distribution before native launch. A failed warm
cache retains its failed sample and clean-cache recovery, then stops the
cohort. It never silently substitutes a faster attempt.

Historical compatibility and binary fixtures come from the sealed selective
[container input packet](../container/README.md), prepared once unless supplied
with `--input-packet`. Each group installs its own copy. Current completion
issuers and callback capture fixtures are prepared from that group's restored
app build without changing tracked source. Adapter flow/profile tests receive
the verified exact public fixture. Setup and receipt costs remain in the group
and campaign elapsed budgets.

`focused.json` freezes 100 U, 10 L and 5 B existing cases by file, literal title,
method and occurrence. E1–E4 and the focused accessibility case retain their
contract aliases. The full Node selector walks every declared test directory;
the full browser selector uses the shared exact browser plan. Actual Node and
Playwright reporter events supply case ledgers. Missing files/cases, skips,
retries, duplicate identities or mismatched focused counts block completion.
WD 2000/100/30 full counts are sizing envelopes: additional implemented cases
are executed and reported as a PERF-A08 scope amendment, never removed to fit.
Five existing Node-hosted native browser files are explicitly classified B and
execute after browser provisioning, with their real fixture build and preserved
network guard. Their discovered Node test IDs must match completed B cases.

## D05: actual development hot updates on H

I3's `developer.hot-update` cells route to
[`../campaigns/browser-hmr.mjs`](../campaigns/browser-hmr.mjs). They require the
completed C2/H0 prepared product, its sealed browser distribution, the original
subject checkout identity, a W1 document fixture and
`configuration.developerStateDirectory`. The runtime supplies `repo`,
`subjectRepo` and `browserCache`; `configuration.browser` selects the pinned
engine and native headed launch. The fixed cell declares
`fixedEdit: "shell-component"` and `devServerWarm: true`.

The owned process runs real Vite middleware and the paired local API on one
same-origin listener. The fixed shell view edit changes the displayed wordmark
through the app's actual hot-update boundary while retaining the same shell,
canvas, document and public control state. Source saves and restoration are
atomic and sealed. After a killed worker, the parent may restore only its exact
owned backup after confirming process-tree exit; interruptions remain failures.

DOM visibility and stock Chromium paint/frame traces are diagnostic evidence.
D05 timing requires the validated display-presentation and save-clock join; an
unavailable physical feedback/content binding remains inconclusive. Ordinary
`npm run dev` retains its existing behavior; this explicit isolated development
entry belongs to the campaign.

## I2: immutable archive producer and consumer update

Prepare a sealed recipe from the current frozen vendor source and an installed
pinned Chromium distribution. Preparation reads inputs and runs the binary's
version command; it does not install or build:

```sh
npm run perf:dev -- --campaign I2 --prepare-recipe \
  --browser-cache /owned/installed-browsers --output /new/archive-recipe.json
npm run perf:dev -- --campaign I2 --run --install \
  --recipe /new/archive-recipe.json --registry http://127.0.0.1:4801/ \
  --output /new/i2-receipts
```

Every cold/warm run owns separate producer and consumer sources/dependencies.
It installs frozen source, runs the prescribed producer build/metadata/pack,
checks all four archives, updates the consumer lock and verifies a clean
consumer install, public imports, types, build and both actual registration
browser cases. The producer timer is a child of complete update time. Source
install and whole-run limits are retained separately. Input archives remain
unchanged. Recipe preparation can explicitly select `--frozen` and
`--browser-executable`; ambiguous or changed inputs fail closed.

## Immutable N download fixtures

Capture requires access to the lockfile's exact public npm tarballs and the
pinned Playwright distribution endpoints. No provider credentials are read.
Capture once into fresh directories, retain their seals, then serve each
fixture separately on literal loopback:

```sh
node tooling/qualification/developer-campaigns/registry.mjs capture \
  --lockfile package-lock.json --output /new/npm-fixture
node tooling/qualification/developer-campaigns/registry.mjs capture-browsers \
  --source "$PWD" --output /new/browser-fixture
node tooling/qualification/developer-campaigns/registry.mjs serve \
  --fixture /new/npm-fixture --receipt /new/npm-network.json --port 4801
node tooling/qualification/developer-campaigns/registry.mjs serve \
  --fixture /new/browser-fixture --receipt /new/browser-network.json --port 4802
```

The server verifies exact bytes before delivery and applies shared aggregate
100 Mbps downstream/20 Mbps upstream scheduling plus 40 ms request delay.
It records actual transfers, errors and elapsed durations on shutdown. This is
an application-level controlled download fixture, not proof of physical packet
loss or a host's network profile. Capture and service receipts are inputs to
the qualified runner's N evidence, not a self-issued qualification.

Receipts, command logs, snapshots, fixture captures and failures are retained.
No cleanup, baseline adoption or archive-receipt reuse occurs automatically.
