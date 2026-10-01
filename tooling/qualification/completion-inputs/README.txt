Completion helper preparation

The protocol ownership equivalence test compares the current implementation
with a retained pre-optimization monitor. protocol-old-monitor.mjs is the exact
21,312-byte historical input with SHA-256
048e61f51f7dd38d0317fdf8009f38157111afb91512509745ce85fc3999423a.
It is read as data; do not execute it or replace it with the current monitor.
provenance.json records its original path, retained copy, and sealed mapping.

capture-producer.mjs preserves the original producer bytes. It loads the current
host-final-page.mjs with the pinned Playwright ESM loader, normalizes the full
installer, evaluates it using the pinned UtilityScript in a Node VM, and records
the registered pagehide callback. --verify performs this in two separate Node
processes and compares both captures to the immutable host-handler-artifact.mjs.
It never launches a browser. Native methods in the VM are simulated, and this
preparation does not prove trusted events or browser behavior. Do not invoke the
producer's historical --generate mode as part of qualification.

The public API is:
  import {prepareCompletionInputs} from './completion-inputs/index.mjs';
  const environment = await prepareCompletionInputs(freshOutput, sourceRoot,
    {abortSignal, timeoutMs: 60000, env: approvedEnvironment});

Use Node 26.10.0 and the npm-ci-installed pinned Playwright 1.63.0 dependency.
sourceRoot may be an ordinary source snapshot without .git. freshOutput must not
exist; its parent is created if necessary. The function returns absolute
PROTOCOL_OLD_MONITOR and HOST_HANDLER_CAPTURE paths, both under freshOutput.
Pass those values and a separate EDITOR_RECEIPT directory to the helper tests.
Keep outputs in ignored receipt directories. Preparation preserves existing
NODE_OPTIONS preloads and adds the repository's no-network preload to all capture
children. Configured Playwright source transforms are rejected.
When the caller supplies COMPLETION_APPLICATION_IDENTITY and
COMPLETION_ISSUER_MANIFEST, both must be absolute file paths. Preparation checks
that the issuer manifest binds to that application identity, forwards both paths
to every capture process, and retains and rechecks their exact input hashes.
Supplying only one identity input is an error; explicit inputs never fall back
to the adopted repository identities.
The optional third argument passes the caller's cancellation signal, remaining
deadline, and approved environment. Capture uses the qualification runner's
boundedChild process-group cleanup, including the producer's descendants. When
no signal is supplied, temporary SIGINT/SIGTERM listeners abort that owned group.

Each invocation retains preparation.json, exact copied historical input, capture
logs, both fresh captures, transformed source, source maps, and isolated caches.
The preparation receipt records actual input/output hashes and elapsed time.
Failures remain available for inspection; a prior capture is never substituted.

The protocol helper suite imports current dist/local canonical/font modules via
the completion monitor, so its caller must build the server before running that
suite. The capture producer itself needs no server build or browser installation.
Neither this preparation nor a passing helper suite updates the separate source
issuer inventory or emitted worker/build identity seals.
