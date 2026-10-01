# Development validation

The development runner shares inventory and execution primitives with formal qualification, but its receipts explicitly carry `qualification: false`. It keeps the pinned Node 26.10.0/npm 12.1.0 toolchain, network preloads, required assertions and zero-retry policy.

## Commands

Select the pinned toolchain first: `export PATH="$PWD/.toolchain/bin:$PATH"`. Provision with `npm ci` only when the install is absent or dependency inputs change, after verifying vendor inputs. Install the matching Playwright browsers once per owned environment. Ordinary validation never downloads them or replaces an install.

```sh
# Metadata only; does not import tests or start services.
npm run validate -- plan --groups all --browsers all
npm run test:preflight

# Cheapest feedback while making a coherent edit.
npm run typecheck

# One owner, one build of each required target, then selected suites.
npm run test:node -- session store
npm run validate -- run --groups provider,queue
npm run validate -- run --groups all --browsers all

# Isolated browser families; fixture dependencies are selected automatically.
npm run validate -- run --groups preflight --browsers chromium --browser-groups consumer,shell
npm run test:browser
npm run test:text

# Explicit controls: fresh evidence, a bounded concurrency pilot, and recovery.
npm run validate -- run --groups tooling --workers 2 --fresh
npm run validate -- run --groups session,store --resume /absolute/path/receipt.json
npm run validate -- run --groups preflight --browsers chromium --batch-browser
npm run validate -- run --groups preflight --browsers chromium --serial-browser
```

`test:node` defaults to `base`. `base`, `features`, `helpers` and `all` are aliases for the central registry, not independent test lists. Use a comma-separated group selection with `validate`; unknown groups/families fail before execution. `--browser-groups` names the `family` fields in the generated plan. Browser batching is an opt-in pilot (`--batch-browser`) until paired product validation passes. The `--serial-browser` fallback uses the original separate editor invocations. `--workers` affects only the qualification Node group, accepts one or two, and defaults to one. It does not parallelize storage, timing or browser work implicitly.

The maintained session/store/protocol/assets/raster/history/provider/adapters wrappers and ordinary browser wrappers use this runner. Specialized volume, codec, historical producer, P/Q3, native/manual and clean-install campaigns retain their explicit entry points and contracts. `test:qualification` remains a direct build-free diagnostic for the harness itself. Python verification/review/archive tests are available through `--groups vendor`, `reviews`, and `archives`; inventory those separately from product Node coverage.

## Scheduling and ownership

The plan orders types, source inventory, selected source/environment prerequisites, selected build-free harness checks, vendor/import verification, required builds, ordinary Node groups, Node-hosted browser groups, then Playwright. The launcher gets an app build. Browser availability is checked after preflight and before fixture/build work. All selected fixture builds precede browser invocations. The Node-hosted browser split preserves guards, file ownership and preparation; it changes scheduling rather than coverage.

The checkout lock is shared with the existing functional qualification runner. A second owner fails rather than starting competing builds. Do not remove a live owner's lock, delete its output, or edit source during its run. A source/dependency change during execution makes the result inconclusive and prevents publishing new reuse records. Following a crash, inspect the lock's PID and retained receipt and establish that the owner is gone before manual recovery.

A fresh output directory is created under `artifacts/validation/` for each invocation. A directory holds logs, per-gate executed/reused status, source/environment identity, outcomes and pending gates. Failures stop subsequent gates. SIGINT/SIGTERM use the existing bounded child-process cleanup. Browser evidence checks both the Playwright result tree and independent discovered/completed-case ledger; retries, skipped required cases or incomplete evidence do not become success.

## What is reusable

Types, vendor/import verification and app/server builds can be reused when their input keys and successful logs still match. Builds also require the existing output tree to match its recorded content hashes. Installed dependency contents and the sanitized execution environment participate in the key. Keys are deliberately conservative: unknown dependencies invalidate broadly; this is not a compiler dependency graph. Test-only edits do not invalidate app/server build output, while consumer fixture source remains a build input.

Normal Node tests execute on each invocation. Explicit `--resume` can reuse an unchanged successful Node gate and its verified TAP log from a source-stable development receipt. Gates with browser/fixture/completion/adapter preparation execute again. An old failure receipt is never edited into a pass. Browser test outcomes, physical samples and qualification receipts are never reused as new execution. `--fresh` disables development reuse.

Immutable browser fixture paths are separate from evidence paths (`TEXT_APP`, `IE_RECOVERY_APP`, `IE_RASTER_APP`). The developer campaign bridge retains and checks preparation manifests across its focused/full stages. Each editor spec has an evidence namespace in a batch; mutable browser contexts stay isolated. Chromium/Firefox can share a worker browser process in the three custom editor fixtures; WebKit persistent profiles remain per-test. Text cases navigate once, capture initial requests before navigation, and the stock-storage case does not also create the ordinary page fixture.

Keep healthy installs, browser distributions and owned workspaces. Keep deliberately cold installs cold. Do not clean away a leak, failed snapshot or contaminated database that a test is intended to detect. End owned services at the documented batch boundary. No automatic workspace/evidence deletion is introduced.

## Coverage repairs

- Recovery's ordinary config selects consumer and metadata specs; intentionally failing harness specs run through their Node parents, and E4 retains its dedicated config.
- Display-image and integration specs keep dedicated configs. The complete browser plan includes display-image, metadata and export-destination-commit.
- Campaign Node selections receive their required product-integration environment through shared metadata.
- Consumer copy closure includes every local package archive plus CanvasKit/vendor text prerequisites before creating the install workspace.
- Source-only preflight reconciles every `.test.mjs` and `.spec.ts` with its owner and refuses missing, extra or duplicate ownership. It does not claim discovery of actual runtime test cases; reporters check those during execution.
- Node 26's file-wrapper enqueue event is excluded from case discovery; actual child tests still require exact discovered/completed identity.

No product assertion matrix or test case was deleted. The synthetic timestamp test allows only a 1e-9 arithmetic-rounding tolerance; production performance ceilings are unchanged.

## CI and qualification boundaries

The supplemental PR workflow runs on an ephemeral Ubuntu runner, checks the pinned toolchain/vendor closure, then types, preflight and harness tests. It retains receipts on failure and cancels superseded PR jobs. It defaults to serial execution pending the concurrency pilot. The container caches dependency/browser layers separately from ordinary source changes; source checks precede historical input installation.

Physical timing exclusivity and required fresh P pairs/Q3 samples remain governed by existing qualification tooling. Do not run correctness work on a timing host while its exclusive campaign is active. The development runner now acquires the same fixed host lock as timing campaigns, in addition to its checkout lock. A competing owner refuses the run before any gate starts; neither a different checkout nor TMPDIR creates another host lane. Standalone commands outside this runner still require explicit scheduling. Native AT/IME, resource ceilings, codec RSS and live-provider claims cannot be supplied by these development receipts.

## Verification and remaining adoption work

See `implementation-verification.json` for exact receipts and results. The initial fresh/unchanged preflight pair measured 5.6 s / 0.7 s including identity work. This single pair demonstrates functioning reuse, not a median/tail performance claim. The batched browser plan contains the same file/engine selections with 57 Playwright invocations instead of the repaired separate plan's 108; elapsed-time benefit requires actual paired runs.

The draft-retention test fixtures now assert cancellation-only reader ownership and retained resources after failed cleanup. The full macOS serial/two-worker pair passed the same 530 cases. Final Linux verification passed 531 helper cases plus three wrapper cases, with zero skips and no existing server output. The Linux run exposed and fixed a hidden dist dependency in recovery-memory tests; their pure protocol closure now comes from current source.

Implementation now includes immutable legacy compilation reuse, physical host exclusion, explicit invariant/oracle ownership, three-repeat feedback/preparation measurements, representative edit/dependency invalidation controls and Linux CI gate execution. Full editor equivalence remains blocked by the product gates below. Broad batching and concurrency remain opt-in; hosted Actions was not run because this checkout has no Git remote. No sealed producer recipe or product acceptance limit was rewritten.

The selected completion-source check now runs immediately after inventory. It checks the same reviewed source hashes as issuer preparation without building or launching a browser. The changed recovery/text ownership boundaries received the recorded review in `completion-network-review.md`; their current source check and emitted issuer preparation pass. The earlier negative is retained and confirms that no build or browser started before that review.

Additional bounded pilots passed: 16 real Chromium text cases; six shared-fixture/context-isolation checks across Chromium, Firefox and WebKit; and identical 70-case tooling selections with one and two workers (3.39 s / 0.98 s in one pair). These support the pilot switches; they do not replace full batch equivalence, order/contention trials or performance cohorts. Development app/consumer producers omit redundant import verification only after the owning plan's import gate; standalone npm producers retain that prerequisite.

The complete store gate passed with the required native macOS access. The earlier sandbox attempt remains a failed/interrupted record and was also marked inconclusive after a documentation input changed; it is not reused. A read-only temporary-volume prerequisite now checks macOS DiskManagement before storage-dependent builds, avoiding repeated per-case waits in restricted environments.

The final-source fresh/unchanged preflight pair was 11.8 s / 2.1 s, compared with the earlier 5.6 s / 0.7 s pair. Both verified reuse, and the variability reinforces that no general median/tail or percentage-speedup claim is warranted from these pilots.

## Completion findings and rollout limits

- Legacy preparation defaults to a verified development cache under `artifacts/validation/legacy`; `--fresh` and formal qualification keep fresh compilation. The archive, compiler installation, producer, platform and output bytes participate in identity. Each migration keeps its own writable directory and database. Conflicting producers refuse rather than steal ownership; corrupt entries and failed preparation directories are retained. Three local fresh preparations had median 1.217 s (1.160–1.307 s); the cached cohort had median 0.679 s (0.560–2.763 s), including its initial cache population. The initial population is more expensive; reuse pays only across repeated matching preparation. All seven real asset storage/migration cases passed, followed by ten text-schema and ten portable-schema cases through the shared legacy helpers. Six stale final-schema 13 expectations in the portable file were corrected to the current schema 17; exact intermediate barriers, refusals, rollback and SIGKILL assertions remain. The original failures are retained.
- Internal app/consumer production uses the installed Vite through pinned npm with downloads disabled, preserving npm identity in build receipts. This does not repeat import verification already owned by the plan.
- Docker parent-directory exceptions explicitly exclude unrelated artifacts/report contents. Source COPY sets its ownership without recursively changing installed dependencies; that ownership stage measured 0.2 s versus 82.9 s in the earlier image build. System/toolchain/dependency/browser layers were reused after source fixes. `procps` is explicit because host locking needs process ancestry. Images and stopped containers are retained.
- The Docker source packet deliberately contains historical Git objects without a current checkout HEAD. Its CI-equivalent gates execute directly; the ordinary development wrapper still correctly requires a checkout revision. This is Linux functional evidence, not hosted workflow, AMD64, physical P/Q3 or product qualification.
- All product assertions remain. The ownership review in `coverage-and-ownership.md` explains why similarly named checks at different boundaries are retained. Only verified setup/navigation duplication has been consolidated.

The following product failures were discovered by the rollout pilots and remain required failures, without retries or relaxed assertions:

| Gate | Observed failure | Retained evidence |
| --- | --- | --- |
| Editor composition | Aborted successful display-tile requests are not covered by the existing exact-request cancellation proof. Do not whitelist these by URL alone. | `artifacts/validation/2026-10-01T00-24-46.300Z-68f71227-6e0a-4b8f-b93c-cd29951f5201/editor-composition-chromium.log` |
| Native text | The 70,000-character over-limit draft is empty after reload despite the saved-status indication. | `artifacts/validation/2026-10-01T00-28-14.460Z-46392ba8-bbc2-438c-8ff7-3a3ba92e518e/editor-native-text-chromium.log` |
| Tool rail | The keyboard interaction at `tests/editor/tool-rail.spec.ts:23` leaves `aria-pressed=false` where the test requires true. | `artifacts/validation/2026-10-01T00-31-44.976Z-75ef7098-4e00-420e-8e04-63fecdd8dd8c/editor-tool-rail-chromium.log` |

These failures block full editor batch adoption. A passing bounded authoring/process-isolation pilot does not replace them. Resolve each owning product/interaction contract, then repeat the affected serial/batched family and complete engine/order coverage before changing defaults. A-R01 and prescribed native/resource/manual qualification remain open independently.

The commit scope is the validation work and changed test/tooling prerequisites. This checkout also has substantial preceding uncommitted product work. Recorded integration results describe the audited working tree; they are not a claim that the validation commit alone includes that whole product snapshot. No remote publication was performed.

Final three-repeat feedback observations: fresh preflight median 14.607 s (14.044–16.289 s), unchanged warm median 5.259 s (4.951–5.599 s), including identity and process overhead. The identical focused tooling subset measured serial median 2.505 s (2.505–2.701 s) and two-worker median 2.145 s (2.132–2.221 s). These are small local cohorts with uncontrolled background load, not a product-wide or physical-host speedup guarantee. UI/server/storage/sweeping/dependency invalidation is covered by isolated negative controls; no timed real-world edit cohort is claimed.
