# Test and validation efficiency plan

Original audit and implementation plan, prepared 2026-09-30. The proposal below is preserved as the planning baseline; implementation, validation receipts and current adoption status are recorded in [the active runbook](testing/VALIDATION.md). The audit itself did not execute tests or claim product qualification.

## Recommendation

Use one manifest-driven validation scheduler with separate development, integrated correctness, and qualification profiles. Run cheap diagnostics first, build each required output once, group compatible tests into bounded execution sessions, and resume only invalidated work after a failure. Reuse verified tooling and immutable inputs; keep mutable test state isolated. Optimize measured end-to-end feedback time rather than test-count reduction alone.

The first work should fix selection and prerequisite drift. Faster orchestration is useful only when it runs the intended tests and reports incomplete evidence honestly. Existing qualification code supplies much of the required discovery, identity, reporting, locking, and failure handling; extend it rather than introduce another competing runner.

## Review scope and evidence

Reviewed the current working tree on `main`, based at `ba59c8b279aa28876b79724fedc4838fe59d2650`, including uncommitted implementation. Another workstream is changing this tree; findings apply to the captured source, not an immutable release. Recheck touched files before implementation.

The [inventory](testing/validation-inventory-2026-09-30.json) records 39 package scripts, 308 Node test files in 21 directories, 28 active Playwright configurations, and hashes of the inspected validation source set. These are entry points/file counts, not executed or passing cases. Historical `evidence/` copies are receipts, not additional active suites. The inventory is a starting audit snapshot; the proposed manifest must also explicitly own nonstandard `.mjs`, Python, native bridge, volume, and manual checks.

Four parallel source audits covered Node/builds, browser fixtures, qualification/CI, and peripheral verification/review lifecycles. No product test suite, installation, browser campaign, performance experiment, environment reset, or live provider call was run for this review. Plan expansion and source inspection establish structural costs, not measured speedups. Historical durations below are labeled as such.

The existing report handoff and unresolved feedback were read. A-R01 remains open; efficiency work cannot turn missing native/resource/platform evidence into a pass. Existing author, independent reviewer, human review, and release qualification states remain distinct.

### Validation surfaces to register

| Surface | Current entry points | Intended disposition |
| --- | --- | --- |
| Types, source hygiene, dependency rules | `typecheck*`, `verify:imports`, `verify:vendor`, raster/text/native-input verification; `docs/spec/tools/` | Cheap changed-scope checks first; exact prerequisite checks before installation or dependent execution. |
| Node correctness | `test:node`, standalone `test:*`, direct `.test.mjs` commands | One inventory covering all 21 directories, classified by actual requirements rather than directory name. |
| Runner/config correctness | `tooling/test-node.test.mjs`, Python tooling tests, `tests/qualification`, `tests/campaigns` | Build-free selection/config checks early; real integration harness checks retain their dependencies. |
| Browser correctness | 28 configs across consumer, shell/theme, recovery, raster/history/text, request/queue/candidate/adapter/editor | One selection source; batch by compatible build/server/engine/fixture; preserve named browser coverage. |
| Consumer and producer isolation | `test:consumer`, `produce-en-reve`, cold install scripts | Routine public-consumer checks use the current verified environment; clean-install/archive qualification remains a separate explicit profile. |
| Migration, recovery, disk faults | Legacy readers, SQLite/reopen/SIGKILL, volume scripts, portable rollback | Cache immutable fixture preparation; keep actual storage/process/fault boundaries fresh. |
| Raster/text native inputs and oracles | Verify/seal/measure scripts and C/Python bridges | Separate fast identity checks, producer mutation, functional oracle checks, and resource measurements. Never regenerate expected evidence just to obtain green results. |
| Performance/qualification | `qualify`, `perf:runtime`, `perf:dev`, P/Q3 campaigns, Docker, physical C/H CI | Explicit campaign scope and sample/cache/host rules; do not invoke as the default edit loop. |
| Evidence, review, archive | Seal/source-identity checks, reviewer receipts, review workspace audit, archive restore, Progress Report | Reuse exact valid evidence and environments; check artifact identity at real boundaries; retain first failures and explicit unresolved claims. |
| Manual and live checks | Native IME/AT/picker, power-loss/platform evidence, approved provider observations | Schedule when automated prerequisites are ready; retain authorization and physical-environment requirements. |

## Findings and planned treatment

Priorities: P0 corrects invalid or incomplete selection; P1 removes repeated setup and delays; P2 tunes measured hotspots. Source references are entry locations, not guarantees that every historical wrapper is still routinely used.

| Priority | Finding and evidence | Planned change and proof |
| --- | --- | --- |
| P0 | `tests/recovery/playwright.config.ts:4` selects `*.spec.ts`, including `owner-runner.spec.ts` and `persistent-runner.spec.ts`, whose deliberate failing scenarios belong to dedicated harness runners. The container plan already excludes them (`tooling/qualification/container/browser-plan.mjs:11`). | Give product and harness self-tests explicit membership. Compare expected/discovered/executed IDs; normal recovery must exclude synthetic failures, while harness tests must still exercise and verify those failures. |
| P0 | The container browser inventory omits `tests/recovery/metadata.spec.ts`, `tests/editor/display-image.spec.ts`, and `tests/editor/export-destination-commit.spec.ts`. `tests/qualification/container-plan.test.mjs:51` already checks inventory equality, but runs late in the functional ladder. | Repair the inventory and dependencies, including display-image's separate Vite fixture/config. Move equality/prerequisite tests to preflight. Every new test must either be selected or have an explicit non-default owner. |
| P0 | `tooling/test-consumer.mjs:37` copies only `vendor/en-reve`, while `tooling/verify-vendor.py:58` now requires `src/text/profile.json` and `vendor/text`; the root package also references the local CanvasKit archive. `tooling/raster/fresh-install.mjs:10` has a related stale copy list. | Declare and validate the complete install/verification closure before creating an expensive environment. Either use an intentional independently sealed consumer package or copy the full root package closure; never weaken vendor verification to fit the old list. Confirm a real fresh consumer once after the repair. |
| P0 | I1's `runNodeSelection` environment (`tooling/qualification/developer-campaigns/suites.mjs:54`) omits `IE_CAMPAIGN_PRODUCT_INTEGRATION=1`, while the normal functional manifest supplies it. Its clean environment drops inherited `IE_*`. Required product campaign tests can therefore skip and fail accounting after expensive setup. | Put environment, build, native, fixture, guard and browser prerequisites in the shared suite record. Preflight mode compatibility before I1 starts; require every expected case to execute. Do not convert required skips to passes. |
| P0 | P developer browser stages retain `browserPrerequisites = true` but recreate later plans under new output roots (`tooling/qualification/developer-campaigns/bridge.mjs:389`, `:461`). Later stages can skip builds while pointing at unbuilt fixture paths. | Persist verified fixture build identities and actual input paths, separately from per-attempt evidence directories. Preflight must reject a reused prerequisite whose outputs are absent or do not match. |
| P1 | AGENTS maps six Node groups, but `test:node` covers only 72 of 308 `.test.mjs` files. The broader qualification manifest owns 21 groups but makes all depend on `build-server`, transitively app/vendor/raster work (`tooling/qualification/manifest.mjs:24`). | Separate inexpensive pure/control-plane tests from integration groups. Make ordinary selectors cover the full inventory. Generate the human gate map from the same records. A six-suite pass must never be described as all Node coverage. |
| P1 | Nominal Node suites can launch real browsers: `tests/history/mask-text-compatibility.test.mjs:17` builds legacy fixtures and at `:26` launches Chromium. The developer selector already recognizes Node-hosted browser files. | Classify by runtime requirements and phase, regardless of extension or runner. Include these cases in the browser/setup plan, preserving their distinct native and migration assertions. |
| P1 | Repeated builds: each standalone Node suite and several browser scripts build the server. Even `test:node` followed by the complete AGENTS browser ladder invokes the server build five times and app build twice (`package.json:35`, `:38`, `:43`, `:46`). | Public standalone commands stay safe when run alone, but the scheduler calls shared prerequisites once and internal test actions directly. Cache/reuse only on a verified matching input/output identity. No undocumented `--skip-build` workflow. |
| P1 | Browser plan expansion is 38 Playwright invocations for Chromium/features and 102 for all/features, plus four fixture builds; all/features includes 51 editor invocations. `tooling/qualification/container/run.mjs:153` executes steps sequentially. | Batch compatible specs into one invocation per engine/environment after removing output-name and fixture conflicts. Measure launch/setup/assertion/teardown separately. Do not batch away first-use or restart conditions. |
| P1 | All 28 browser configs effectively use one worker; most directly set `workers: 1`, the timing config inherits it. Many tests additionally own their browser/server lifecycle, so changing the config alone cannot yield safe reuse. | Introduce a bounded correctness lane after an isolation audit. Pilot up to two correctness workers after isolation checks; reconcile the qualified C profile explicitly. Preserve one timing worker and one timing block per physical host. Worker-scoped services and test-scoped contexts/data are candidates, not a blanket setting. |
| P1 | Legacy `tooling/history/gates.mjs:24` and `tooling/portable/{gates,correction-gates,linkage-gates}.mjs` continue after command failures, rebuild through standalone scripts, and mix browser, Node and volume work. | Mark historical recipes as non-default, retaining original evidence. Route future equivalent work through the fail-fast dependency plan; do not silently rewrite old campaign meaning. Scope hygiene checks to authored files instead of checking mutable historical evidence wholesale. |
| P1 | Current PR workflow only emits the physical-qualification boundary notice; ordinary automated gates are dispatch-only (`.github/workflows/qualification.yml:60`, `:138`). Physical qualification is serialized intentionally. | Add inexpensive ephemeral-runner PR checks early, then affected correctness. Preserve the prohibition on running unreviewed PR code on physical runners. Keep final P/Q3 obligations visible and separate from the fast PR signal. |
| P1 | Docker copies changing source before toolchain/dependency/browser installation (`tooling/qualification/container/Dockerfile:15`); CI downloads an approximately 85 MB public fixture and provisions the image before types run. | Layer verified toolchain/dependency/vendor/browser inputs before mutable source. Run cheap inventory and types before large historical/adapter fixtures. Reuse keyed immutable images; retain fresh mutable container state. |
| P2 | Migration helpers repeatedly materialize/build the same immutable old commits. Vendor mutation tests copy the vendor tree in each test (`tooling/test-vendor.py:27`). | Cache verified immutable legacy outputs/fixtures by complete platform/toolchain/source/dependency identity. Give each test independent writable DB/files. Evaluate smaller copy closures or independent copy-on-write files; hardlinks conflict with vendor ownership checks. |
| P2 | `tests/text/renderer.spec.ts:25` navigates in `beforeEach`, then five normal cases navigate again; this repeats across three engines. The storage-reset case owns a separate browser while fixtures can still create an unused runner page. | Make fixture ownership explicit and remove redundant navigation/pages. Install request/error observers before the first navigation; preserve cold-load assertions and intentional reloads. |
| P2 | Review/report maintenance itself has nontrivial cost: the current canonical report is about 178 MiB, while `report.py:104` reads and atomically serializes the full state for each mutation. | Instrument report/checkpoint overhead too. Batch meaningful task-boundary updates with concurrency protection, use the existing compact dashboard, and plan durable archival/summary compaction under the report lifecycle rules. Do not delete history, drop feedback, or run report regression suites for content-only updates. |

The clearest retained timing example is `evidence/p1b6/final-gates-01.json`: session failed after roughly 298.5 seconds of earlier work, and the old wrapper spent roughly 83.2 more seconds continuing afterward. Typecheck was about 0.83 seconds, vendor verification 0.26 seconds and session 5 seconds in that historical run; portable/history/raster took much longer. These numbers support early diagnostics and fail-fast behavior, but are not current benchmarks or a forecast of savings. That historical full build was only a few seconds: measure test setup and execution before assuming builds are the largest cost.

Additional configuration and lifecycle work belongs in the same plan:

- Editor wildcard configurations also select `display-image.spec.ts` without its dedicated server/base URL. Fix both missing selection and wrong selection; adding a filename to a list is insufficient.
- Namespace fixed consumer/display-image ports, text fixture outputs with `emptyOutDir`, and shared artifact filenames before concurrency. Keep `IE_RASTER_OUTPUT` out of tracked `evidence/`. Preserve shell tracing restrictions because traces can serialize session credentials; do not enable traces globally.
- Apply focused-test rejection (`forbidOnly`) consistently. Ordinary fast-feedback and deliberate diagnostic/exhaustive modes need explicit stop behavior. Keep zero automatic retries; changing a timeout requires measured justification.
- Register the four `tooling/test-node.test.mjs` cases and Python vendor/review-workspace/archive test groups, currently outside `tests/` discovery. Trigger archive restore tests on archive tooling changes, not every product edit.
- Separate source acquisition from local native-input verification. Store qualification/input verification and text rebuilding redownload overlapping packages, headers or tools. Reuse verified downloaded bytes when the profile permits; retain independent clean reproducibility output directories.
- Preserve failure environments. `tooling/raster/bounded-webp/build.mjs:145` removes scratch unconditionally, unlike newer producers that retain failed scratch. Repair this lifecycle before debugging expensive native builds.
- Physical CI stages repeatedly check out, bootstrap, fetch preceding packets and verify accumulated receipts. Transfer only newly required immutable packets and retain per-host controller state where safe; retain independent final packet verification and physical host locks. Parameterize browser provisioning only if it saves more than reusing a stable full-engine image.

## Decide whether each test is useful or duplicative

Create one record per stable case or parameterized case family. Audit the highest-cost and overlapping families first, then complete the inventory. A file count or coverage percentage cannot substitute for this review.

Each record should name:

- The user-visible invariant, contract/risk ID, and defect it would catch.
- Its owning layer: pure/domain U, real local integration L, browser B, complete workflow E, performance/resource P, or manual M.
- The observable assertion and independent oracle, including fixture/license/profile version and negative/failure case.
- Why that layer/environment is necessary; what adjacent cases already prove and the unique failure mode this case adds.
- Required inputs, builds, guard, platform/engine, warm/cold state, process lifetime, storage reset, output root, and resource cost.
- Owner, change triggers, last valid result, first failure/flake history, and keep/consolidate/move/repair disposition.

Examples: a pure mask validator owns the exhaustive malformed-input matrix; HTTP tests own authentication, wire shape and writer admission; the browser owns explicit preview/approval and correct pixels; one E workflow owns their wiring. Similar values at these boundaries are not necessarily duplicates. Conversely, copying the entire malformed-input matrix into every browser generally needs a concrete engine-specific reason.

Consolidate only when two cases have the same invariant, boundary, input partition, environment and oracle, and the retained case detects every material defect covered by the removed one. Document that mapping. Use a targeted known regression or small fault/mutation demonstration for valuable disputed cases; do not add a repository-wide mutation campaign by default. Reuse data-generation/setup code without making expected values call the same production algorithm being tested.

Review exact case membership across aliases: E and automated accessibility selectors should refer to cases already owned by the browser inventory, not secretly run them a second compulsory time. Keep Chromium/Firefox/WebKit distinctions where native editing, shaping, storage, workers, rendering, accessibility or past defects depend on engines. Any matrix reduction needs a stated supported-platform claim and retained coverage, not just similar test names.

## Scheduling through the work process

| Point in work | Checks to run | Reuse and stopping rule |
| --- | --- | --- |
| Before editing | Read current handoff/failures; inspect changed scope, installed toolchain/dependency identity, selected case/dependency plan and service ownership. | Reuse the current owned checkout and verified install. Install only when missing, incompatible, or a clean-install claim requires it. No campaign just to establish a starting ritual. |
| During implementation | Run affected types at the first coherent compiling change; pure policy/schema/selector/config regressions as soon as their inputs are ready. Optionally keep a scoped type watcher alive. | Consolidate related edits into meaningful checkpoints. Do not wait until all browser fixtures or every parallel coding task is finished to get cheap negative feedback. A watcher result alone does not replace the final relevant typecheck. |
| Before integration tests | Full applicable typecheck; relevant import/vendor/profile and inventory checks; build the exact required outputs once. | Vendor integrity precedes any `npm ci`. With a valid installed environment, types lead the correctness ladder. Build-free checks may run in a bounded independent lane; a known prerequisite failure prevents expensive descendants starting. |
| Stable implementation checkpoint | Affected pure suites, then real local integrations, then browser cases in contiguous compatible batches. | Expand dependencies conservatively for shared modules. Stop dispatching expensive work after a failure, retain receipts, repair, and rerun the failed/invalidated scope. Do not restart unrelated successful gates. |
| Sweeping change / pre-review | All automated correctness affected by the cross-cutting change; full types and matching builds; all supported engines for changed browser-sensitive behavior. | If impact is uncertain, broaden correctness explicitly. Aggregate planned/selected/executed/failed/skipped counts and outstanding obligations; avoid a false “all green” from a narrow command. |
| Review handoff | Inspect requirements, source diff, oracle strength, exact-source receipts and retained artifacts. Run only additional checks needed to close identified evidence gaps. | Reviewer attribution alone is not a reason to reinstall, clone, or replay every author suite. Changed inputs invalidate their dependency closure; genuine independent execution requirements remain explicit. |
| Formal PR readiness | Fresh base/candidate core P, mandatory P-N, capability-dependent P-A/P-T, and affected Q3 under the governing contract. | Fast hosted PR gates are earlier feedback; trusted physical dispatch and complete acceptance evidence remain required. |
| Qualification / release | Required P/Q3, new-archive clean consumer, native/manual/platform/resource and authorized live work under their named prerequisites. | Honor prescribed samples, cold/warm modes, idle periods, resets and physical host exclusivity. Earlier functional evidence is not a fresh performance sample. |

At a formal applicable PR boundary, the contract requires the fresh base/candidate core P pair and capability-dependent P-A/P-T branches; these are not release-only work. The new hosted fast checks supplement that requirement. Trusted physical dispatch must remain separate from unreviewed PR execution.

This refines the current cheap-first rule; it does not reduce the governing `docs/spec/testing.md:311` requirements. That contract explicitly requires focused and full cohorts for P and fresh installations under defined conditions. Changing those prescribed acceptance campaigns requires a versioned contract amendment with impact/cost evidence. Routine development should not accidentally run those campaigns as every-edit defaults.

Some repeated work is intentional: timing and instrumented byte-audit cohorts keep instrumentation from contaminating measurements; P-D focused/full command cohorts measure distinct required feedback; cold cells require fresh processes, warm cells share their prescribed prime/scored process, and lifecycle cohorts retain one continuous process. Consolidate orchestration around those boundaries without merging the claims.

## Execution architecture

### One manifest, several views

Extend `tooling/qualification/manifest.mjs`, selector discovery and existing reporters. Define a common suite/case metadata module usable by `test:node`, standalone aliases, container plans, CI and developer campaigns. Keep qualified sampling schedules in their own layer on top of that inventory.

Required metadata: stable ID, files/case expansion, invariant IDs, layer, source dependencies, build/fixture dependencies, exact command, tool/engine/platform identity, required environment, network guard, reset mode, resource/port/output locks, estimated cost, timeout, and applicability. Automatic discovery must fail on unassigned tests. Include tooling/Python/native checks deliberately rather than blindly globbing every executable script.

A read-only plan command should resolve dependencies, prerequisites and expected files/cases before execution; disclose selected and excluded scope, repeated work required by the profile, reused evidence, estimated setup cost and missing inputs. An ordinary dry run must not build, install, launch browsers, or create qualification credit. Use declared metadata or explicitly verified side-effect-free discovery: loading test files can execute top-level setup, so framework list mode is not automatically read-only. Verify plan/list mode creates no fixtures or child processes.

Model work as a dependency graph with cheap-first readiness and resource constraints. Keep compatible work adjacent within a phase; allow another group to proceed only when independent prerequisites/resources allow it. Build ordering must follow real dependencies: split arbitrary `app → server → every test` edges, but retain generated assets, text verifier, launcher and fixture prerequisites.

### Reuse boundaries

| Resource | Reuse candidate | Must stay fresh / invalidation |
| --- | --- | --- |
| Toolchain and downloads | Pinned local binaries and verified npm/browser download cache | Platform/architecture, toolchain, lock/integrity or explicit empty-cache profile changes. |
| Dependencies | Existing compatible install in its owned checkout | Clean-install qualification and dependency/lock/native-ABI changes. Never copy live `node_modules` across worktrees. |
| Build outputs | Once per matching dependency graph/session; optional content-addressed cache | Source, generated files, config, dependency/profile/toolchain changes, missing/corrupt outputs. No mtime-only proof or dirty-tree HEAD-only key. |
| Legacy migration fixtures | Immutable compiled old reader and immutable licensed fixture bytes | Each test's new writable database/root; changed legacy closure/compiler/platform. Never replace an old executable migration check with a synthetic reducer. |
| Browser binary/process | Pinned binary and worker-scoped process for compatible functional tests | Fresh context/page/storage per case; fresh process for launch/first-use/leak/browser-restart claims. |
| App/emulator process | Worker-scoped owned healthy service when public reset can prove isolation | Fresh data/auth/session per case; process replacement for restart/crash/isolation tests. Never attach to an arbitrary open port or the user's preview. |
| Test evidence | Exact valid correctness result for unchanged complete inputs and selected cases | No carryover after relevant changes or into prescribed fresh/cohort measurements. Preserve original timestamp/environment and label reuse. |
| Review workspace | One owned worktree per concurrent reviewer, reused across bounded previews | Separate concurrent incompatible builds/experiments; no throwaway clone per follow-up, no shared mutable outputs. |

Build/result keys need source bytes including relevant untracked files, lockfile, compiler/build config, native/renderer profiles, fixture/oracle identities, guard and runner, selected cases, engine revision, platform and behavior-affecting environment. Scope dependencies conservatively at first. Recheck input identity at execution boundaries, verify cache integrity, record a cache miss/invalidation reason, and rebuild on uncertainty. Never cache an incomplete/failed/skipped run as a pass. Avoid a recursive receipt hash that includes its own output or an ever-growing unrelated evidence tree.

A session receipt should show each prerequisite as executed or reused with its origin, each exact case outcome, setup/test/teardown durations, source before/after, and cleanup ownership. Resume creates a new attempt linked to the old failure; it does not edit the old record. Required pending work stays visible after early stop. This should replace the unsafe habit of manually using `--without-dependencies` with unverified stale artifacts.

### Parallel execution and environment ownership

The current implementation is serial. Pilot up to two correctness workers after proving isolation, and explicitly reconcile the qualified C profile's two-worker requirement rather than claiming it already runs with two. Classify CPU, memory, I/O, port, filesystem-volume and process-global resources before increasing concurrency. High-memory raster/renderer work may need a serial lane even when its files are independent. Performance/resource campaigns get exclusive physical-host leases; no competing builds, browser campaigns or agent test runs during their measured window. Use additional approved hosts only when explicitly available.

Use OS-assigned ports where possible, unique private roots, per-run/per-worker/per-case output directories and explicit owning process IDs. Remove shared names before parallelizing screenshot, trace, JSON and NDJSON writers. Preserve store/provider/session guard preloads in children and workers; guard profiles are not interchangeable.

One validation owner should schedule work in a shared checkout. Coding agents can analyze or edit disjoint source concurrently, but cannot each independently rebuild the same `dist` or start overlapping tests. Freeze the selected inputs for an integrated run or use an existing suitable isolated worktree. On cancellation/failure stop owned descendants, retain failure evidence, and verify cleanup without touching unrelated previews or another run's resources.

Prefer resource cleanup at a defined batch boundary. Keep expensive healthy tooling alive within an authorized active session; reset mutable test state rather than tearing down the whole environment. Do not retain contaminated databases or restart away a leak that the test is meant to observe. Finish and release owned resources when their work is complete, preserving diagnosed failures under an explicit retention policy.

## Implementation sequence and acceptance

| Phase | Work | Acceptance before advancing |
| --- | --- | --- |
| 1. Establish truth and cheap negatives | Reconcile inventories; fix recovery harness selection, omitted browser specs, consumer input closure, campaign env metadata and shared fixture paths. Add build-free planning/prerequisite checks. Draft/approve workflow language. | Every active required test has exactly one owning record; aliases map to those records. Negative controls catch unknown/omitted/duplicate files, missing prerequisites and predictable configuration-caused skips before setup; runtime accounting still rejects actual required skips. Confirm repaired consumer closure in one actual clean run. |
| 2. Consolidate execution | Extend the existing runner with dependency-specific builds, explicit development/correctness profiles, unique outputs, fail-fast and resume receipts. Route maintained wrappers and docs through it; label historical scripts. | A multi-suite run builds each required target once. A second unchanged development run reuses only verified eligible state. Changing one input invalidates the right dependents. A failed prerequisite starts no downstream test; resumed receipts retain original failures and pending work. |
| 3. Reuse and bounded concurrency | Group browser invocations, correct fixtures, cache immutable legacy preparation, establish service/worker ownership and resource lanes. Add fast ephemeral CI. | Paired serial/parallel correctness has identical selected/executed case sets and outcomes. Adversarial order/concurrency trials reveal no cross-test state, output collision, orphan process, guard bypass or stale server. Exclusive timing lanes reject overlap. |
| 4. Remove proven duplicate work | Complete invariant/oracle mapping, consolidate duplicated matrices/setup and redundant navigation; streamline evidence/review/report updates. | Each removed execution has a documented retained owner and demonstrable preserved defect detection. Distinct integration, engine, cold/warm, durability and physical claims remain covered. No hidden required skips. |
| 5. Measure and adopt | Compare representative workflows, document limits, update AGENTS/tooling/CI and propose any needed testing/performance contract amendment. | Measured median and tail feedback improve with unchanged correctness coverage; explain regressions/tradeoffs. Keep rollback switches for batching/cache/concurrency until stable. No percentage-speedup claim without receipts. |

Phases 1–2 are the first implementation slice. Do not build a general scheduling platform before fixing the concrete stale selectors and repeated prerequisites. Phase 3 should pilot one inexpensive pure group and one compatible browser batch before broad rollout. Phase 4 can proceed in parallel as read-only coverage review; actual test removals wait for its evidence.

### Measurement plan

Use retained receipts first. Then record a bounded before/after comparison on a stable source/environment for: a small UI edit, server/domain edit, storage/protocol change, broad sweeping change, failure-and-resume, unchanged warm rerun, and dependency/vendor update. Keep clean/cold qualification as its own workload.

For ordinary orchestration measurements, use a small predeclared repeat count sufficient to compare median and range; expand only if variance prevents a conclusion. Qualification retains its prescribed cohorts. Report:

- Time to first useful negative and total time to a trustworthy result, including queue/provisioning.
- Install/build/browser/server starts, bytes copied/hashed/written, fixture preparation, assertion time, teardown, and review/report overhead.
- Critical path and total CPU/runner time, peak RSS, I/O, worker utilization and contention.
- Reused versus executed tasks, invalidation reasons, failure detection stage, flakes, retries, skips and cases actually discovered/executed.
- Environment retention and cleanup: reused working trees, ports/processes left owned, failure artifacts retained, and bounded storage growth.

Do not optimize by hiding setup outside the clock, omitting required cases, loosening timeouts/assertions, adding retries, reclassifying warm state as cold, or replacing real integration boundaries with mocks. Speed targets should be set after baseline attribution; initially require no repeated identical build in one correctness run, no unowned required tests, no unnecessary downstream launch after failure, and no new correctness instability.

## AGENTS.md and documentation changes to make

The [proposed replacement workflow](testing/AGENTS-workflow-proposal.md) is deliberately separate from the live rules. Apply it with the runner work, retaining the pinned toolchain, vendor immutability, network guards and review-storage policies.

Key changes: distinguish environment provisioning from every-run checks; request cheap diagnostics while code is still being developed; replace the incomplete fixed directory ladder with a generated gate map; classify Node-hosted browsers; batch by actual prerequisites; preserve valid results across handoffs; give one owner control of shared builds; explicitly separate functional parallelism from exclusive performance work; and define when full affected correctness and fresh qualification are required.

Update `tooling/README.txt`, relevant area runbooks, package-script descriptions, CI/container documentation and the report handoff together. Several `tooling/*.txt` files are ignored locally, so critical rules must also live in versioned AGENTS and versioned testing docs. Keep sealed `docs/spec` history unchanged; use its versioned amendment mechanism if the acceptance contract changes. Do not turn proposal commands in the spec or this plan into instructions claiming they already exist.

Implementation is recorded in [the active validation runbook](testing/VALIDATION.md) and its verification manifest. The dependency-aware development runner, prerequisite repairs and workflow rules are applied; experimental concurrency/batching remain opt-in. The bounded local adoption checks are complete; full product/performance qualification remains separate and publication requires a destination. This original audit remains a planning snapshot.

The local implementation and planned development verification are complete. The final [runbook](testing/VALIDATION.md), [integration evidence](testing/integration-verification.json), and [ownership decisions](testing/coverage-and-ownership.md) record the complete disposition. All 42 selected editor cases passed serial and batched across three engines with identical identities/outcomes and no retries; Linux passed 546 harness and three wrapper cases. Three paired real-edit repetitions per cohort retained both improvements and the cross-layer result that showed no speedup. Batching and two-worker tooling remain opt-in. The coherent integration is committed to `main` as `b58fc53`, with final fixture refinements and evidence in this document's commit.

Publication is the only remaining action for this task and needs a repository/deployment destination: no Git remote is configured. A-R01 and prescribed native/resource/manual/P-Q3 qualification remain independent project obligations. The earlier manifests are historical checkpoints, not current failure or completion claims.
