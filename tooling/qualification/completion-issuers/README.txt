Completion issuer and native artifact adoption
=============================================

This producer replaces the historical fixed CSS path and minifier-offset map
with a closed current-source/current-build inventory. It does not grant a
browser, native-execution, CSP, completion, or product qualification result.

Use the pinned Node 26.10.0 / npm 12.1.0 toolchain from tooling/README.txt.
After all app source edits settle, run the authorized build:

  npm run build:app

For a normal source-sealed qualification run, call the exported
prepareCompletionIssuers(freshOutput, root) after the app build. Pass its env
object (COMPLETION_APPLICATION_IDENTITY and COMPLETION_ISSUER_MANIFEST) to the
completion-input capture and every completion Node/browser subprocess. This
prepares exact per-run files in the ignored output only, without source mutation.
Explicit paths never fall back when missing or invalid.

For maintenance outside a source-sealed run, create a fresh receipt and
explicitly adopt its reviewed source contract:

  node tooling/qualification/completion-issuers/index.mjs --output artifacts/completion-issuers-<unique-run> --adopt

The command checks the build-start source seal against current bytes, the pinned
toolchain, exact generated-output hashes, the sealed CanvasKit profile, and the
unchanged independently reviewed direct-network source boundaries. It walks the
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
