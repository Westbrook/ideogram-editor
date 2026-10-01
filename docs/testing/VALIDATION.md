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

The plan orders types, source inventory, selected source/environment prerequisites, selected build-free harness checks, vendor/import verification, the server build, the reviewed fast controller lane, the app build when needed, ordinary Node groups, Node-hosted browser groups, then Playwright. The launcher gets an app build. Browser availability is checked after preflight and before fixture/build work. All selected fixture builds precede browser invocations. The Node-hosted browser split preserves guards, file ownership and preparation; it changes scheduling rather than coverage.

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

## Verification and adoption evidence

`implementation-verification.json` and `completion-verification.json` retain the earlier implementation checkpoints, including their original failures and limited commit scope. They are historical evidence, not the final project qualification or current completion claim. The continuing integration ledger will reconcile the subsequent repairs and adoption trials.

Earlier paired observations passed the same 530 tooling cases with one and two workers on macOS. Linux passed 531 helper cases plus three wrapper cases without an existing server build or network access. Six real context-isolation cases passed across Chromium, Firefox and WebKit; a three-case Chromium authoring pilot preserved serial/batched cases. Broader paired editor and real-edit measurements are still being completed. Batching and two-worker tooling remain opt-in with serial fallbacks.

Three-repeat local measurements retained in the historical manifest: fresh preflight median 14.607 s (14.044–16.289 s), unchanged warm median 5.259 s (4.951–5.599 s); focused tooling serial median 2.505 s (2.505–2.701 s), two-worker median 2.145 s (2.132–2.221 s). Legacy fresh preparation median 1.217 s (1.160–1.307 s), cached median 0.679 s (0.560–2.763 s), including the first cache population. These are ordinary development observations under uncontrolled background load, not physical qualification or a product-wide speedup guarantee.

Docker source COPY owns newly copied files without recursively changing installed dependencies: the earlier ownership stage measured 0.2 s versus 82.9 s. Dependency/browser layers and images remain retained. Linux CI-equivalent commands verify types, inventory, imports and the build-free harness. A historical-object packet without a checkout HEAD cannot claim the normal development runner's exact current-source identity. Hosted Actions and publication require a configured repository destination; none is configured yet.

The initial composition, native-text and tool-rail failures have been repaired and passed focused Chromium checks, described below. Their original receipts remain retained. Full integration, paired browser/engine trials, representative measurements and the coherent project commit remain active work. A-R01 and prescribed native/resource/manual qualification are independent outstanding project obligations, not credit supplied by these development tests.

## Completion continuation

Focused browser selection now accepts `--browser-grep '<regular expression>'`; it records the pattern in the plan and retains exact discovered/completed accounting. Select the owning browser families too: a file with no matching case is incomplete, not a pass. `--batch-browser --browser-groups editor-composition,editor-native-text,editor-tool-rail` groups only those compatible files per engine. Separate invocations remain available for comparison.

Preflight now parses JavaScript and TypeScript test sources without importing them, catching syntax errors in files outside the app tsconfig before fixture preparation. Vendor/import cache closures are explicitly scoped and covered by changed-input controls; unknown gate dependencies remain conservative. Receipts explain prerequisite reuse decisions and list pending browser steps after an early failure.

The native-text draft reader now uses the retained-draft memory admission boundary; accepted text rendering keeps its original 16 KiB limit. All six Chromium native-text cases passed, including over-limit draft recovery and render refusal. The tool rail now scrolls within its allocated area and preserves toolbar height; both Chromium pointer/keyboard/reflow cases passed. The earlier rail failure was a pointer target covered by the cleanup region, not a keyboard failure.

Composition checks now retain exact-request fetch signal, body EOF/length and successful reader-cancellation evidence. Expected busy replies require a drained control body plus a canceled owner or completed retry. The late-review test waits for released response headers rather than indefinitely waiting for an HTTP finished event after intentional reader cancellation. All six composition scenarios have passed focused Chromium runs; this is not yet the full paired engine result. Original failures remain in their receipts.

Use `npm run verify:raster:producer` for the immutable macOS bounded-WebP producer. Its opt-in preload defers cleanup only for producer-prefixed temporary directories allocated by that process. Success removes them; failure prints and retains their paths. Existing or unrelated directories are never intercepted. The compiler recipe and sealed bytes are unchanged, including the macOS manifest consumed by Linux reproduction. This remains an explicit native reproducibility campaign, not a routine edit-loop gate.

Focused Node diagnosis accepts `--node-files <comma-separated repository paths>` together with their owning `--groups`. Unknown, duplicate or out-of-group files fail before setup. The selection preserves every case in each file, required guards and Node-hosted browser scheduling; it does not introduce expected skips. Use the full affected groups at the integration boundary.

Store fixture roots now remain owned until the test-file process exits, after all teardown hooks. A failed body or late cleanup retains the roots and prints their paths. Successful files remove their own unchanged directory identities. This deliberately retains all roots from a failed file, including its preparation fixtures, instead of losing the first failure's state.


The reviewed fast lanes contain four request controller/core files (136 cases, about 2.2 s) after their server build, plus three export controller/destination files (192 cases, about 4.0 s) with no build prerequisite. Export checks run before vendor verification and server/app production; request checks run before app production and integrations. Both retain their file-level network guard and serial execution and are removed from later integration gates. Exact membership and injected-failure controls passed; unknown files retain the conservative integration lane.

Integration repairs retain the original oracles. History cancellation fixtures observe the actual worker identity, generation and command slot. Nested raster copies distinguish the first format-7 archive from format-9 copies containing remapped retained metadata; old executable refusals, malicious downgrades, pixel comparisons and restart checks remain. Request action completion now clears stale live-region progress only for its continuing owner and only if no newer announcement replaced it. Adapter fixtures supply actual matching prompt/precondition bytes; original authored draft bytes are checked by exact hash and byte comparison inside the declared retained archive, while current remapped drafts remain separately verified.

Export cancellation fixtures now import the real command-memory admission module and implement the journal scan boundary. Waiting for submission races the observed command outcome, so an early command failure is reported instead of hanging; a five-second controller deadline is a backstop. The text/raster admission fixture uses the current empty ownership tables and namespaced worker slot, races early worker settlement, closes its worker, and retains failed roots. Export coverage (192 cases across the original gate and targeted repair), composition (29 ordinary cases) and text-state (136 ordinary cases across the original gate and targeted repair) have completed; Node-hosted browser cases remain separate.

Portable completed 159 ordinary cases without skips. Recovery completed 203 ordinary cases across the original gate and its 18-case migration rerun: successor-schema checks now require the exact two preservation indexes while preserving every predecessor schema declaration, row and backup assertion. Original-path restore explicitly registers its newly created directory identity; an unregistered replacement still fails cleanup.


Campaign integration completed its 757-case inventory through the retained 753-pass run and a 26-case focused repair. Fixture initialization now closes a writer on setup failure, and reopening refreshes its client binding through the existing replacement API. Mutable mailbox descriptors permit only the observed unlink-and-replace race; immutable descriptors remain strict. Native admission allocates one declared-size buffer under its 1 MiB ceiling and rejects overflow, truncation or changed digest. The stroke fixture supplies its actual first-input timestamp, and diagnostic interval expectations use the exact 3,072-operation total. Original failure receipts remain retained.


The real native-text recovery gate exposed an export dependency regression: the whole-document path required original fonts even when accepted canonical pixels survived. Export now proves the actual accepted raster inputs and retains asset identity fences; editable history/copy paths still prove full provenance. The existing native-text test passed with a missing historical font, while complete-copy refusal remained asserted. The affected export scope, frozen-revision, cancellation and ownership files passed together before the native browser gate.


## Current edit measurements

Three paired repetitions per cohort used actual reversible source edits, identical selected case identities and outcomes, zero retries, one separately recorded priming run and the same pinned environment. Each optimized run preceded its `--fresh` counterpart. All pairs passed and original source bytes were restored. Wall time includes the runner and identity checks.

| Edit cohort | Reuse median (range), seconds | Fresh median (range), seconds |
| --- | --- | --- |
| Server protocol constant | 33.7 (33.6–34.8) | 38.8 (37.5–39.4) |
| Storage budget constant | 17.8 (16.4–18.7) | 21.8 (21.5–22.7) |
| UI heading | 38.9 (38.2–39.7) | 40.8 (40.8–41.9) |
| All three layers together | 59.1 (50.1–61.4) | 57.2 (53.8–57.9) |

The cross-layer result does **not** demonstrate a speedup. Its changed inputs require the same types and builds; only vendor verification was reusable. Protocol execution varied from 12.3 to 19.4 seconds and dominated the paired differences, whereas recorded source-identity time was 0.2–0.4 seconds. Preserve this regression/variance instead of expanding repetitions until a favorable result appears. The three-file cohort is not a repository-wide sweeping-change benchmark. Use affected selections during edits and full affected correctness at integration; use `--fresh` when reuse offers no useful savings or when fresh evidence is required. No acceptance threshold, retry, case or guard changed for these measurements.

The complete commands, executed/reused gates, command CPU/RSS observations, source digests and case lists are retained in `artifacts/validation/real-edit-cohorts/attempt-1790825334/measurements.json`. RSS is an OS command observation, not a combined-process peak or product memory qualification. Three observations support median/range reporting, not percentile or general performance claims.


The first three-engine comparison passed all 14 Chromium cases, then stopped at Firefox authoring. Its retained public validation evidence reported “Recovery is already active”: an older command could restart the SSE consumer while a newer command owned snapshot recovery. `EditorClient.startStream` now refuses to start while `syncTask` owns recovery. A deterministic control exercises both the release wait and active recovery, then proves one SSE start after settlement; the formerly failing real Firefox authoring scenario also passed. No timeout, retry or expected outcome was changed. The original pairing failure remains retained.


Firefox also exposed an independent Blob-lifetime defect: a Blob retrieved from IndexedDB and wrapped with `new Blob([part])` could still depend on the database backing file. Deleting the spool before browser handoff prevented raw downloads. A local native reproduction failed with both attached/detached anchors and both immediate/delayed URL release, while a byte-detached Blob downloaded exact bytes. The product now reads each at-most-1-MiB stored chunk into independently owned Blob bytes, reserving both copies before reading and releasing that reservation afterward. Native-memory uncertainty remains explicit; this is not a resource-ceiling qualification. The 33-MiB native tests now verify both bounded copy passes and their actual reservation observations, retaining exact output hashes, deletion order, release timing, cancellation and refusal assertions.

Composition fixture reloads wait only for their observed display-tile reads. Successful scenarios close the document through the public UI before navigating to cleanup, so queued autosaves and display owners drain rather than being cut off by the fixture. The classifier continues to require exact-request terminal evidence. A pre-header SSE cancellation now additionally requires its observed native fetch signal, with positive and wrong-request/missing-abort controls in all three engines. No network-idle wait, extra body consumption, timeout extension, retry or URL-only cancellation allowance was introduced.
