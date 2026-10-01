# Repository workflow

- Use Node **26.10.0** and npm **12.1.0**, pinned by `engines` and `packageManager` in `package.json`. Use npm only. Select the pinned toolchain described in `tooling/README.txt`; install with `npm ci`.
- During implementation, run `npm run typecheck` as soon as a coherent edit is ready. Fix cheap failures before building or launching browsers. At a validation boundary use the shared runner below; it checks types first and reuses only a verified unchanged type result.
- Plan without executing tests: `npm run validate -- plan --groups all --browsers all`. This is the current generated gate map; `npm run test:preflight` detects unowned Node/browser files, invalid prerequisites and incomplete consumer inputs without importing test modules.
- Run affected Node groups together: `npm run test:node -- session store` or `npm run validate -- run --groups session,store`. `test:node` defaults to the six base groups; `-- features`, `-- helpers`, or `-- all` select the other registered groups. Use `all` for sweeping changes; the base ladder alone is not full coverage.
- The development runner orders types → inventory → selected build-free tooling tests → vendor/import checks → necessary builds → ordinary Node suites → Node-hosted browser suites → Playwright. It builds each required target once, including the app for launcher tests. Stop at the first unsuccessful gate and repair that area before advancing.
- Maintained session/store/protocol/assets/raster/history/provider/adapters and browser npm wrappers use the same runner. Combine related work into one invocation; do not interleave browser setup with ordinary Node testing. `--browser-groups consumer,shell` selects explicit browser families; omit it for the full selected-engine inventory.
- Reuse the owned checkout, install and pinned browser cache. Prerequisite/build reuse verifies source, installed dependency and output contents. Ordinary tests rerun unless explicitly resuming a source-stable receipt with `--resume /absolute/path/receipt.json`; browser and prepared-fixture tests always rerun. `--fresh` disables reuse, including legacy compilation caching. Legacy cache restores verify immutable bytes and keep each migration’s writable state independent; retain corrupt/failed entries for diagnosis. Keep receipts in `artifacts/validation/` and do not delete failure evidence to retry.
- One runner owns shared build outputs via the checkout's `artifacts/qualification/active.lock` and acquires the fixed physical-host timing lock before starting gates. Never remove another run's lock or rebuild its outputs. Confirm the owner exited before recovering a stale lock. Do not change sources during a run; drift makes its result inconclusive.
- Correctness defaults to one worker. `--workers 2` is an opt-in pilot for the qualification Node group only; other Node groups remain serial with their existing guards. Do not increase concurrency until paired runs preserve cases, outcomes, isolation and resource headroom. Opt-in `--batch-browser` uses per-spec evidence namespaces and fresh contexts; `--serial-browser` restores separate editor invocations.
- Keep performance, resource, cold-install, native/manual and P/Q3 campaigns separate and fresh as their contracts require. Do not run correctness work on a host while an exclusive timing campaign is active. Cached development results cannot satisfy those campaigns.
- Do not repeat successful unrelated suites without changed inputs, a failure, or an unresolved concern. Record the selected coverage, executed/reused gates, pending work and actual outcome at handoff. See `docs/testing/VALIDATION.md` for commands, boundaries and remaining validation work.

## Gate map

The authoritative Node groups are in `tooling/qualification/suite-prerequisites.mjs`; the browser inventory is in `tooling/qualification/container/browser-plan.mjs`. Generate the exact dependency graph with `validate plan` instead of maintaining a second file list.

| Selection | Scope |
| --- | --- |
| `--groups preflight` | Types and inventory only |
| `--groups tooling` | Qualification harness tests and runner tests; no app/server build |
| `--groups base` | Session, store, protocol, assets, raster, history |
| `--groups features` | Product feature Node groups |
| `--groups helpers` | Browser/recovery/text/completion/tooling helper Node groups |
| `--groups all` | Every registered Node group; not every specialized campaign |
| `--browsers chromium`, `firefox`, `webkit`, `all` | Selected-engine browser inventory; shared Chromium fixtures where required |

Browser binaries must match pinned Playwright. The runner checks availability before builds, never installs automatically, and gives each run an ignored evidence directory. Negative browser harness specs run only through their Node parents. Dedicated integration and display-image configurations own their respective specs.

## Vendored inputs and network guards

- `@en-reve/*` and `canvaskit-wasm` use local `vendor/` tarballs, with hashes/integrity sealed in manifests and the lockfile. Never edit vendored artifacts in place. Adopt new verified snapshots/versions through their producer tooling and update the matching dependency/lock identities together.
- `npm run verify:vendor` checks the frozen inputs and archives; `npm run verify:imports` checks supported public En Reve imports. Both must pass. Do not replace local tarballs with registry packages or sibling-source links.
- `tests/session/no-egress.mjs` patches `Socket.connect` to allow only literal IPv4 `127.0.0.1`; it rejects other hosts, including `localhost`. Session, protocol, assets, raster and history use it.
- `tests/store/no-network.mjs` throws and counts calls to patched fetch, HTTP(S) request/get, socket connect, DNS lookup/resolve, and datagram creation, including loopback. Store tests use it.
- Preserve these preloads and worker/child-process propagation. They are test guards, not an OS network sandbox; never bypass them to make a test pass.

## Review storage

- Reuse the current owned checkout first. When isolation is necessary, use one Git worktree per concurrent review and reuse it across previews; do not create a full clone per run.
- Worktrees share Git history, not dependencies or build outputs. Never copy `node_modules`, `dist`, or `test-results` into a new review tree. Install only when execution is required, reuse npm's download cache, and keep each active worktree's install/output isolated.
- `npm run audit:reviews` lists matching sibling directories, allocated sizes, ages, known worktrees and report/preview exclusions. Use `npm run --silent audit:reviews -- --json` for JSON; add `--parent /absolute/repos` to audit another parent.
- Directory age is a modification-time heuristic, not proof of inactivity. Candidate bytes are an upper bound, not guaranteed reclaimed space. Confirm active services, unique work and retained evidence with the user before any removal; the audit has no deletion mode.
- For copy-only evidence archives, follow `tooling/ARCHIVE.txt`: one packet description, shared inspect/create/verify commands, exact seal boundaries and a verified fresh restore. Keep originals; archive verification does not approve product changes or deletion.
