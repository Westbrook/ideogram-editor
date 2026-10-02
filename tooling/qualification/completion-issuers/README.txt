Completion issuer and native artifact adoption
=============================================

This producer replaces the historical fixed CSS path and minifier-offset map
with a closed current-source/current-build inventory. It does not grant a
browser, native-execution, CSP, completion, or product qualification result.

Use the pinned Node 26.10.0 / npm 12.1.0 toolchain from tooling/README.txt.
After all app source edits settle, run the authorized build:

  npm run build:app

For a normal source-sealed qualification run with a live evidence monitor, call
prepareCompletionIssuersChild(freshOutput, root, {env, abortSignal, timeoutMs})
from prepare-child.mjs after the app build. This uses the unchanged non-adopting
producer CLI in one bounded child so synchronous source/AST work cannot block the
parent observer. It retains the child log/outcome, checks its exact output receipt,
and rejects failure, timeout or interruption before publishing paths. Existing
campaign/container command owners may run the same CLI under their bounded child
and validate the prepared outputs. No evidence window, gap or capacity changes.
Pass the returned env
object (COMPLETION_APPLICATION_IDENTITY and COMPLETION_ISSUER_MANIFEST) to the
completion-input capture and every completion Node/browser subprocess. This
prepares exact per-run files in the ignored output only, without source mutation.
Explicit paths never fall back when missing or invalid.

For maintenance outside a source-sealed run, create a fresh receipt and
explicitly adopt its reviewed source contract:

  node tooling/qualification/completion-issuers/index.mjs --output artifacts/completion-issuers-<unique-run> --adopt

The command checks the build-start source seal against current bytes, the pinned
toolchain, exact generated-output hashes, the sealed CanvasKit profile, and the
independently reviewed network and response-ownership source boundaries. It walks the
current test import closure, inventories every emitted file, resolves HTML/CSS
and module edges, and partitions every direct networking call. Unknown calls,
changed network boundaries, new bodyful or keepalive sites, unclosed assets and
stale output fail. Worker fallbacks are checked structurally; no offset or
minifier-local variable name grants a classification.

The explicit --adopt writes tests/editor/completion/application-identity.json
and host-final-issuers.json. Without --adopt, only prepared per-run files and a receipt
are retained in the fresh output directory. The application identity has no
runtime discovery fallback: completion helpers require the explicitly selected per-run file or the adopted
checked-in default.
After adoption, run prepareCompletionInputs from ../completion-inputs/index.mjs
and the completion Node/browser gates. A later source or build change requires
a fresh build and receipt; an observer-only change requires a fresh issuer
receipt. Never overwrite or reuse the fresh output directory.

Historical boundaries
---------------------

historical/mode495-issuers.mjs is the byte-exact original full inventory
producer from:
  ideogram-edit-p1c6-20260927T201600Z/helpers/mode495-issuers.mjs
SHA256 12e8c1bf06d156604c5a78991e635af8e60b8a6e32e3275e04a6404910737dbb

historical/host-final-issuers.json is the previously adopted repository
inventory before this implementation continuation.
SHA256 717d24791050803d497fadd11f71a91f776c7751bcde506f77121b761a965c0b

These are retained as historical evidence only. Their old hashes, counts and
claims are never substituted for current source or output. The new receipt
seals the adapted producer, current identity/manifest, source network review
boundaries and current classifications. It does not inherit prior pass results.

Final assembled source review
-----------------------------

Before changing NETWORK_BOUNDARIES, independently compare the final assembled
source against its prior reviewed bytes. Include the session fetch adapter and
its method/header/body/signal setup, local command and draft deliveries, recovery
release URLs, CSRF, original response readers, and native cleanup failure owners.
The session adapter accepts exactly an identifier URL and an identifier init
spread first, followed by fixed same-origin, no-store and redirect-error policy.
Its source-pinned ownership helpers establish the delegated request and reader
contract. The obsolete direct session shape is not a second accepted variant.

Retain an immutable source-review receipt with exact original/final inputs and
reviewed diffs. Update the classifier's fixed boundary assertion with those
reviewed final bytes, retaining unchanged pins. Prepare a fresh enclosing issuer
manifest after the current typecheck/build, including the current imported
original-recovery-reader.ts and completion/sse-publication.mjs helpers. A changed
helper or source input needs a fresh receipt; do not relabel historical issuer
manifests, prior gate receipts, or native/browser artifacts as current evidence.
The nine-fetch/three-XHR partition remains a strict emitted-build assertion;
source review alone does not establish that the final build meets it.
