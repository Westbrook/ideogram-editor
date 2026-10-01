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
The supplemental `validation.yml` PR job provides cheap source/tooling feedback;
it does not substitute for this container or physical qualification workflow.
The Dockerfile keeps the locked dependency and browser installation layers ahead
of the broad source copy. Types/inventory then fail before historical packet
installation. Exact vendor/package/profile changes still invalidate those layers.

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
QUALIFICATION_CONTAINER="ideogram-qualification-$(date -u +%Y%m%dT%H%M%SZ)"
docker run --name "$QUALIFICATION_CONTAINER" --network none \
  --cap-drop ALL --security-opt no-new-privileges --shm-size=1g \
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
vendor/import/raster checks, and fresh app/server builds run once before the Node
groups. Base scope runs session, store, protocol, assets, raster, and history in
that order. Feature scope then adds provider, request, queue, adapters,
candidates, export, composition, text-state, portable, and recovery groups. The E3
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
`container`, supply the immutable image digest, and select browser/scope. It
checks out full history and prepares the exact input packet before Docker build:
16 selected historical commits, six retained review ZIPs, and the exact public
adapter fixture. Preparation verifies every identity. Selected Git tree metadata
includes historical filenames/object IDs needed by archive path selection;
unrelated historical blob contents and local Git configuration/remotes stay out.
The workflow downloads only the pinned public fixture URL, never a provider API.
Local callers can instead supply an already sealed fixture with `--adapter-fixture`.
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
