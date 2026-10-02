# Container functional qualification

This opt-in runner executes the existing functional gates from an isolated source
copy. It installs checksum-verified Node 26.10.0/npm 12.1.0, checks frozen vendor
archives before and after `npm ci`, and installs the browser revisions selected
by the locked Playwright 1.63.0 dependency. Dependency installation needs public
network access. The resulting container runs with `--network none`; local IPv4
loopback is available and the repository's Node no-egress preloads stay enabled.
No provider credentials or paid API calls are used.

The Dockerfile-specific ignore file admits only the source and frozen inputs
needed by these gates. It excludes the host's installs, outputs, Git database,
private state, and credential files. Every execution records a manifest of the
actual copied source bytes, so an uncommitted local build is not represented as a
clean commit. The optional `SOURCE_REVISION` is contextual metadata, not a claim
that the file manifest equals that revision.

## Feedback and reuse

For ordinary development, use `npm run validate` and `docs/testing/VALIDATION.md`.
The supplemental `validation.yml` PR job supplies source/tooling feedback on an
ephemeral runner; it does not supply container or physical qualification. Its
selected tests retain their actual compiled prerequisites. The Dockerfile keeps
locked dependency/browser inputs ahead of mutable source. Cheap types/inventory
checks precede historical packet installation; vendor/package/profile changes
invalidate the corresponding layers. These source changes are not evidence that
the reconciled image or hosted workflow has run successfully.

The managed source inventory retains 23 Node groups and 56 browser inventory files:
54 direct specs and two negative harness specs owned by Node parents. The
all-engine serial browser plan has 143 steps (138 Playwright invocations and five
fixture preparations), including both adapter specs and all V45/import/recovery
and UI coverage. Generate the exact plan from its metadata; old donor counts and
results are historical. Existing no-egress/no-network preloads, evidence storage
accounting and required skip/discovery failure handling remain in force.

Legacy-root migrations into the current schema require an authentic executable packet
whose capture, independent restore and product pin have succeeded. Supply its
absolute container-visible path through `IE_SCHEMA18_EXECUTABLE_PACKET` and mount
the full sealed packet closure read-only. Each test verifies and privately copies
it before the old root is opened. A host path or planned filename alone does not
provide that closure. Current schema19 fixtures preserve exact schema18 retained
and intermediate authority checks. Do not run packet-dependent container gates
until the correct platform packet is prepared. Ordinary shared compilation reuse
does not replace this requirement; formal container preparation remains fresh.

The hosted `qualification.yml` container dispatch currently stops immediately
following checkout with `prerequisite-unavailable`, before toolchain provisioning,
fixture downloads or image building. Its existing evidence upload retains
`artifacts/qualification-ci/prerequisite-status.txt`. No hosted packet transport
has been defined. Enabling that job requires a separately reviewed provisioning
contract for the genuine platform-matching packet and its complete sealed closure;
a caller-selected path or archive does not establish that authority. The local
invocation below remains available when its actual prerequisites are satisfied.

## Local execution

Run these commands from the repository root using Docker with at least enough
disk for a clean install, all three browsers, build outputs and retained evidence.
Select an Ubuntu 24.04 digest once, record it, and reuse that exact value for
reproduction. Resolving the release tag below is an explicit initial selection;
it is not an immutable identity until `BASE_IMAGE` has been captured.

```sh
docker pull ubuntu:24.04
BASE_IMAGE="ubuntu:24.04@$(docker image inspect ubuntu:24.04 --format '{{index .RepoDigests 0}}' | cut -d@ -f2)"
node tooling/qualification/container/inputs.mjs prepare --adapter-fixture /absolute/sealed/provider-example.safetensors
mkdir -p artifacts/qualification-ci
printf '%s\n' "$BASE_IMAGE" > artifacts/qualification-ci/base-image.txt
docker build --progress=plain \
  --build-arg "BASE_IMAGE=$BASE_IMAGE" \
  --build-arg "SOURCE_REVISION=$(git rev-parse HEAD)-working-tree" \
  --iidfile artifacts/qualification-ci/image-id.txt \
  --file tooling/qualification/container/Dockerfile .
# Create /absolute/evidence-allocation.json from the schema below with your assigned capacity.
# /absolute/verified-schema18-closure must contain the successfully restored,
# platform-matching packet.json and every sealed member it references.
# Each embedded reference is a canonical absolute path and must also be visible
# inside the container. Mounting this directory does not rewrite descriptor paths.
QUALIFICATION_CONTAINER="ideogram-qualification-$(date -u +%Y%m%dT%H%M%SZ)"
docker run --name "$QUALIFICATION_CONTAINER" --network none \
  --cap-drop ALL --security-opt no-new-privileges --shm-size=1g \
  --mount type=bind,src=/absolute/evidence-allocation.json,dst=/evidence-allocation.json,readonly \
  --env IE_EVIDENCE_ALLOCATION=/evidence-allocation.json \
  --mount type=bind,src=/absolute/verified-schema18-closure,dst=/schema18-packet,readonly \
  --env IE_SCHEMA18_EXECUTABLE_PACKET=/schema18-packet/packet.json \
  "$(cat artifacts/qualification-ci/image-id.txt)" chromium features
```

The first argument selects `chromium`, `firefox`, `webkit`, or `all`; the second
selects `base` or `features`. Defaults are `chromium features`. Feature scope adds every configured Node group, including tool/campaign integrity tests, and the P2, adapter, accessibility and AX01 browser checks described below. When Firefox or WebKit alone is selected with features,
the explicit plan also requires Chromium for the Chromium-only adapter fixture
and public consumer. Its `extraBrowsers` and `extraBrowserReasons` disclose this
addition; the other browser checks still use only the selected engines. Base
scope also requires Chromium for the shell, raster, projection and history fixtures. Each additional engine is disclosed by the plan.

Use a fresh container for each run. Keep the image ID as well as the base
digest: the Ubuntu apt repositories used to install build/browser prerequisites
are mutable, so rebuilding later from the same base digest is not guaranteed to
produce an identical OS package set. Reusing the saved resulting image gives the
same dependency environment; the image inspect record identifies it. This is
reproducible functional execution, not a hermetic OS image build.

Copy evidence even when `docker run` exits unsuccessfully. These are separate
commands so a stop-on-failure shell does not skip collection:

```sh
mkdir -p "artifacts/qualification-ci/$QUALIFICATION_CONTAINER"
docker inspect "$QUALIFICATION_CONTAINER" > "artifacts/qualification-ci/$QUALIFICATION_CONTAINER/container.json"
docker image inspect "$(cat artifacts/qualification-ci/image-id.txt)" > "artifacts/qualification-ci/$QUALIFICATION_CONTAINER/image.json"
docker logs "$QUALIFICATION_CONTAINER" > "artifacts/qualification-ci/$QUALIFICATION_CONTAINER/run.log" 2>&1
docker cp "$QUALIFICATION_CONTAINER:/workspace/artifacts/." "artifacts/qualification-ci/$QUALIFICATION_CONTAINER/artifacts"
```

Containers are deliberately not removed automatically. Failed tests can retain
isolated private fixtures in `/tmp` inside the stopped container; their paths
appear in the corresponding gate logs. Inspect or copy a needed fixture before
explicitly disposing of that container. Raw private fixture roots are not part
of the normal CI artifact upload. All normal copied evidence is beneath the
repository's ignored `artifacts/` directory.

## Gate order and evidence

The runner first validates its pinned toolchain. It reuses the shared
`functionalGates`, `selectGates`, and `executeGate` implementation in one
invocation, with one source manifest and one dependency proof. Typecheck,
vendor/text/import/raster checks, and fresh app/server builds run once before the Node
groups. Base scope runs session, store, protocol, assets, raster, and history in
that order. Feature scope then adds provider, request, queue, adapters,
candidates, export, composition, text-state, ui-state, portable, recovery and
editor-capability-preflight groups, plus registered helper groups. The E3
request-edits directory is exercised as a browser target below. These are explicit discovered Node-file
selections, not a claim to exercise every product journey. The runner stops
at the first failing gate, retaining the failed gate's log and receipt; it never
substitutes a later pass for a failed attempt. A rerun gets a new output directory.
Every child gate has a deadline: 30 seconds for npm identity, a bounded deadline
from the shared gate manifest for each Node/build gate, five minutes for each fixture build, and 30 minutes for each browser invocation. A deadline fails
the gate, sends TERM to its owned process group and Linux process descendants,
then sends KILL after a five-second grace period. PID starttimes protect against
signaling a reused descendant PID. A child exiting during shutdown cannot turn
the timed-out gate into a pass. A host crash or external container kill can still
leave an explicitly incomplete receipt.
The container runner routes SIGINT and SIGTERM through an abort controller and
awaits the same complete process-tree cleanup. It seals the interrupted gate log,
checks the final source inventory, saves an `interrupted` receipt with the signal
reason, and exits 130 or 143. The shared child helper accepts an optional
`abortSignal`; it installs no global process handlers itself. A pre-aborted
signal prevents a new command from starting.

After the Node gates, the complete browser plan selects exact files and unique
output roots. It explicitly builds the public consumer, recovery projection,
raster conversion and native text fixtures. App/server prerequisites come from
the same invocation. Chromium runs the consumer, shell, projection, image history
and raster suites once. Each selected engine runs native text rendering, every
editor regression spec in its own artifact directory, the integrated E1 assembly,
all Spectrum probes and density/appearance persistence. Feature scope adds
request review and both alignment probes, queue, E2, E3, E4, all automated AX
states and the Chromium adapter library assembly. E1–E4 are included once per
selected engine. The two deliberately failing recovery runner specimens execute
inside their Node parents, which check the negative outcomes; they are never
ordinary passing browser cases. The explicitly WebKit-specific OPFS environment
specimen is selected only on WebKit, before execution; unexpected runtime skips
still block the gate. Training E5 remains conditional and unimplemented.

The plan test compares the selection with every current `.spec.ts` file, so a new
suite cannot silently disappear. `all features` covers all three engines; a
single-engine invocation reports its narrower cohort explicitly. Native Safari
and actual assistive technology are separate from Playwright WebKit.

Each browser gate uses its own output root and isolated fixture state, one worker
and zero retries. Its actual Playwright JSON summary must report at least one
expected result, zero skips/flakes/unexpected outcomes and no global errors.
Every selected file must appear in the Playwright case tree, whose count must
match the summary. The custom reporter records actual `onBegin` discovery and
`onTestEnd` identities; missing, duplicate, orphan or uncompleted cases fail.
Empty discovery, skips and missing summaries are incomplete evidence, never a
passing gate. Each summary is sealed by byte count and SHA-256 in the receipt.
Source and browser executable hashes, the Playwright revision manifest,
per-command logs and results are retained. Each closed command log is made
read-only and bound to its receipt with its actual byte count and SHA-256. The
source inventory is repeated after execution, including after failures; drift
fails the receipt and retains both manifests. Existing browser fixtures retain
their own observations and cleanup dispositions. Actual case counts are retained; the WD sizing envelope is not a coverage quota.
Exceeding its budget needs explicit disposition rather than deleting cases.

The container workflow remains an explicit `workflow_dispatch` mode. Choose
`container`, supply the immutable image digest, and select browser/scope; it
currently stops at the provisioning refusal described above. Its retained
preparation sequence becomes usable only after separately reviewed hosted
schema18 provisioning is implemented. That sequence prepares an exact packet:
16 selected historical commits, six retained review ZIPs, and the exact public
adapter fixture. Preparation verifies every identity. Selected Git tree metadata
includes historical filenames/object IDs needed by archive path selection;
unrelated historical blob contents and local Git configuration/remotes stay out.
The retained download step selects only the pinned public fixture URL.
Local callers can supply an already sealed fixture with `--adapter-fixture`.
Input weights and the input packet are excluded from uploaded run artifacts.

The same workflow has a separate physical qualification path for trusted manual
paired runs from the protected default branch; pull requests receive a hosted notice only. See [CI orchestration](../ci/README.md) for the
one-C/one-H graph, sealed host configuration, fresh base/candidate source,
mandatory adapter branches and affected Q3 selection. Container functionality
is never substituted for physical timing. Workflow files are implementation,
not evidence of a successful run. No weekly schedule, deployment or paid call
is enabled.

Raw receipts are retained for 90 days. Repository retention policy must allow
that duration; 365-day aggregate and release-lifetime evidence retention remains
an external archival obligation. Failed private `/tmp` fixture roots are not
uploaded automatically. Preserve a needed failed fixture before disposing of
its container or physical runner workspace.

No container or hosted-runner result establishes the plan's bare-metal PERF C/H
profiles, physical display timing, assistive-technology checks, resource campaign,
whole-product release qualification, or any paid provider behavior. These retain
their separate plan requirements. Adding this runner is not evidence that it has
executed successfully; retain actual run receipts before making that claim.

The runner verifies the input packet and its installed Git/fixture closure both before and after execution. Completion tests receive a newly generated per-run issuer bound to the actual source/build identities; no historical acceptance is adopted. Browser evidence collection retains and seals both the JSON summary and stable case NDJSON even after a failed browser child.

## Allocated evidence storage

Every executed campaign has a continuously sampled operational evidence-volume
counter. Supply `IE_EVIDENCE_ALLOCATION` with an explicit assigned capacity; this is an
accounting ceiling, not a filesystem quota or reservation, and none is inferred
from machine free space. For this container, the manifest's
root is `/workspace/artifacts` (created private to uid10001). The mounted
manifest may be world-readable because it contains only an opaque allocation ID,
capacity, owner and dates; it must not contain credentials or user content.

```json
{"kind":"evidence-volume-allocation-1","allocationId":"container-evidence","purpose":"qualification-evidence-only","capacityBytes":107374182400,"root":"/workspace/artifacts","issuedAt":"2026-09-30T00:00:00.000Z","owner":"Build"}
```

The number above is an example, not an automatically assigned 100GiB allowance.
CI requires the operator's `QUALIFICATION_EVIDENCE_CAPACITY_BYTES` repository
variable. Physical C/H stage runners require a preprovisioned private root and
absolute manifest path in `QUALIFICATION_EVIDENCE_ALLOCATION`; stage outputs and
owned subject workspaces then live under that root. Each host measures its own
allocation. User editor assets and unrelated directories are never scanned.

The counter logs 80% target and 90% ceiling alarms. Missing/incomplete coverage
is INCONCLUSIVE. Periodic observation does not claim peaks between samples;
final audit/index bytes are disclosed as outside the last observation window.
Keep the `evidence-storage` bundle with each raw receipt when exporting/archiving.
The bundle contains the exact original allocation bytes, hash-chained samples,
a replayable audit, retention index and static fixture-separated trend charts.
Use `tooling/qualification/evidence-lifecycle.mjs` for read-only audits,
retention indexing, verification of separately copied exports, and eligibility
reports. Eligibility never deletes evidence. Raw failure evidence keeps90days,
aggregates/baselines365days, release-defining/source-fixture claims supported
lifetime plus365days. Stronger claims remain in force even when an older raw
index has expired. Workflow artifact90days alone does not satisfy the aggregate
or release lifetime policy; retain/export those indexed records accordingly.
