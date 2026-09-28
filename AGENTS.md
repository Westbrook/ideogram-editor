# Repository workflow

- Use Node **26.10.0** and npm **12.1.0**, pinned by `engines` and `packageManager` in `package.json`. Use npm only. Select the pinned toolchain described in `tooling/README.txt`; install with `npm ci`.
- Run gates cheapest first: `npm run typecheck`, then the Node suites below in order, then the Playwright targets. Stop at a failed gate; fix and rerun that gate before advancing. Do not repeat successful unrelated suites without a new reason.
- After typecheck, run `npm run build:app` before the session gate on a clean checkout: its CLI launcher test requires `dist/app`. Rebuild it when app sources change.
- Fast path: `npm run test:node` builds the server once, then runs all six Node suites. For selected areas use `npm run test:node -- session store`; selections always run in the table's order. Each invocation builds afresh and stops on the first failure.
- Existing standalone scripts retain their original build steps. The fast path preserves their network guards, serial test execution, and file selections; it does not cover every test directory in the repository.

## Gate map

Run each script with `npm run <script>`; choose the failing area instead of repeating the whole ladder.

| Script | Area |
| --- | --- |
| `typecheck` | Consumer fixture, app, and server TypeScript |
| `test:session` | Local HTTP/session security, pairing, private roots, launcher |
| `test:store` | Durable SQLite writer, receipts, recovery, crash/failure behavior |
| `test:protocol` | Commands, snapshots/tails, content transfer, retry and SSE protocol |
| `test:assets` | Upload staging, asset storage, ownership, migration and crash recovery |
| `test:raster` | Image decoding, conversion approval, pixel/export correctness, raster storage |
| `test:history` | Image edits, undo/redo, retained branches, replay, schema migration |
| `test:browser` | Playwright public En Reve consumer registration; first run `npm run build:consumer` |
| `test:shell` | Playwright editor shell, session integration, keyboard/layout/CSP |
| `test:recovery` | Playwright browser projection, snapshot/tail/SSE and multi-tab recovery |
| `test:raster:browser` | Playwright raster conversion preview, approval, recovery and PNG content |
| `test:text` | Playwright native text workers, shaping, rendering and admission in three browsers |

- Browser tests require the browsers for the pinned Playwright dependency. Keep outputs in ignored directories; set `IE_RASTER_OUTPUT=artifacts/agent-raster` before `test:raster:browser` (its default JSON report is under tracked `evidence/`).
- Specialized volume, resource and clean-consumer campaigns have additional prerequisites; consult the corresponding `tooling/*.txt` instead of treating this ladder as full product qualification.

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
