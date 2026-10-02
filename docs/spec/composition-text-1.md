# COMPOSITION-TEXT-1 — explicit local Composition text export

This additive local contract records the explicit Composition-to-plain-text operation for V45. It preserves the frozen V45-A1 and schema18 contracts. The contract itself supplies no provider, resource, quality, live-admission or safety qualification credit.

## Local behavior

An explicitly selected v4.5 generation or edit draft can preview a deterministic plain-language brief from the current applied Composition. Export requires the existing `caption-json-1` local projection approval to match the complete current source: frame, request, included/excluded elements, linked layer versions, binding map, projected/clipped/omitted boxes and source-caption bytes. That approval is used only as the application's local source review; it does not become a v4.5 model contract.

The brief includes scene, background, authored style and palette, included elements in reviewed order, exact quoted visible text, and explicitly labeled normalized layout hints. It preserves clipping, approximation and omission disclosures. Excluded content does not enter the brief. No truncated brief is accepted: output must fit the existing 10,000-Unicode-scalar v4.5 prompt limit. The preview separately discloses excluded-element count and source frame, and says that output size is reviewed separately and placement is a hint.

Only explicit confirmation applies the exact displayed brief to the selected draft, as `mode: plain`. No hidden operation switch, submission, upload or provider call occurs. Request/document/session/source identity and generation fences reject stale previews. An attached brief is read-only; explicit detachment preserves the exact text while removing the active source association. Previous accepted records retain their original provenance. V4 authored Composition and ordinary v4.5 plain/raw drafts retain their existing behavior.

## Provenance and validation

`CompositionTextReview` has the exact fields `serializer: composition-text-1`, `sourceId`, `sourceProjection`, and `prompt`. Its source projection remains the original exact `caption-json-1` `ProjectionReview`; the separate `CompositionRef` retains the source graph and binding identities. The output reference binds exact UTF-8 bytes. Shape validation alone is insufficient: current writer paths recompute the export against current layers/bindings; historical and portable paths recompute against immutable last-reviewed values. Historical verification grants no current-layer or production authority.

Durable roots include the graph, its raw retained leaves, original source-caption bytes and exported brief. Portable handling reads a known Composition graph under its existing 1 MiB bound instead of broadening the generic 64 KiB metadata reader. Copy/import and text-treatment provenance verify both source and output identities. Text treatment uses the distinct local `composition-text` mode to retain semantic IDs/exclusions and export identity; the provider wire prompt remains plain text.

Generation prompt expansion and edit instruction preparation keep their existing visible settings and disclosures. This export makes no text-fidelity, coordinate-interpretation, safety or model-quality guarantee. Immutable request review, dispatch, privacy, result admission and production gates remain required and unchanged.

## Storage and portable capability boundary

Persisted `composition-text-1` provenance is introduced by storage schema19 and the `composition-text-export-v1` capability. The schema19 capability manifest links the exact frozen schema18 capability hash and keeps projection9 and asset projection3. The authentic schema17 executable identity and schema18 capability receipt are unchanged.

Opening an existing schema1–18 root requires the actual independently restored schema18 executable packet to be installed under that root's fixed `rollback-executables/<packetId>` location. The application does not obtain migration authority from an environment variable or a source commit hash. Before19 activation it preserves an exact schema18 SQLite backup, independent mutable files, the compatible executable closure, and all retained earlier rollback database/manifest/directory files. A restored18 root must retain its original canonical path and use the recorded executable. Fresh stores do not invent a prior backup.

Complete portable format12 carries this new persisted subtype. Ordinary records can retain the existing lower complete format where their actual feature closure permits it; sanitized recovery remains format11. A lower-format archive containing typed Composition text provenance is invalid. Format12 does not declare support in prior18 readers, and direct V45 structured-JSON Composition is still gated separately.

## Provider evidence boundary

The available endpoint-specific research in `artifacts/v45-staging/research/` and V45-A1 provides a string prompt contract. The official edit page, <https://fal.ai/models/ideogram/v4.5/edit>, describes prompt-driven edits and references; it does not establish the V4 caption JSON schema as a v4.5 structured-caption contract. During this follow-up, direct retrieval of the model `llms.txt`, edit `llms.txt`, OpenAPI/API pages and Ideogram 4.5 page was unavailable through the documentation tool. This is a bounded evidence statement, not proof that no other provider documentation exists. The V4 prompting guide is not transferable evidence.

Direct authored `mode: composition` remains refused for v4.5. To qualify such a mode, retain endpoint-specific primary documentation or a provider-confirmed versioned contract covering the exact schema, supported keys, element order, coordinate units, projection/clipping interpretation, visible-text semantics and interaction with generation expansion and edit instruction rewriting. Then independently qualify the serializer, fidelity/control behavior, endpoint and provider profile. Raw JSON remains opaque raw input. A local plain-language export neither supplies nor bypasses that missing evidence.

## Verification boundary

Verification covers the pure exporter, request-family parsing and wire preparation, UI ownership and input fences, durable writer validation, portable replay and text-treatment coupling. The source reviewer must inspect exact bases and diffs before the coordinated pinned-toolchain gates run with existing network preloads. Migration additionally requires the genuine schema18 capture/restore receipt and actual18→19→retained18 rollback evidence. Authored tests and this contract provide no passing-test or provider-qualification credit; exact retained execution receipts record those outcomes.
