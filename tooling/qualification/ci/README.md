# Local qualification planner

The planner builds and verifies a schedule; `execute.mjs` runs its stages and joins
retained evidence on physical PERF C and H runners. This code neither enables
provider calls nor claims release qualification.
GitHub Actions workflows have been removed. Invoke this CLI explicitly on eligible
hosts; hosted Linux/macOS VMs cannot substitute for those profiles.

`plan.mjs` exports `selectAffectedQ3`, `createCiPlan`, `validateCiPlan`,
`workflowExport` and `executionState`. Paths unknown to the risk policy select
every active Q3 job. Source/test/spec/infrastructure additions are not exempt.
The implemented profiles are `core` and `adapters`; training is rejected.

The graph preserves these boundaries:

- Base C runs C0,C1,C2,C3,C4,C5,C6,C7,C9,C10,C8. Base H starts only after
  matching C2 artifact verification, then runs H0,H1,H2,H3,H4,H5,H7,H8,H9,H10,H6.
- Candidate core starts after both base sides finish. Both core revisions finish
  before base AC0–AC3 and AH0–AH3; candidate A waits for both base A sides.
- Affected Q3 completes the entire base revision before candidate. I0 expands
  one normal and one cold two-host core graph, without A branches or recursive
  I1/I2 groups. Other selected Q3 jobs retain the specified C/H serial orders.
- Each invocation has its own output path. C/H timing stays exclusive per
  physical host. Failed/missing evidence blocks dependent work.

Each source descriptor has `{commit, tree, digest}`. The digest uses the same
SHA-256 source-byte manifest boundary as `qualification/core.mjs`, computed from
immutable Git blobs. The CLI reads `git diff --no-renames` between full commit
SHAs, retaining both old and new paths. Working-tree changes cannot be relabelled
as the selected commits.

Create an inputs JSON with `C` and `H` entries. Each entry contains:

```json
{
  "physicalHostId": "sha256:<observed hostname hash>",
  "hostAttestation": {"path": "/sealed/host.json", "sha256": "<64 hex characters>"},
  "fixtureManifest": {"path": "/sealed/fixtures.json", "sha256": "<64 hex characters>"},
  "configuration": {"path": "/sealed/configuration.json", "sha256": "<64 hex characters>"}
}
```

Paths must be canonical regular files. The host attestations name independently
sealed physical-host evidence; the runtime also probes the actual machine.
Configuration must supply the required real runtime/developer adapters. The
planner cannot supply an unfinished developer bridge or missing fixture.

```sh
node tooling/qualification/ci/run.mjs plan \
  --base <40-character-base-SHA> --candidate <40-character-candidate-SHA> \
  --features adapters --cache normal --inputs /sealed/ci-inputs.json \
  --output-root artifacts/ci-unique-run > /retained/ci-plan.json
node tooling/qualification/ci/run.mjs export --plan /retained/ci-plan.json
node tooling/qualification/ci/execute.mjs verify --plan /retained/ci-plan.json \
  --received /retained/downloaded-stage-artifacts --output /retained/result.json
```

Export contains a `stages` object, `matrix.include`, dependency `layers`, and P-core, adapter-pair and I0
`boundaries`. Each stage has source identity, physical runner labels, side,
dependencies, node IDs and argument arrays. Execute argv directly; do not join
untrusted values into shell command text. Checkout/build/artifact transfer and
native dependency installation belong to their declared developer handlers and
explicit host setup. Never copy C's `node_modules` to H.

The stage controller resolves the control harness from an explicitly reviewed immutable control revision
and passes the exact subject worktree with `--repo`. Both hosts' sealed input
files must be provisioned at the same absolute paths on the verification host.
Imported plans are rechecked against the immutable commit trees, source bytes
and actual Git diff before execution and final verification; a self-consistent
plan digest cannot conceal changed paths.

The executable join reads the locally retained `stage-*` directories. It
rereads actual `perf-runtime-campaign-1` receipts, reproduces their verdicts and
evidence hashes, compares exact job/cell selection, source/control identities,
runtime argv, sealed input hashes and physical-host checks. It also verifies
outer stage status, exact node membership/order, controller completion and log
seals. Runtime receipts must include the exact consumed input identities.
Missing identities block verification; arbitrary outer PASS fields do not pass.
The lower-level `run.mjs verify --receipts` route accepts direct canonical node
invocations only; use the stage join for stage-derived configurations.

`executionState` is a pure sequencing ledger over those verified observations;
it is not an independent byte verifier. Its result stays `qualification:false`.
`COMMANDS_COMPLETE` means every declared invocation has valid successful
evidence. I0 still needs separately sealed whole-pipeline elapsed, queue and
provisioning/configuration receipts; sums of command durations do not establish
D08. Manual accessibility/native input and full release acceptance remain
separate. No weekly schedule is activated by this helper.

## Explicit stage execution

No workflow dispatch, runner-label provisioning or automatic artifact transfer is
configured. A reviewed operator must provision the sealed inputs on eligible
physical C/H hosts, reserve the pair, and execute the planner's dependency graph.
Use the CLI examples above. Keep both hosts exclusive while their campaign runs,
transfer only sealed stage artifacts, and stop dependent stages on failure.
The existing graph export remains a planning format for compatibility; exporting
it does not schedule or execute anything.

`execute.mjs` creates one exact Git worktree per revision on each physical host,
without copied installs. The canonical plan binds control and candidate independently. C/H developer state gets a separate namespace for each
revision and P/I0 cache cohort. It derives `developerStateDirectory`, the
matching predecessor's `ciHandoff`, and adapter audit receipt bindings from the sealed base configuration, retains
those effective configuration bytes, and passes them through the existing
runtime interface. The actual runtime records the consumed hashes. Subsequent
runtime cells resolve the independently verified prepared product workspace.

C2 transfers only its exact `dist` manifest, source-bound build provenance, C2
stage receipt and the corresponding public build-command logs. H verifies the
packet and source before installing native dependencies and starting its local
backend readiness check; Linux `node_modules` never crosses hosts. Each browser
cell owns its actual server/context lifecycle. The CI verifier rereads each raw
campaign receipt, reproduces its verdict, checks source/control identities,
allowed argv/config derivation, input hashes and predecessor order. Custom outer
PASS fields or a process exit zero cannot substitute.

Ordinary P records the complete core pair (100 minutes normal / 120 minutes cold ceiling) and adapter pair (15 minutes ceiling). I0 records two separate same-C-host monotonic intervals. Each begins immediately
before C0 and ends at the first C callback that has received and verified both
C/H terminal receipts. The interval includes callback/receipt overhead, so it is
a conservative whole-pipeline bound; no C and H clocks are subtracted and no
child command times are summed. A reboot/missing marker is inconclusive. Queue,
initial provisioning and user-visible total feedback are still disclosed
separately; an automated command result does not assert those observations,
manual/native accessibility, live-provider readiness or release acceptance.
Target misses also retain their separate owner/disposition obligation.

Retain first failures, successful evidence, worktrees and failed roots on owned
hosts under the evidence policy. Private test roots and installed dependencies
are not automatically uploaded. Restrict physical-host access to reviewed
operators and public controlled fixtures, with no provider credentials or
unrelated private data. No host access policy is configured by this CLI.

The controller forwards SIGINT/SIGTERM to owned process trees and waits for
bounded TERM/KILL cleanup. The final verifier includes outer stage membership,
controller exit/signal/timeout/interruption and sealed controller logs; a child
PASS cannot hide a failed controller. C2 transfer receipt, provenance, artifact
and command-log identities must match the already verified C2 runtime observation.

Fresh base/candidate regression checks recompute matched cohort statistics from
raw child attempts. Required timing/byte/CLS/drop triggers block automatic PASS
until a supported review/disposition exists. This comparison does not supply the
separate latest-approved-main baseline. Final output preserves that missing
baseline, target-miss reviews and manual/external acceptance explicitly.

## Initial baseline and reviewed candidates

Select `--purpose initial-baseline` without a base SHA to plan the candidate's
entire implemented Q3 inventory. I0 expands its normal/cold two-host core graphs.
This path has no standalone paired P graph or historical relative comparison.
Every absolute child/controller and pipeline gate must still pass. Comparison
purpose retains distinct fresh base and candidate revisions, P+A and affected Q3.

Select immutable reviewed control and candidate revisions explicitly. The plan
seals their identities independently and verifies selected Git bytes. Planning
never grants physical-host access or establishes a successful execution.

## Approved-main evidence

A comparison also requires the latest approved-main cohort. The CLI requires `--approved-main`,
`--approved-main-sha256`, and `--approved-main-revision` together. These become
`spec.approvedMain={packet:{path,sha256},source:{commit,tree,digest}}`. The external
maintainer selection establishes approval/latestness; packet flags or a prior
PASS do not. No descriptor has been configured by this implementation. Missing
history keeps comparison INCONCLUSIVE, and an altered selected packet fails.
Initial baseline forbids this descriptor.

After a run has complete absolute evidence, prepare a relocatable review packet:

```sh
node tooling/qualification/ci/execute.mjs pack-baseline \
  --plan /retained/plan.json --received /retained/stages \
  --disposition /retained/disposition.json --output /fresh/baseline-packet
```

This command packages evidence and verifies its fresh copy; it does not approve
or select it. `packet.json` contains the canonical historical plan, a complete
file manifest, `received` stage directory, original `disposition`, and sealed
`inputs` mappings from historical absolute paths to packet-relative files. All
paths consumed by the loader remain inside the packet. Source commits, every
raw child receipt, controller/log closure, original configuration bytes and
same-C-host pipeline acknowledgements are reverified. Packet/disposition PASS
fields are ignored. The original disposition now retains the final C clock and
host identity used to reproduce the pipeline bounds.

Both fresh-base and approved-main comparisons gate the automated result. Exact
job/cell/cache/sample/method/environment cohorts must match; an initial Q3 packet
cannot substitute for a missing standalone P cohort. Missing or changed cohort
contracts stay INCONCLUSIVE. Required regression triggers stay BLOCKED until an
explicit supported disposition is supplied; reruns never erase first failures.
Manual/native checks, target-miss review, queue/provisioning totals and release
acceptance remain separate from automated qualification.


I5a and I5b execute together in one Q3 runtime node (`node.jobs` is the
authoritative job array; `node.job` remains the display label I5a). Their actual
cells and process boundaries stay separate; the runtime enforces the specified
combined 310/330-minute envelope without inventing individual limits. D08
relative comparisons use each revision's actual C-clock interval, with normal
and cold samples kept separate; pair ceilings remain independent absolute gates.


AC3/AH3 receive `auditReceipts` only from the already verified same-stage AC1/AC2
or AH1/AH2 nodes. Each binding includes the node/job identity and exact retained
receipt SHA-256. The final join rechecks those bytes after relocation; base
configuration cannot inject a different audit cohort. Audit handlers must verify
those actual predecessor receipts, not treat fresh writer diagnostics as proof.
