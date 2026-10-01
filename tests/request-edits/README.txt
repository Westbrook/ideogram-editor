P2.6 / E3 public request-edit assembly

Use the pinned Node 26.10.0 / npm 12.1.0 toolchain in tooling/README.txt.
The application and server builds must be current before running this target.

  npm exec -- tsc --noEmit -p tests/request-edits/tsconfig.json
  EDITOR_RECEIPT=artifacts/p26-request-edits EDITOR_BROWSER=chromium npm exec -- playwright test --config tests/request-edits/playwright.config.ts

The same config accepts firefox and webkit using the repository's pinned
Playwright browsers. It owns an isolated context and uses a persistent profile
for WebKit, matching the editor's OPFS fixture requirements. Generated source
PNGs, private storage and profiles are test-owned and covered by the shared
verified archive/cleanup lifecycle. Receipts remain under ignored artifacts/.

The provider is tests/request-edits/observer-fixture.mjs, injected only into the
test writer. It accepts one explicit inpaint route at literal 127.0.0.1, uses the
real QueueDispatcher and ResultObserver, and retains source and mask upload
hashes. The inherited no-egress preload rejects external connections. The
fixture supplies a deterministic opaque 512 x 512 blue PNG; there are no paid
provider calls and this target does not qualify production dispatch.

The browser exercises real editor controls and reads public protocol state.
Retained canonical RGBA and R16 files are read only after public asset/plan
identities identify them. Exact outside-mask equality is checked for every
pixel, including the flattened native overlay. The half-opacity source
exercises capture and replacement without applying layer opacity twice.
Fixture reports retain command/request observations, upload identities,
pixel digests, zero-coverage counts, browser pin and physical close receipts.
