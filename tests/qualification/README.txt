Accessibility browser qualification
===================================

Build dist/app and dist/local with the pinned toolchain after the required
cheaper gates. The coordinator runs these targets serially; fixtures create
their own loopback service, disposable private root and isolated browser/OPFS
ownership. They never configure a live provider credential.

Use a fresh ignored output directory for every attempt. Preserve the first
failure. A later pass is not permission to overwrite its evidence.

QUALIFICATION_BROWSER=chromium QUALIFICATION_A11Y_OUTPUT=artifacts/ax-keyboard-<run> npm exec -- playwright test --config tests/qualification/a11y.config.ts
QUALIFICATION_BROWSER=chromium QUALIFICATION_COARSE_POINTER=1 QUALIFICATION_A11Y_OUTPUT=artifacts/ax-coarse-<run> npm exec -- playwright test --config tests/qualification/a11y.config.ts
QUALIFICATION_BROWSER=chromium QUALIFICATION_AXE_OUTPUT=artifacts/ax-axe-<run> npm exec -- playwright test --config tests/qualification/axe.config.ts

Repeat affected functional targets with QUALIFICATION_BROWSER=firefox and
webkit. The configured engine is launched through Playwright's public APIs;
WebKit uses an owned persistent profile plus verified native OPFS cleanup.
Coarse-pointer qualification uses the context's actual hasTouch capability,
not a matchMedia replacement. Verify the recorded media values for each engine.

AX01 sources:
- axe.spec.ts scans shell themes, dialogs, conflicts, immutable request review,
  local adapter controls, text/glyph error, composition errors, conversion,
  layer mask/masked review and narrow forms.
- axe-populated.spec.ts uses actual accepted requests and a controlled loopback
  provider for queued/running/failed/completed/cancelled jobs, retained results,
  candidate adoption, recovery and live-region observations.
- axe-recovery.spec.ts renames one real exact font object in its owned fixture,
  scans missing-font preview and full-history copy failure, then uses the real
  exact-relink upload/import action and prepares a complete copy successfully.
  The held original survives failures and is restored before service shutdown.

AX02–AX08 keyboard/reflow/focus/input checks live in a11y.spec.ts. Populated
adapter pagination also runs in tests/adapters/browser.spec.ts, case
"adapter library pagination supports keyboard return, stable focus and retained
filtered drafts", through tests/adapters/browser.config.ts and ADAPTER_OUTPUT.
Its fixture imports real immutable versions and crosses a backend page boundary.

AX09 observations are collected from actual open-shadow live regions and the
normal request/job lifecycle in axe-populated.spec.ts. They record DOM messages,
timing and focus; DOM mutation counts are not evidence of spoken AT behavior.

The pinned axe engine is 4.13.0. Whole-document scans have no panel exclusions,
disabled rules or severity waivers. Every result retains violations, passes,
inapplicable rules, incompletes, accessible snapshots and the engine digest.
Every incomplete remains an explicit manual-review item. coverage.json keeps
ax01Complete=false because automated green cannot complete that adjudication.

Physical browser zoom, actual VoiceOver/NVDA speech, native IME/dictation and
OS destination-picker behavior require their own receipts. A 720 CSS-pixel
viewport models the available CSS space of a 1440px view at 200%; it is not a
claim to have changed physical browser zoom. Training UI states are separately
deferred P4 scope; adapter import/library controls are not training evidence.
