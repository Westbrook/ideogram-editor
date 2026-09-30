# Continue Ideogram Editor in another harness

This is the **2026-09-30 local-main consolidation**, requested after repeated harness crashes. It includes unfinished work; integration is not product acceptance. No remote push, provider call, browser qualification, service restart, or old-root cleanup was performed for this handoff.

Start with [the current project plan](PROJECT-PLAN.md), then [the source map](handoff/20260930/source-map.json) and [evidence index](handoff/20260930/evidence-index.json). The approved contracts remain in [docs/spec](spec/index.md). Historical statements there about not starting implementation describe the original specification handoff; the later user-directed implementation and this consolidation supersede that scheduling restriction, not the technical contracts.

## Current source and acceptance

| Source | Identity | Meaning |
| --- | --- | --- |
| Previous local main | `ecf703019a36a4617f607440b5efb3c4cff9d1fd` | Preserved as a merge parent, including agent gate guidance, shell test correction, and copy-only archive tooling. |
| Latest complete recovery lineage | `93fa3121ee080c47913fef0b1be9147ca5973180` | Merged in full; contains accepted P1c and P2.1–P2.4 plus unaccepted P2.5. |
| Last accepted P2 slice | `086c9a677512f1faae98f9e947084ffb93c09431` | P2.4 retained candidates/E2 accepted; P2 total remains **56/100**. |
| Spectrum delta | `5d8dd5dfec9b3192b8c129daf73bac9e874d4389` over `2ba6ed79a846e674dcdeb7dd7d438c3115565cf1` | Exact reviewed 24-file delta applied: authentic tokens, System/Light/Dark, pan button alignment and Select label correction. Standalone approved; integrated build not accepted. **0/3 earned**. |

The source map lists every integrated changed file and its exact SHA-256/source. No dependency upgrade or lockfile change. Recovery fixes remain byte-identical to `93fa312`; the theme files remain byte-identical to the reviewed theme commit. `package.json` combines the newer source with main's existing test and audit scripts. Diagnostic experiment variants were not substituted for the complete source lineage.

Use `git log -1 --format='%H%n%P%n%s' main` for the resulting main commit and parents. Main is checked out at `/Users/westbrook/intent/workspaces/suites-test/ideogram-edit`. The original `/Users/westbrook/Documents/repos/ideogram-edit` remains on `ideogram-editor-p1` at `231c7530b7f9a9f1ccac34b13bc0a8b19ce854d4`; its unrelated untracked `.intent/` was not staged. Do not mistake that older worktree for current main.

## What is still unaccepted

P2.5 earns **0/14**. Independent review closed F1–F4 (recovery authorization, shared-hash reclamation/reopen, terminal-shaped HTTP errors, and stale/busy queue action ownership) on `93fa312`. The author subsequently reported one Firefox, Chromium and WebKit E4 pass. The final whole-slice outcome review has no recorded final verdict at this handoff and is marked waiting for the next harness; it was not restarted.

The campaign package SHA-256 is `346e5b294534986ec3e3609dce2fd3e8d377885bdc170b5ec58f6a4fb8f8aaf6`; the execution seal is `4099faaa06ed924212989dcb94055b42e1d961a8c852301117912de4ecd1d7c4`. Original location: `/Users/westbrook/Documents/repos/ideogram-edit-p25-f1-f4-20260929/e4-execution-evidence/campaign-package.json`. The copied index retains individual evidence paths/hashes and author attribution. Author completion was `2026-09-30T01:51:09.636176Z`.

Preserve these limits when continuing:

- The original 222-test invocation **failed: 220 passed, 2 CAPACITY refusals**. A later isolated retention selection passed 25/25 on unchanged source. The cause is unknown; this is neither an aggregate pass nor a memory fix. Large-prompt copied-byte reread and combined-load compliance are not established.
- The final Firefox deletion-time candidate 404 and aborted network records still need outcome disposition. Empty page/console error arrays do not erase network responses. Prior publication timing causes remain unclassified.
- E4 publication observations/renderer tracing do not prove physical display presentation or formal H4/I6H qualification. P3 retains those obligations.
- **A-R01 is open:** the historical 25 MP WebP native RSS breach exceeded the unchanged 512 MiB ceiling. Later admission/refusal evidence does not establish general peak-memory compliance. Keep the original feedback and evidence association.
- Spectrum first paint may use System before restoring the saved choice; physical assistive technology, native pickers, display timing and all failure cleanup paths remain unqualified. The reviewed fixture has a known nonblocking trailing blank line; `git diff --check` reports it. Its exact source was preserved.

## Start and check locally

Use Node **26.10.0**, npm **12.1.0**, and npm only. From a clean checkout, `tooling/README.txt` explains bootstrap and pinned vendor inputs:

```sh
python3 tooling/bootstrap-toolchain.py
export PATH="$PWD/.toolchain/bin:$PATH"
npm ci
npm run verify:vendor
npm run typecheck
npm run build
npm start -- --root /absolute/new/private/editor-root --no-open
```

The root must satisfy the ownership/0700 rules in `tooling/SESSION.txt` and `tooling/STORE.txt`; use a new canonical path and preserve all historical roots. The launcher chooses a loopback port and records it in private `launch.json`. Type `pair` in that terminal to open the one-use local pairing flow; never copy pairing tokens into notes, logs or links. Ctrl-C stops that owned server. Do not restart frozen preview `http://127.0.0.1:50427/` or assume its old source is this build.

The normal launcher does **not** enable real Fal generation merely by supplying a key: production profiles remain denied pending the usable-Fal work. Deterministic workflows use the isolated fixtures under `tests/provider`, `tests/request`, `tests/candidates` and `tests/recovery`; do not expose fixture modes in production. The existing scripts and AGENTS.md describe cheap-to-expensive checks. `npm run test:node -- session store` selects those Node suites; full `npm run test:node` is broader. Read each specialized campaign's setup and evidence contract before execution. Commands are continuation instructions, not evidence they ran during this handoff.

Fresh consolidation checks: pinned-toolchain `npm run typecheck`, `npm run verify:vendor`, `npm run build` (consumer, app, server), and deterministic `node tooling/theme/spectrum.mjs` reproduction. Logs and the final validation record are under `docs/handoff/20260930/`. The existing install was reused; no clean-install qualification, unit campaign, browser/native/GPU run, provider call, CI, Docker or full product acceptance is claimed. The known fixture EOF warning and one whitespace line in the verbatim Vite log remain in the final diff check. No base-SHA CI run/link exists.

## Portable report and evidence

The independent report remains at **http://127.0.0.1:4381/**, owned outside the app runtime in `/Users/westbrook/Documents/repos/ideogram-edit-progress-report`. The locator is `.progress-report/project.json`; the [portable export record](handoff/20260930/report-export.json) binds the [report archive](handoff/20260930/progress-report.tar.gz) and its hashes. Extract it into a separate sibling directory, read its `RESTART.md`, and run `python3 verify-export.py`. Open the extracted `index.html` offline; the independent copied report can run with `python3 report.py start --port 4382`. Do not replace the live 4381 server. The report preserves weighted progress, burndown history, feedback and version-specific review checkpoints. Reading or importing it does not accept any work.

Package indexes copied under `docs/handoff/20260930/` are portable; the raw browser traces, screenshots, private profiles, archives and diagnostic roots are **not** all copied into Git. `evidence-index.json` names originals and hashes so the next harness can locate/copy them without rerunning qualification. A different machine must transfer the required evidence roots separately before claiming evidence review. Keep originals; archive tooling is copy-only.

The remaining user requests are usable real Fal integration/manual testing and continued use of suitable public En Reve controls, plus the open A-R01 feedback. Canonical report feedback governs exact resolution state; do not reopen resolved historical feedback or infer user review. The early-preview notification hook was cancelled and must not be recreated without renewed authorization. Manual testing, a key, paid-call approval and feedback do not block independent work whose actual prerequisites are met.

Next owner: read this handoff and report export, verify main and evidence identities, then plan bounded continuation of P2.5 outcome disposition and integrated Spectrum validation. Do not restart consumed campaigns by default. Continue P2.6–P2.8/P3 and usable-Fal work according to the project plan, without labelling this consolidation as acceptance.
