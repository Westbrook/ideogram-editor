# Goal

Produce a reviewable technical specification for a Photoshop-like, browser-based image editor built primarily on the Ideogram V4 model family hosted on fal.ai, using the en-reve design system — covering API surface, feature mapping, event-sourced architecture, design-system integration, testing strategy, and performance budgets. The deliverable is specification documents in workspace notes and repository docs/spec/, not application implementation code.

## Grounding findings and confirmed scope (2026-09-25)

- The initial verified V4 starting set was `ideogram/v4`, `ideogram/v4/image-to-image`, `ideogram/v4/inpaint`, `ideogram/v4/instant`, `ideogram/v4/lora`, and `ideogram/v4/trainer`. The base endpoint is text-to-image; the family includes editing and training. This is a verified set, not an exhaustive catalog claim.
- Build the editor around this V4 generation. Related Ideogram/Fal models are researched to establish shared abstractions and capability differences, not assumed to be the default editing backend.
- V4 endpoints share concepts but differ in defaults, enums, size rules and supported input combinations. Inputs and outputs require endpoint-specific validation; inference outputs include the actual prompt as well as images, seed, timings and safety flags.
- Include LoRA inference and the training-to-inference lifecycle in the specification. Training implementation has lower priority than core generation and editing.
- Use a localhost backend that reads FAL_KEY from a server-side environment variable, with a stable deployment-secret injection boundary. Keep credentials out of browser code and persisted events.
- Deliver independently reviewable workspace notes plus repository documentation under docs/spec/.
- The design system is en-reve at /Users/westbrook/Documents/repos/design-system: Lit custom elements, Signals-based primitives, token-driven styles and existing browser/testing conventions. Audit current public contracts before adopting them.

The earlier conclusion that V4 editing must use V3 was incorrect and is superseded by this scope and the user’s clarification.

# Tasks

- [x] [Task 1 — API surface reference](intent://local/task/d3202a13-080b-426e-8bac-c2a25ee2ae49)

- [x] [Task 2 — Design-system integration plan](intent://local/task/6e3a136c-c367-4007-a141-7eb82c5f6a0f)

- [x] [Task 3 — Editor UX and feature plan](intent://local/task/308a3de1-3a1e-4ead-9b75-618d778e80ff)

- [x] [Task 4 — Architecture: action model and event log](intent://local/task/bc1f99ee-c43d-470b-8111-e478000dafe5)

- [x] [Task 5 — Testing strategy](intent://local/task/060d9fce-0132-4c2e-b066-9e8883a8e1a0)

- [x] [Task 6 — Performance requirements and metrics](intent://local/task/8a596346-7cd0-49db-9a5b-a81cfc239db0)

- [/] [Task 7 — Assemble and reconcile the specification](intent://local/task/475e1f5c-0697-46e9-b205-decbb4297f00)

# Acceptance Criteria

- REQ-API: Every in-scope endpoint has dated schema evidence for all request/response fields and endpoint-specific differences. Official protocol documentation supports queue/auth/storage/limits claims. Source conflicts and unverified runtime behavior remain explicit.
- REQ-CAP: Every kickoff capability has a direct/composed-candidate/comparison-only/unsupported/deferred disposition. Every field maps to a user control, visible outcome, provenance or justified internal policy.
- REQ-OPS: Implement the [accepted operation compatibility v1](intent://local/upon-build/note/6df7045b-6f0a-42c5-a32d-879b38d54c51): explicit operation and attached inputs determine eligible endpoints; conflicts preserve drafts; no silent context loss, resizing, parameter downgrade or older-model fallback; submitted inputs are frozen.
- REQ-UX: Specify document creation/import/save/reopen/export, layer/source/mask semantics, result adoption and failure recovery with annotated states and practical accessible interactions. Set explicit Photoshop-parity boundaries.
- REQ-STATE: Define document/raster/asset/job/adapter contracts, action/event authority and recording granularity, durable acceptance, projections, undo/redo, migration and recovery. Replay makes zero provider calls; late or stale results never silently overwrite the current document.
- REQ-DS: Ground en-reve usage in current public contracts and behavioral evidence, including tentative component events and authoritative application state. Specify reproducible cross-repository consumption and app-owned gaps/testing commands.
- REQ-TEST: Preserve consumer-focused unit > integration > e2e priority. Assign behavior owners, permit justified complementary layers, prefer real browser/local integration, and prohibit coverage-only or brittle snapshot/string-only proof. Define automated and manual accessibility evidence.
- REQ-PERF: Establish numerical runtime and developer-lifecycle budgets before UX/architecture drafting. Each has workload, environment, percentile/sample policy, target/ceiling, owner, instrumentation, trend retention and regression response. Separate app gates from variable provider observations.
- REQ-TRAIN: Fully specify dataset/caption preparation, training parameters, recovery, weights/config retention and adapter inference use while keeping training implementation lower priority.
- REQ-LOCAL: Specify browser/local backend/fal boundaries, server-only FAL_KEY environment loading, deployment-secret injection, upload staging and durable polling/reconciliation without requiring hosted webhooks.
- REQ-DOCS: Deliver six independently reviewable section notes plus an index and matching docs/spec/ files with portable links, named revisions, requirement traceability and an owned open-decision register. Fix contradictions in source sections; document existence alone is insufficient.

# Non-goals

- No implementation code, scaffolding, or dependency installation in `ideogram-edit`.
- No changes to the design-system repository.
- No visual design system of its own — en-reve tokens and components are the source of truth.
- No collaboration/multi-user, billing, or account-management design.
- No execution of paid inference or training as part of specification research. LoRA training workflows are in scope for specification, with lower implementation priority.

# Assumptions

- Confirmed: deliver workspace notes plus repository documentation under docs/spec/.
- Confirmed: localhost backend reads FAL_KEY from its environment; deployment secret injection should preserve the same boundary.
- Confirmed: V4-family generation/editing is primary, including LoRA inference and lower-priority training.
- Confirmed: the new ideogram-edit application consumes immutable versioned en-reve package archives stored in its repository, with coherent dependency identities and preserved source provenance. Browser rendering is the initial approach; SSR is optional and measurement-driven.
- No live fal API calls with real credentials are made while writing the spec; research is schema-driven.

# Verification Plan

- Audit every in-scope endpoint and field against captured schemas; use official protocol references for transport claims and identify future opt-in runtime checks.
- Trace every kickoff requirement and accepted compatibility row across API, UX, architecture, tests, performance and implementation phase.
- Verify design-system claims against public exports, current implementation and behavioral evidence; do not equate a plan or filename with a working capability.
- Walk document/raster coordinate handling and state transitions through inpaint/undo, cancel races, stale/deleted targets, duplicate completion, uncertain submission, browser/server restart, save/reopen, zero-call replay, asset expiry and offline training completion.
- Check each performance budget's reproducible workload/environment, measurement and enforcement; future tests and measurements remain planned, not reported as passed.
- Reconcile UX and architecture before testing handoff; independently verify each drafting wave and the final assembled notes/repo documents.
- Validate all note/doc links, semantic mirror parity and remaining decision ownership. Confirm verified tasks become complete rather than remaining review_required.

# Drafting Order and Review Checkpoints

1. Foundation: Tasks 1 and 2 establish API evidence and actual design-system contracts.
2. Early constraints: Task 6 uses foundation results to set quantified budgets and explicit workload assumptions before UX/architecture.
3. Design: Tasks 3 and 4 draft against those shared inputs. Reconcile operation, document/raster and command/event contracts together before Task 5 begins; record that checkpoint in this Spec.
4. Verification strategy: Task 5 maps consumer-observable tests and accessibility/performance evidence to the reconciled design.
5. Assembly: Task 7 refines cross-section assumptions, including Task 6 budgets, at their source; creates portable repo mirrors and completes final independent verification.

Existing task IDs are retained. Hard dependency links enforce this ordering; the joint UX/architecture checkpoint is a coordinator verification gate in addition to dependency completion. Task 6 supplies a complete early performance section; Task 7 reconciles later design refinements without introducing a dependency cycle. Delegation follows the established shared PR Context and verifier workflow when drafting is started.

# Rollback Plan

For documentation revisions, restore matching source-note and repository-document versions and keep the decision/task history. The future application specification must define event/asset/schema migration recovery; no application changes are made during this planning revision.

## Specification review — 2026-09-25

The strict review is complete: [Review findings and checkpoint](intent://local/upon-build/note/b6884312-45fe-4295-a5a3-70180a701223). It records twenty findings, evidence, proposed replacement acceptance criteria and ownership by existing task. The user accepted operation compatibility v1 on 2026-09-25 and requested task revisions. All seven existing briefs, the acceptance criteria, verification plan and dependency order now incorporate the compatibility contract and review requirements. This resolves the planning omissions; it does not establish that the future section deliverables satisfy them. No technical section is complete and no application implementation has begun.

## Accepted operation policy — 2026-09-25

[Operation compatibility v1](intent://local/upon-build/note/6df7045b-6f0a-42c5-a32d-879b38d54c51) is the accepted routing contract. User operation plus explicit attachments selects compatible endpoints. Preserve incompatible drafts and require explicit resolution; freeze request inputs at submission. Outpainting remains an unvalidated composed candidate; upscaling remains a gap in the verified V4 set; a staged LoRA-generation-then-edit workflow remains a separate proposal. Do not present any of these as directly supported or silently substitute an adjacent model. Training is fully specified now and implemented later. Adoption is not authorization for paid API calls or deployment.

## Foundation drafting — started 2026-09-25

The user authorized Tasks 1 and 2 to draft the API reference and design-system integration sections in parallel. Shared context: [PR Context — upon-build](intent://local/upon-build/note/337dd04c-2911-4227-8217-1e2fc0b6a9f0). Each agent owns its section note and existing task note; the coordinator reconciles both after an independent verifier pass. Later tasks remain queued. No application implementation, paid API calls or PR creation is included.

## Expanded V4 evidence — foundation discovery

Task 1 catalog discovery found additional V4 routes. Coordinator independently verified image-to-image/lora, inpaint/lora, tiling, tiling/lora and fast schemas. Source+LoRA and source+mask+LoRA are supported by dedicated single-call endpoints; the original six-endpoint compatibility gap is superseded in the [accepted operation policy evidence addendum](intent://local/upon-build/note/6df7045b-6f0a-42c5-a32d-879b38d54c51). Full-family discovery was already in scope. The routing principles remain accepted; Fast/tiling/streaming semantics require completion of the API reference. No paid calls or additional implementation scope was authorized. Any staged LoRA editing proposal is optional, not a workaround required by these capabilities.

## Foundation draft available — DS-1.1

[Design System Integration — en-reve](intent://local/upon-build/note/bf7b9cc0-391c-4fce-97a8-5da1a660a4a2) is drafted as DS-1.1 and awaiting independent verification. It incorporates the expanded API evidence. Main review points: tentative component events versus application authority; private-package reproducibility; app-owned raster/layer/accessibility gaps. The audit describes a changing, uncommitted design-system working tree, with explicit source digests; its git commit alone is insufficient provenance. No builds, installs, app benchmarks or behavioral test runs are claimed. Task 1 remains active; joint foundation verification starts after its final handoff.

## Foundation verification — API-1.1 and DS-1.1

Both authorized section drafts are ready: [API Surface — Ideogram V4](intent://local/upon-build/note/2728dafd-4209-4558-a762-3a0192e0610f), API-1.1, and [Design System Integration — en-reve](intent://local/upon-build/note/bf7b9cc0-391c-4fce-97a8-5da1a660a4a2), DS-1.1. Both tasks are review_required pending independent verification. Review uses [shared PR Context](intent://local/upon-build/note/337dd04c-2911-4227-8217-1e2fc0b6a9f0) and the corrected provider-evidence addendum; earlier API-1 pending-LoRA-hold language is superseded by API-1.1. Scope: full documented API surface and protocol limitations; current en-reve contracts and source reproducibility; consumer-focused evidence and Task 6 handoff. No paid calls, repo changes or downstream drafting begins during verification.

## Foundation verification complete — 2026-09-25

API-1.1 and DS-1.1 passed independent verification, including cross-section consistency, with no blocking findings. [Verification report](intent://local/upon-build/note/99dd9c46-10a3-404d-b4b7-458c2c34758d). Coordinator confirmed both original task notes are complete. Approval covers specification readiness only; provider runtime, packaging/install, browser/IME/AT and actual editor performance remain future qualification. Five drafting tasks remain. Current user-directed work is discussing open questions one at a time; U02 image-sizing behavior is awaiting the user’s answer. Task 6 is unblocked but has not been started.

## Decision — image sizing (U02)

User selected “Offer a previewed resize” on 2026-09-25. When requested dimensions fall outside the verified range for the selected operation, preserve the original document and propose a request-size change with a preview for explicit approval before submission. Do not silently resize or present the resize as proof of provider support. Task 3 specifies the preview/approval and result-placement UX; Task 4 records original/request dimensions and transforms with frozen source/mask inputs; Task 5 verifies preservation and explicit approval; Task 6 accounts for resampling and memory. Provider sizing limits, presets and auto rounding remain open evidence questions.

## Decision — queued results first (U03)

User selected “Queued results first” on 2026-09-25. Initial editor generation uses durable queued jobs with status updates and finished results. Progressive image previews are deferred until stream event formats, recovery behavior and pricing are verified. Queue status streaming is distinct from progressive image previews; ordinary polling/status updates remain available. Task 3 designs honest job feedback; Task 4 specifies durable queue reconciliation; Tasks 5/6 cover queue behavior and latency phases. The full API reference retains stream routes and their unknowns, with deferred UI adoption rather than omission.

## Decision — uncertain submission recovery (U04)

User selected “Check, then ask before retrying” on 2026-09-25. If submission acknowledgement is lost, attempt to reconcile the original job using persisted identifiers and available provider evidence. If acceptance remains unknown, retain an explicit uncertain state, explain possible duplicate work/charges, and require the user to initiate a new attempt. Do not automatically resubmit an uncertain paid request. Keep this distinct from polling an existing job, known safe transport retries and documented provider retry behavior. Tasks 3/4 define recovery UX and durable attempt identity; Task 5 tests lost acknowledgement and duplicate-risk handling. Published queue protocol/schema discrepancies remain technical verification work.

## Decision — guided training datasets (U05)

User selected “Guided dataset builder” on 2026-09-25. When lower-priority LoRA training is implemented, users select images, review/edit captions and crop previews, then the editor validates and packages a versioned dataset for submission. Preserve original assets and record captions, crop choices and archive identity. Prepared ZIP import is not part of this selected initial training workflow. Tasks 3/4 specify the builder and dataset provenance; Task 5 covers preparation/validation; Task 6 budgets archive preparation/upload. Actual provider archive/image/caption limits and adapter-format compatibility remain verification questions; do not label app limits as provider requirements.

## Decision — image layers first (U06)

User selected “Image layers first” on 2026-09-25. Initial generated results are raster image layers that users can move, mask and combine. Preserve alpha when present in returned assets, but do not promise transparent generation, separately editable generated text, or provider-generated structured layers. The editor owns its layer/document model independently of provider output structure. Add advanced provider-output capabilities only after verification and explicit feature planning. Tasks 3/4 specify non-destructive raster adoption and alpha handling; Task 5 checks compositing/preservation. Provider transparency/layer claims remain unresolved evidence, not product guarantees.

## Decision — clearly labeled cost estimates (U07)

User selected “Clearly labeled estimates” on 2026-09-25. Show estimated costs only where documented rates support the calculation. Label estimates distinctly from confirmed charges, identify unknown fees/rounding/batch/cancellation effects, and show provider-reported actual charges only when available. Do not substitute a known subtotal for a guaranteed full total, interpret placeholder stream pricing as free usage, or invent an upper bound. Retain pricing source/retrieval identity and estimation assumptions with request provenance. Tasks 3/4 specify presentation and estimate/actual records; Task 5 checks uncertainty and missing-price behavior. Exact provider billing remains open verification; no spending is authorized by this decision.

## Decision — configurable parallel jobs (U08)

User selected “Configurable parallel jobs” on 2026-09-25. Start with one active generation request. Permit a higher configurable limit after account capacity and local resource limits are established, and queue excess requests locally. Active-request concurrency is separate from images per request. Tasks 3/4 specify queue controls, durable scheduling and backpressure; Task 5 tests ordering/recovery/concurrency bounds; Task 6 establishes resource budgets before enabling higher limits. Provider allocation, model identity, runtime guarantees and seed reproducibility remain unverified; retain generated assets rather than relying on regeneration.

## Decision — retain unused results (U09)

User selected “Keep until explicitly deleted” on 2026-09-25. Download generated candidates promptly into durable local project storage and retain unadopted results until explicit deletion; do not expire them automatically. Show storage usage and provide intentional cleanup controls. Protect assets referenced by documents, saved versions or undo history; cleanup must identify dependencies rather than silently breaking them. Tasks 3/4 specify library/cleanup UX, asset identity and reference-aware deletion; Task 5 tests restart/expiry and protected-reference behavior; Task 6 budgets storage accounting and disk-pressure feedback. Provider result/cache/media expiry remains separate and still requires verification.

## Decision — preserve pixels outside edit masks

User selected “Preserve outside the mask” on 2026-09-25. Enforce masked-edit preservation in the editor by compositing the generated region with the frozen original source. Preview any feathered transition; preserve pixels outside the effective mask and retain the original for non-destructive recovery. Do not rely on the provider to return unchanged unmasked pixels. Task 3 specifies mask/feather preview and acceptance; Task 4 defines coordinate mapping, resampling, alpha/color handling and the exact compositing/preservation invariant, including any approved request resize; Task 5 verifies preserved regions and boundary behavior with deterministic fixtures; Task 6 budgets compositing buffers and latency. Provider soft-mask/alpha/alignment behavior remains an independent verification question.

## Decision — trained adapters and V4 imports

User selected “Trained adapters and V4 imports” on 2026-09-25. The library accepts outputs from the editor’s training workflow and imported Ideogram V4 adapter weights, subject to compatibility checks and clear rejection/errors for unsupported files. Preserve immutable local adapter versions, hashes, source/provenance, declared model/format and selected scales/order; make adapter availability distinct from successful compatibility validation. Do not infer support for other model families or silently convert unsupported weights. Task 3 designs import/validation/library states; Task 4 specifies artifact identity and the checks before inference; Task 5 covers invalid/missing/incompatible adapters; Task 6 budgets import, storage and loading for supported adapter combinations. Imported-adapter inference need not depend on completing the lower-priority training workflow. Actual file limits, tensor-format compatibility, loading/caching costs and multi-adapter interaction semantics remain provider verification questions.

## Sequential policy decisions — completed

All ten sequential policy questions are answered. Adopt previewed resize with explicit approval; queued status and finished images first; recover uncertain submissions before an explicit retry; guided training datasets; raster image layers first; clearly labeled cost estimates; configurable concurrency starting at one; unused candidate retention until explicit deletion; editor-enforced preservation outside masks; and trained plus imported V4 adapters. Detailed decisions above are authoritative. These answers establish editor behavior; they do not resolve provider evidence gaps. API-1.1 and DS-1.1 retain their independent verification and unknown registers. The next drafting stage is Task 6 performance requirements; five drafting tasks remain unstarted.

## Decision — design-system package delivery

User selected versioned archives in the editor repository on 2026-09-25. Adopt the en-reve package delivery plan in DS-1.1: immutable, content-identified npm archives, relative file dependencies, a locked coherent package set, and preserved source/build provenance. No private registry or sibling checkout is required for consumer installation. Selecting and sealing the source snapshot, producing archives and proving a clean installation remain implementation qualification; this decision does not authorize implementation or claim those checks have passed.

## Decision — browser rendering first

User selected browser rendering first on 2026-09-25. Adopt DS-1.1’s initial client-rendered editor with a native HTML loading/error shell and token CSS before JavaScript. The local server still holds FAL_KEY and handles provider requests. Server rendering is optional future work, to be justified by startup measurements; it is not an initial delivery requirement. Task 6 budgets and measures this baseline; Tasks 3–5 specify usable loading/failure states, client initialization and browser verification. Both Task 2 preference questions are now answered: versioned en-reve archives and browser rendering first. Actual archive production, clean-install qualification, browser/IME/assistive-technology checks and performance measurement remain future engineering work.

## Performance drafting authorized — 2026-09-25

User authorized Task 6 performance requirements drafting. Use verified API-1.1 and DS-1.1, the corrected compatibility addendum and all accepted policies, including versioned en-reve archives and browser rendering first. Produce quantified proposed budgets and reproducible measurement/enforcement protocols for runtime and developer workflows; do not present targets as measured results. Independent verification follows this draft. Tasks 3–5 and 7 remain queued; no editor implementation or paid provider calls are authorized by this drafting step.

## Performance draft — independent review pending

[Performance Requirements and Metrics, PERF-1](intent://local/upon-build/note/1b7b659d-d577-4257-b677-4850bbf86143) is drafted. Task 6 remains review_required. Proposed runtime/developer budgets and qualification protocols are ready for independent review; no editor measurements or implementation are claimed. Review must check feasibility, consistent workload/sample inheritance and enforcement costs as well as coverage. Downstream drafting remains queued.

## Performance review — corrections required

PERF-1 was not approved in [independent review](intent://local/upon-build/note/bb86b142-0129-4293-b3c4-ebbb458490d7). Correct F01–F04 in the canonical performance section: distinguish bounded PR checks from full statistical campaigns and reconcile CI totals; define memory-growth cycle counts; make failed/censored timing outcomes deterministic; define cold/warm decode, mask-preservation preparation and adoption timing boundaries. These are specification corrections within the authorized task, not new product decisions. Task 6 remains review_required; the original author will revise it before independent re-review. No downstream drafting begins.

## Performance revision — PERF-2 re-review

[PERF-2](intent://local/upon-build/note/1b7b659d-d577-4257-b677-4850bbf86143) revises the four measurement definitions identified in PERF-1. Author receipts are paper checks, not independent approval or observed performance. Independent re-review will also assess whether the proposed eight-host paired CI graph is proportionate to the localhost-first project and whether a practical lower-capacity execution path is specified without weakening correctness or hiding required checks. No infrastructure purchase/provisioning is authorized. Task 6 remains review_required; downstream tasks remain queued.

## Performance re-review — remaining CI correction

PERF-2 review independently closed F02–F04. F01 remains: the mandatory eight-host schedule is disproportionate and incomplete. Revise the source with a practical limited-capacity baseline and honest longer feedback budgets; accelerated capacity is optional. Include baseline settling, adapter lifecycle cycles, full developer repetitions and queue/setup time in a consistent schedule. Define a justified minimal initial qualification matrix rather than making the full Cartesian campaign mandatory. Preserve all budget coverage and correctness rules; expanded campaigns may be explicitly optional. No hardware procurement or product-policy decision is required. Task 6 remains review_required pending correction and re-review.

## Performance revision — PERF-3 re-review

[PERF-3](intent://local/upon-build/note/1b7b659d-d577-4257-b677-4850bbf86143) proposes a one-build-runner/one-browser-runner default, optional acceleration, explicit lifecycle idle accounting and a finite initial qualification matrix. Longer feedback budgets replace the unsupported eight-minute default; these remain proposed and unmeasured. Independent re-review will check remaining F01, complete job/campaign accounting and preservation of resolved F02–F04. Task 6 remains review_required; no infrastructure or downstream work is authorized by this revision.

## Performance specification verified — PERF-3

Task 6 is complete; the coordinator confirmed its actual complete status after independent approval. Canonical deliverable: [Performance Requirements and Metrics — PERF-3](intent://local/upon-build/note/1b7b659d-d577-4257-b677-4850bbf86143). [Independent verification](intent://local/upon-build/note/bb86b142-0129-4293-b3c4-ebbb458490d7) approves all ten completion criteria with Medium confidence and closes F01–F04. This supersedes the earlier pending-review/correction statuses while preserving their history. The default CI profile uses one build runner and one browser runner; acceleration is optional, required work and total feedback are explicitly budgeted. Targets are proposed, not measured performance; provisioning, executable fixtures, package installation, browser qualification and actual measurements remain future work. No repository changes, app tests, benchmarks or paid calls occurred. Verified sections now include API-1.1, DS-1.1 and PERF-3. Tasks 3 and 4 have satisfied dependencies and are ready for the next authorized drafting wave; Tasks 5 and 7 remain dependent on that work. No downstream task is started by this completion.

## Accepted revision — web.dev alignment

User authorized the alignment improvements on 2026-09-25. Retain LCP 1.5/2.5s, INP 100/200ms and CLS 0.05/0.10 target/ceiling, with canonical field p75 across page visits distinguished from lab and smoke gates. Add application frame-work target/ceiling 8/10ms at 60Hz, separate from input-to-paint and dropped-frame measures; reconcile active-animation fallback slices accordingly. Require visible acknowledgement target/ceiling 50/100ms for discrete interactions and long-operation starts, while separately timing expensive completion. Layer/history updates, export, masked adoption, resize, imports/training and job/cancel actions must not defer initial feedback until completion or misrepresent acknowledgement as durable success. Preserve honest progress and independent continuous drawing/zoom/scroll measures. All values remain proposed; no measured compliance is claimed. Source guidance: [Web Vitals](https://web.dev/articles/vitals), [rendering performance](https://web.dev/articles/rendering-performance), [INP](https://web.dev/articles/inp); [RAIL](https://web.dev/articles/rail) supplies supplemental response context and is not the primary standard. Reopen Task 6 for a focused PERF revision and independent verification; PERF-3 approval remains historical. Other drafting stays queued.

## Web.dev alignment draft — PERF-4 review pending

[PERF-4](intent://local/upon-build/note/1b7b659d-d577-4257-b677-4850bbf86143) is drafted with unchanged Core Web Vitals thresholds, explicit field/lab distinctions, 8/10ms application frame work, 4/6ms active-animation fallback slices and 50/100ms initial visible acknowledgement separate from durable success and completion. The author reports preserved expensive-operation and CI budgets. These changes require independent review; prior PERF-3 approval does not approve PERF-4. Task 6 remains review_required and downstream tasks stay queued.

## Web.dev alignment complete — PERF-4 verified

The user-authorized revision is complete. [PERF-4 performance requirements](intent://local/upon-build/note/1b7b659d-d577-4257-b677-4850bbf86143) supersede PERF-3 as the current source. [Independent review](intent://local/upon-build/note/bb86b142-0129-4293-b3c4-ebbb458490d7) approved all ten Task 6 criteria and the alignment brief with Medium confidence; all prior findings remain closed. Coordinator confirmed Task 6 complete. Core Web Vitals values are unchanged; frame-work, active-fallback and initial-feedback budgets are explicit, with field/lab and acknowledgement/completion boundaries defined. Tasks 3–5 and 7 now reference PERF-4. Empirical runtime/field performance and instrumentation overhead remain future qualification. No implementation, benchmarks, installs, paid calls or repository edits were performed. UX and architecture drafting are ready but remain unstarted.

## UX and architecture drafting authorized — 2026-09-25

User authorized Tasks 3 and 4 together. Draft against API-1.1, DS-1.1 including accepted package/rendering choices, PERF-4, the corrected operation compatibility and all Spec policy decisions. Produce complete independently reviewable UX and architecture sections. Authors must reconcile operation routing, document/raster/mask semantics, layer/result placement, feedback versus durable acceptance, save/history/undo and async-job recovery before joint independent verification. Concrete app design choices may be proposed with rationale; provider unknowns stay explicit. Notes only in this wave; no editor implementation, paid calls or repo mirrors. Tasks 5 and 7 remain queued. Their start is not authorized by this wave.

## Editor layout preview — user review pending

User requested the proposed layout before the UX draft is finalized. [UX-1 draft](intent://local/upon-build/note/3febb57d-ea57-42de-a098-b12fb4e010e4) defines document bar, tool rail, central canvas/tool options, layer/properties panel, operation/request panel, bottom results/jobs/history and status. Coordinator is presenting a provisional desktop arrangement with request controls left of canvas and layers/properties right; exact sizing and responsive behavior remain provisional. Reading the preview is not acceptance. UX author should keep layout finalization open while continuing independent field/state/accessibility work; architecture drafting continues.

## Decision — persistent left request panel

User selected Persistent left panel on 2026-09-25 after reviewing the provisional layout. Keep operation, prompt, explicit source/mask/adapter inputs and request controls in a persistent left panel on desktop; canvas stays central, layers/properties right, tools at far left and collapsible results/jobs/history below. This settles request-panel placement and releases the layout-review hold; it is not blanket acceptance of the unfinished UX section. Preserve responsive drawers and accessible reflow for narrower windows, with exact sizes remaining author design detail.

## Saved desktop wireframe

The reviewed chat wireframe is now available as [Desktop editor wireframe](intent://local/upon-build/note/1dd17672-e2f0-4c89-a9bb-414f871fa7a4). Persistent left request-panel placement is accepted; exact sizes/styling remain provisional. The UX section owns detailed behavior.

## Desktop wireframe reviewed

User approved the [desktop editor wireframe](intent://local/upon-build/note/1dd17672-e2f0-4c89-a9bb-414f871fa7a4) on 2026-09-25. This records review of the shown structural layout, not approval of the full UX/architecture drafts or measured implementation behavior.

## Joint UX–architecture checkpoint — independent review pending

Both authors completed and reconciled [UX-1.1](intent://local/upon-build/note/3febb57d-ea57-42de-a098-b12fb4e010e4) and [ARCH-1](intent://local/upon-build/note/c0689bcd-8dca-4ce6-bccb-e538e0a45477). Shared definitions cover explicit frozen operation inputs; document-grid mask preservation and alpha-safe contribution replacement; locked/hidden-source caveats; local recovery/checkpoints/portable copies; retained candidates and zero-call replay; adapter eligibility and dataset lineage; PERF-4 feedback versus durable acceptance/completion. Architecture owns technical contracts; UX owns presentation and placement flows. Author agreement is not independent verification.

The user approved the desktop wireframe. Other product defaults remain proposals for review: initial format/color/blend/Photoshop-parity boundaries;25MP/8192-side/100-layer limits; selected-composite new-document placement; portable copy scope; local-only adapter imports; Fast/tiling deferral; training admission limits. Do not infer acceptance of these from wireframe approval or a technical verdict. Provider/runtime evidence gaps stay separately owned. Both tasks remain review_required. Joint independent review is next; Tasks5/7 remain queued.

Architecture review findings — corrections pending

Joint review identified two confirmed ARCH-1 gaps: per-layer pixel quantization is not fully specified, undermining the current-document outside-mask preservation claim at partial opacity; feathered mask support crossing the request crop lacks an explicit expand-or-clip approval rule. Proposed corrections are a shared canonical quantized contribution for rendering/capture/replacement with parity fixtures, and pre-freeze containment validation requiring approved crop expansion or a clipped-mask preview. These are proposals pending the coordinated revision and independent re-review, not completed fixes. The user’s initial editing-scope question remains unanswered; no preference is inferred.

Accepted UX scope — editable text and composition authoring

User decision: initial image-layer editing MUST include editable text. Model the editor concepts as closely as practical on Ideogram V4 compositional_deconstruction. This supersedes the proposed raster-only/no-editable-text scope; vectors and adjustment layers are not added by this answer. Evidence checked 2026-09-25: https://fal.ai/models/ideogram/v4 shows an expanded output prompt STRING containing high_level_description and compositional_deconstruction with background and elements (type obj/text, desc, and text for text elements); https://fal.ai/models/ideogram/v4/api still declares prompt as a string. Do not invent a top-level request field or infer editable output layers. Research structured prompt submission, expansion behavior, bounds/position conventions and limitations; distinguish verified schemas, example conventions and app-owned authoring data. Define native editable text, composition-to-prompt mapping, rasterization for API sources, preservation across generation/undo/save/export, fonts/layout/IME/accessibility and performance qualification. Existing UX-1.1/ARCH-1 and related API/performance coverage require a scoped revision; technical approval of the old baseline cannot satisfy this new requirement.

Accepted UX decision — initial document limits

Accepted initial document limits: at most 25,000,000 pixels, at most 8,192 pixels on either side, and at most 100 image/text layers in total. These are app limits, not provider constraints or measured capacity. Larger inputs require an explicitly approved, previewed resize while preserving original assets. Native editable text must be included in the qualification fixtures; these limits do not imply a cap on prompt composition descriptions. This resolves the document-envelope preference and supersedes the earlier 100-raster-layer-only proposal.

Accepted UX decision — combined-layer result placement

User accepted: when an AI edit combines selected layers with unselected layers interleaved between them, default result placement is a NEW DOCUMENT. Preserve the original document and its layer arrangement. This does not change ordinary reversible single-layer replacement or the accepted outside-mask preservation requirement; any alternate current-document placement requires explicit review and accurate disclosure of changed overlaps.

Accepted UX decision — portable project copies

User accepted FULL EDITING HISTORY as the default for portable project copies: include the editable document, undo history, retained generation candidates and referenced source/training assets needed by the defined project closure. Larger files are an accepted tradeoff for resuming work elsewhere. Preserve editable text. Exclude unrelated library content and secrets; copied job history must not resubmit provider work. Keep automatic local recovery, named checkpoints, portable copies and flattened exports distinct.

Accepted UX decision — adapter import method

User accepted LOCAL FILES FIRST for imported V4 LoRA adapters. Editor-trained adapters remain supported as previously decided; direct web-link imports are deferred. Import must retain immutable local bytes, provenance and compatibility evidence. This choice does not waive V4 compatibility qualification or authorize automatic paid validation.

Accepted UX decision — Fast and tiling priorities

User accepted V4 FAST IN THE INITIAL RELEASE; SEAMLESS TILING LATER. Fast must have a discoverable generation choice, accurate route-specific controls and initial testing/performance coverage. Keep Fast distinct from Instant and rendering_speed TURBO. Tiling remains fully specified but deferred; it must not be conflated with canvas extension or local raster tiles. This supersedes UX-1.1 deferral of Fast.

Coordinated revision after joint review V1

V1 joint review is NOT APPROVED: F01 contribution quantization, F02 feather/crop containment and F03 nested color_weight identity require correction. Accepted scope also adds native editable text/composition authoring and Fast initially. Revision sequence: (1) original API author researches structured composition prompting and updates the API reference; original architecture author independently repairs F01/F02 while keeping text scope pending; (2) reconcile UX/architecture native text, prompt mapping, accepted limits/save/import/placement priorities and nested inventory against that evidence, with focused performance and design-system impact coverage; (3) independent re-review before Tasks 5/7. Training-limit preference remains pending and must not be inferred. All work in this wave remains notes-only with public read-only research and bounded calculations; no paid calls or implementation. Current expanded wave weights: API evidence 1, UX 3, architecture 3, performance reconciliation 1, independent joint approval 1 = 9 units; independently verified 0/9, remaining 9. This replaces the earlier 5-unit denominator due to added scope, not a loss of already approved foundation history.

Accepted UX decision — training dataset limits

User accepted the proposed initial guided LoRA dataset limits: 1–100 images, up to 800 MiB total original image bytes, up to 201 MiB prepared upload package, and up to 4 KiB UTF-8 per caption. These are editor admission limits, not verified Fal requirements or measured capacity. Preserve originals and captions; fitting a package requires explicit reviewed changes, never silent resizing, removal or truncation. Provider compatibility and performance qualification remain required. Training retains its lower implementation priority. All seven questions in this UX review round are now answered; this does not approve unfinished technical revisions.

Focused API and raster verification checkpoint

API-1.2 and ARCH-1.1 are ready for focused independent verification before native-text integration. Review scope: structured composition evidence and source discrepancies (API E1–E9), plus canonical F01/F02 raster fixes and reproducible R1/R2 receipts (ARCH §3/§15). Full UX/architecture approval is not requested at this checkpoint: F03 UX field correction and native-text/composition/Fast/performance integration remain required. All seven UX preference questions are answered in the Spec. If API-1.2 passes, original Task1 may be marked complete; Task4 stays review_required even if its raster fixes pass. Expanded wave remains 0/9 until independent verdict; architecture partial approval does not count its whole 3-unit item.

Editable-text integration wave — authorized revision

V2 independently approved API-1.2 and verified ARCH-1.1 F01/F02 at source; actual Task1 is complete. Start coordinated notes-only revision with the ORIGINAL owners of Tasks3/4/6. UX owns editable text/composition controls, user journeys and F03; Architecture owns typed text/composition/font/layout/render/rasterization/event/save contracts and preservation; Performance owns bounded workloads/budgets/campaign capacity. Use API-1.2, DS-1.1 and the approved PERF-4 baseline, evolving the performance amendment in parallel through explicit author handoffs rather than treating an unfinished amendment as approved. This is a coordinated revision of already drafted sections, not downstream implementation; no dependency policy or previously accepted budget is silently waived. Cross-read all three final revisions before independent joint review. All seven user preferences are accepted. No paid calls, repo work, builds or benchmarks. Tasks5/7 remain queued. Current progress1/9 independently verified,8 remaining.


## UX-2 shared contract reconciliation — 2026-09-25

UX author completed the saved-source cross-read of [UX-2](intent://local/upon-build/note/3febb57d-ea57-42de-a098-b12fb4e010e4), [ARCH-1.2](intent://local/upon-build/note/c0689bcd-8dca-4ce6-bccb-e538e0a45477) core/§§16–17 and [PERF-5](intent://local/upon-build/note/1b7b659d-d577-4257-b677-4850bbf86143) final R33–R42/D11 against approved API-1.2 and DS-1.1. Native text remains app-owned and editable with exact font/layout/render/history identities; semantic elements bind explicitly per field and serialize once into Fal prompt:string. Fast remains distinct from Instant and rendering_speed TURBO. CP-1 contributions and explicit feather-domain review apply to text/image capture and non-destructive adoption.

Shared recovery agrees: Text Apply completes only with durable required dependencies/receipt plus correct canonical paint; full-history copies retain needed fonts/assets; missing fonts permit retained appearance but block reflow pending explicit resolution; larger raw prompts stay opaque owned streams where storage permits;4GiB copy/16MiB inspection are qualification bounds, not retention caps; no truncation/history pruning/automatic resubmission. All seven user preferences are adopted. Numerical resource/timing proposals remain unmeasured and require independent review; actual painted50/100ms feedback stays distinct from durable completion.

No unresolved author-level cross-section contradiction remains after final source corrections. Task3 is review_required. This checkpoint is author reconciliation, not independent approval or user acceptance of expanded controls/resource numbers. Coordinator owns joint review before Tasks5/7; expanded progress remains1/9 independently verified.


Joint review — UX-2 / ARCH-1.2 / PERF-5

Canonical review set: UX-2 (3febb57d-ea57-42de-a098-b12fb4e010e4), ARCH-1.2 (c0689bcd-8dca-4ce6-bccb-e538e0a45477), PERF-5 (1b7b659d-d577-4257-b677-4850bbf86143), with approved API-1.2 and DS-1.1. All three authors report completed cross-read and no remaining contract conflict. Independent joint UX/architecture review and dedicated performance review now run in parallel using the existing reviewers. UX/architecture reviewer owns original+amended task criteria, F03 and full text/composition/persistence/rendering/public-component behavior; performance reviewer owns all Task6 criteria, budget/workload completeness, resource arithmetic and closed campaign schedules. Each must check cross-section consistency and relay shared findings. Task6 may become complete on independent approval; Tasks3/4 require both their own approval and a consistent approved performance amendment before completion. User-approved choices remain accepted; newly proposed text defaults and numeric bounds are not user-approved merely because technically reviewed. Current tasks3/4/6 review_required; progress1/9 verified,8 remaining. No Tasks5/7, paid calls, app/runtime/benchmark work or repo edits.

Joint review V3 — native-text background grouping finding

Reviewer reported candidate F04 (P1) in ARCH-1.2 §16.6/S19 and UX §13/J17: collapsing a contiguous background block beneath retained native text can change canonical exterior pixels because CP-1 RGBA8 materialization is not associative. Supplied M=0 counterexample: opaque black, white alpha26, retained white text alpha14 gives108 in the original stack but109 after the background block is flattened to90. Exact outside-mask preservation remains required; a generic “if proof fails” clause is insufficient. Authors must retain source unchanged during the current baseline review. Correction must specify a provably safe placement rule or a complete equality check with fallback; the previously accepted new-document fallback remains available. If a full-image comparison is chosen, account for its work in PERF. This is an open review finding, not a completed fix; Task3/4 remain review_required.

Coordinated corrections — V3 and PERF-5

V3 and PERF-5 reviews are complete; all three drafts need focused source corrections. Existing authors now revise together: F04 restrict current-document native-overlay replacement to one original canonical contribution at its exact slot with all others unchanged; multi-layer background composites default to a new document, while complete root replacement remains separately specified. F05 use one connected app-owned native textarea/session for anchored/inspector views, preserve arbitrary selection with native APIs and defer view switches during IME; EnTextarea remains for independent prompt/description fields. P5-01 replace incomplete C9/I10C timing proof with a full sequential/shared phase and overhead ledger; P5-02 align T03 to accepted100-image support,500 only rejection/recovery or explicit future product amendment; P5-03 add the108→109 rejected-grouping regression plus safe singleton/new-document outcomes to finite R40 coverage. No full-image equality scan or new hardware is introduced. Correct operative clauses and stale summaries, preserve historical review receipts, cross-read final UX/ARCH/PERF versions and then independent re-review. Progress remains1/9 verified,8 remaining; no new product decision or Tasks5/7.


## UX-2.1 / ARCH-1.3 / PERF-6 correction reconciliation — 2026-09-25

Final author cross-read is complete for [UX-2.1](intent://local/upon-build/note/3febb57d-ea57-42de-a098-b12fb4e010e4) §§3/13/15/16/18, [ARCH-1.3](intent://local/upon-build/note/c0689bcd-8dca-4ce6-bccb-e538e0a45477) §16.2/16.6/S19/18 and [PERF-6](intent://local/upon-build/note/1b7b659d-d577-4257-b677-4850bbf86143) complete ledger/CP02/native-session/training corrections. Native-overlay exterior-preserving placement now requires one original K at its exact rendered slot, all other K/order unchanged and a frozen full-stack fingerprint; multi-background sources use new documents, while complete full-root replacement is a separate singleton mode. The native text editor remains one connected app-owned textarea across presentations, with native arbitrary range APIs and deferred composition-safe switching/cancellation. No private EnTextarea access or view-change acceptance is promised.

UX mirrors the corrected C9 allowance and 106-action IText without changing user-operation ceilings; training support remains accepted1–100 images. F03 all29 nested properties, all seven accepted preferences, persistent-left layout and existing CP-1/F02 remain preserved. Both peer authors confirm agreement; no unresolved author contract conflict. These source corrections supersede the earlier UX-2/ARCH-1.2/PERF-5 author agreement for the V3 findings, not the independent review history. Independent joint re-review remains required. Task3 returns review_required; progress1/9 verified,8 remaining; Tasks5/7 stay queued.


Independent re-review — corrected text and performance contracts

Review set is now UX-2.1, ARCH-1.3 and PERF-6; each author confirms final saved-source cross-read. Existing independent reviewers resume in parallel: joint reviewer checks F04/F05, all affected operative clauses/scenarios and original+amended UX/architecture criteria; performance reviewer checks P5-01–03/F04/F05 fixture allocation, complete ledger and preserved performance criteria. Review history stays intact. All three original tasks remain review_required until independent verdicts; no full joint completion before performance approval and consistent cross-contracts. No runtime/paid/repo work or Tasks5/7. Verified progress1/9,8 remaining; new text defaults remain technically proposed, not individually user-approved.

Final performance correction — complete browser workflow ledger

V4 independently verified UX-2.1/ARCH-1.3 source corrections and remaining non-performance criteria. Sole remaining gate is PERF P6-01: independent H9/I12H Fast UI workflows omit complete phase/paint/precondition allocation. Author confirmed178.8s>150s and1296s>1200s using saved allowances. Original Task6 resumes for explicit per-family H ledger, fixed independent case/cache counts, seed/stage/durable/dispatch/recovery/paint and setup/reset/trace/receipt accounting; reallocate only with concrete proof or raise block ceilings. Propagate all affected active/critical D08/I0/Q3/AX/feedback totals, audit equivalent H workflow accounting, and identify exact numerical mirrors in UX/ARCH. Do not change user-facing action budgets, accepted product scope, sample coverage or introduce new hardware merely to fit a schedule. UX/ARCH remain review_required pending independent performance approval and limited changed-clause reconciliation. No new product question or Tasks5/7; notes-only. Progress1/9 independently verified,8 remaining.

Limited PERF-7 mirror reconciliation

PERF-7 is saved; author final audit is finishing. UX/Architecture owners perform a LIMITED mirror update: current performance references to PERF-7 and revised campaign numbers only, preserving V4-verified pixel/text/action contracts and labelled historical receipts. Normal core target/ceiling50/100min (was45/90); cold60/120 and Q3 13/17h unchanged. New paired elapsed5500/6460s,active7960/9130s; I0elapsed5980s,active8545s; Q3critical1005min,active110845s; AX1580/2060s within30/45min. Normal feedback core60/130,adapter70/145,training85/165min; cold/Q3 feedback unchanged. H4 180/480s,H9 120/240s,I12H15/25min; unchanged C9 180/300s,I10C20/30min,164.1/528s,106IText,40P/22Q3. Validate against saved PERF source, do not copy unverified numbers blindly. Current per-user-action budgets and all product policies unchanged. Return changed-clause map and review_required; independent performance review plus limited cross-clause check still needed. No Tasks5/7 or runtime/repo work;1/9 verified.


Limited mirror reconciliation complete: **UX-2.2 + ARCH-1.4 + PERF-7**. UX author cross-read saved architecture §19 and PERF-7 final22:38 receipt; current references and campaign totals agree. Normal core50/100min target/ceiling, cold60/120min and initial Q3 13/17h. Exact changed-clause maps and preserved V4 behavior are in each §19. No user-action clock or product policy changed. Coordinator next: independent PERF-7 review plus limited changed-clause verification; no author approval inferred. Task3 review_required, progress1/9 verified, Tasks5/7 queued.


Targeted final performance and mirror review

Final source set for targeted review: PERF-7, UX-2.2 and ARCH-1.4. Actual Task4 is review_required; all authors recorded final saved-source agreement. Independent performance reviewer rechecks P6-01 complete H9/I12H and same-error H4/I6H ledger plus dependent schedules/unchanged criteria. Joint reviewer performs LIMITED changed-clause/reference review against V4-verified UX/ARCH behavior, preserving that prior evidence rather than restarting unrelated checks. Completion requires both independent performance approval and consistent unchanged UX/ARCH contracts. Mark original Tasks3/4/6 complete only when those conditions hold; until then review_required. No product reapproval implied, no Tasks5/7, repo/app/provider/benchmark work. Verified progress remains1/9,8 remaining.

Focused correction — compound cancel and late-result feedback

P7-01 is the sole remaining performance defect; P6-01 and all UX/architecture behavioral/mirror checks passed. Original Task6 resumes for a SMALL compound WQ cancel/late state/publication/paint map: name seed submit-pending/state, cancellation feedback and authoritative receipt, autonomous late-detected/pending retrieval, and final owned-candidate endpoints; price each distinct update and justify any actual overlap without weakening100ms feedback. Keep54/180 cases and cache states. Use available21.6s H4/727s I6H orchestration reserves if sufficient; recompute direct/reserve amounts and only genuinely changed totals. No new cases, user action budgets, product decisions, hardware or unrelated rechecks. Preserve all closed findings and clearly version source; identify whether UX/ARCH mirrors remain numerically/semantically valid. Tasks3/4 remain review_required pending final independent performance gate. Progress1/9 verified,8 remaining; no Tasks5/7 or runtime/repo/provider work.

Targeted final ledger check — PERF-8

PERF-8 is ready for limited independent P7-R1–R4 review: six paints/four local publications and explicit cancellation/late-detection/owned-result boundaries, compound6.350s, H4direct/reserve362.1/17.4s and I6H1027/713s within unchanged480/2400s blocks. Author reports no change to60 budgets, cases,40P/22Q3, aggregate schedules or UX-2.2/ARCH-1.4 semantics/numerical mirrors. Reviewer must independently confirm completeness, arithmetic and protected-source equality; retain V4/V5 UX/ARCH evidence without repeating unaffected behavior checks. On PERF approval, Task6 can complete; coordinator confirms mirror consistency and disposes Tasks3/4/joint gate. Prior user approvals unchanged. Progress1/9 pending verdict; no Tasks5/7 or runtime/repo/provider work.

Coordinator completion — UX, architecture and performance

2026-09-25: UX-2.2, ARCH-1.4 and PERF-8 are independently approved for specification/source readiness. [Joint V5 closure](intent://local/upon-build/note/176843a5-c21b-4de6-84a6-53ef5b9ca804) retains the full behavioral/source review and confirms the final mirrors; [PERF-8 review](intent://local/upon-build/note/bb86b142-0129-4293-b3c4-ebbb458490d7) closes the performance gate. Coordinator marked original Tasks 3 and 4 complete; Task 6 was already complete. No source fixes remain in this wave. Tasks 5 (testing strategy) and 7 (final assembly and repo docs) remain not_started. Runtime/browser/IME/provider/performance qualification remains future work; no user acceptance of the four proposed text defaults is inferred.

Readiness for testing strategy and assembly — 2026-09-25

Readiness check: no further independent review or implementation is required before Task 5. Its prerequisites are complete and report feedback is empty. Refreshed existing Tasks 5/7 to approved API-1.2, DS-1.1, UX-2.2, ARCH-1.4 and PERF-8, explicitly carrying native text/composition, Fast, exact preservation and regression coverage. Historical PERF-4 inputs are now labelled historical. Task 5 remains not_started; draft and independently verify it before Task 7. Task 7 owns final kickoff/decision traceability, coherent current-version docs/spec mirrors and final independent verification. Four text defaults remain proposed; they do not block drafting and must not be represented as user-approved. Runtime/paid/benchmark work remains future qualification, not a prerequisite for specification drafting. Expanded verified wave stays 9/9; the two remaining tasks still prevent whole-project completion.

Text default 1 accepted — one style per box

User accepted one typography style per text box for the initial editor. Font, size and color apply to the whole box; differently styled content uses separate boxes. Native editable multiline Unicode/IME text remains required. Mixed style runs remain deferred. This accepts the existing UX/architecture proposal without changing its technical contract. Three text defaults remain to review: explicit Apply/Cancel, explicit layer/composition links, and reviewed font substitutions. Tasks 5/7 remain not_started.

Text default 2 accepted — Apply or Cancel

User accepted explicit Apply or Cancel for native text edits. Typing previews a draft; Apply commits it as one undoable edit and Cancel restores the prior committed content. Switching canvas/inspector presentation preserves the same draft without applying it. This accepts the existing contract; no technical revision or new review is required. Two text defaults remain: explicit layer/composition links and reviewed font substitutions. Tasks 5/7 remain not_started.

Text default 3 accepted — explicit composition links

User accepted explicit links between native canvas text layers and AI composition entries. Creating either does not automatically create or link the other. Users choose linked fields; layer changes mark dependent request projections for review without rewriting an accepted request or native text from model output. This accepts the existing UX/architecture contract. Only reviewed font substitutions remain to review. Tasks 5/7 remain not_started.

All four text defaults accepted — 2026-09-25

The user has now accepted all four text defaults: (1) one typography style per text box; (2) explicit Apply or Cancel for text drafts; (3) explicit links between native layers and AI composition entries; (4) preview and explicit approval before substituting an unavailable font. For missing fonts, retain the saved appearance where available and offer exact restoration or reviewed replacement before layout-changing edits. Current substitution does not repair missing resources in older history.

These choices accept the existing reviewed UX-2.2/ARCH-1.4 contracts; they introduce no technical change requiring a repeated review. Earlier statements that these four defaults remain proposals are historical and superseded by these answers. Task 5 can treat them as accepted product policy and verify their observable behavior; Task 7 must reflect them consistently in the final notes and repository documentation. No further question remains in this four-item review. Tasks 5/7 remain not_started.

Authorized wave — testing strategy

User authorized starting Task 5 on 2026-09-25. Draft the complete testing strategy against approved API-1.2, DS-1.1, UX-2.2, ARCH-1.4 and PERF-8, including all accepted policy addenda. All four text defaults are accepted. The user also confirmed separate Layers and Composition lists with explicit links; not every raster/text layer automatically becomes a model caption element.

Use the existing [PR Context — upon-build](intent://local/upon-build/note/337dd04c-2911-4227-8217-1e2fc0b6a9f0). Deliver a canonical Testing Strategy section note and traceable consumer/outcome/owning-layer/fixture/future-command matrix. Preserve unit > integration > end-to-end priority, use real browser/components/local persistence where practical, and justify complementary integration/e2e coverage by distinct risks. Adopt actual en-reve public contracts and app-owned tooling conventions. Cover native text/IME/fonts/composition, all accepted routing cases and limits, F01–F05 regressions, deterministic exterior preservation, jobs/uncertain submissions/cancel/late results, crash recovery/replay/copies, accessibility, training/adapters and performance. Separate model quality evaluation from contract correctness. Default suites require no credentials; describe opt-in cost-bounded live provider verification without executing it.

Map to PERF-8 existing budgets, campaign phases, samples and complete timing boundaries; do not invent passing measurements or duplicate/reinflate campaigns. If source contradictions are found, identify the exact owning clause and propose a bounded correction to the coordinator rather than silently changing peer sections. Include meaningful consumer assertion examples and explicit flake/quarantine/manual evidence rules. Every planned test must have an observable outcome; avoid coverage quotas, private-implementation mirroring and snapshot-only proof.

This is notes-only drafting: no repository docs or application edits, installs, paid/provider calls, app/browser tests or benchmarks. Read-only source research and bounded offline specification checks are permitted. Keep one canonical deliverable, update original task/shared context/existing progress handoff, then set review_required and report for independent verification. Do not mark the task complete yourself, start Task 7, or claim user/runtime approval. Task 7 remains queued until Task 5 is verified and separately continued.

### Task 5 author handoff — TEST-1 (2026-09-26)

The full [Testing Strategy — TEST-1](intent://local/upon-build/note/d7819c6b-68ff-4d89-835d-9acabe779cae) is ready for independent review. Original task060d9fce-0132-4c2e-b066-9e8883a8e1a0 remains review_required. It maps approved API/DS/UX/ARCH/PERF contracts, accepted addenda/all four text defaults, separate Layers/Composition lists, J1–J24/S1–S27/O1–O9/F01–F05, native text/accessibility/recovery and all60 performance budgets. Existing P/Q3 campaigns are retained; actual bounded source/arithmetic receipts are distinguished from unexecuted future tests.

Coordinator next action: independent source/spec review and findings reconciliation. No repository implementation/docs, installs, app tests, benchmarks, CI or provider calls were performed. User review of TEST-1 is pending. Task7 remains queued. Detailed handoff is appended to the existing [PR Context — upon-build](intent://local/upon-build/note/337dd04c-2911-4227-8217-1e2fc0b6a9f0); the existing [Progress Report](intent://local/upon-build/note/b6884312-45fe-4295-a5a3-70180a701223) records0/3 independently verified in this new wave.


Independent review of Task 5 — TEST-1

[Testing Strategy — TEST-1](intent://local/upon-build/note/d7819c6b-68ff-4d89-835d-9acabe779cae) is authored and ready for independent verification. Reuse verifier agent-189ca150-206b-4203-a7d1-3c149d17c02a, which did not author this section and previously verified the owning UX/architecture contracts. Review the original Task 5 criteria plus current accepted addenda, actual consumer outcomes, appropriate unit/integration/browser/e2e ownership, native text/composition and F01–F05 regression coverage, manual accessibility and opt-in provider protocols, and compatibility with PERF-8. Counts and author arithmetic receipts are supporting evidence, not sufficient proof of coverage.

Existing [PR Context — upon-build](intent://local/upon-build/note/337dd04c-2911-4227-8217-1e2fc0b6a9f0) remains the shared handoff. No new source change or repeated baseline audit is required without an actual discrepancy. Produce a dedicated independent testing-strategy review with criterion outcomes, concrete findings and reproducible bounded checks. Task 5 remains review_required until approval; Tasks 1–4/6 remain complete, Task 7 remains queued. No implementation, app tests, builds, installs, benchmarks or provider calls are part of this review. All four text defaults and separate linked lists are accepted. Wave progress remains 0/3 independently verified; prior 9/9 wave is historical.

Task 5 complete — final assembly ready

Coordinator confirmed actual Task 5 complete and Task 7 not_started after [independent TEST-1 approval](intent://local/upon-build/note/0843a4b2-b4f5-449b-b109-2f851e2cca7b). [Testing Strategy — TEST-1](intent://local/upon-build/note/d7819c6b-68ff-4d89-835d-9acabe779cae) has no required source fixes. All six section tasks are now complete. Only Task 7 remains: assemble/reconcile the current sections against the kickoff requirements, produce matching docs/spec files through an implementor, then independently verify the final deliverable. Task 7 has not started. User review of TEST-1 remains pending; runtime/benchmark/provider checks remain future qualification.

Final assembly readiness confirmed

Task 7 readiness checked against its brief and approved TEST-1 handoff: no known blocking source correction or further baseline review. Updated Task 7 to name completed TEST-1 and accepted text/list policies. Remaining cleanup belongs to assembly: consolidate current requirements while preserving historical evidence, verify kickoff/decision traceability, synchronize portable docs/spec mirrors and register future qualification work with owners/triggers. All six section tasks remain complete; Task 7 remains not_started. No application/provider/benchmark work is needed before drafting the final documentation.

Authorized final assembly wave — Task 7

User authorized Task 7 on 2026-09-26: assemble and reconcile the final technical specification and repository documentation, followed by independent verification. All six source tasks are complete. Freeze current approved API-1.2, DS-1.1, UX-2.2, ARCH-1.4, TEST-1 and PERF-8 plus accepted addenda. All four text defaults and separate Layers/Composition lists with explicit links are accepted.

Use the SAME [PR Context — upon-build](intent://local/upon-build/note/337dd04c-2911-4227-8217-1e2fc0b6a9f0). Repository branch upon-build was confirmed clean before delegation. Documentation files under docs/spec/ are now explicitly authorized; prior notes-only limits applied to earlier tasks and do not prevent this deliverable. No application scaffolding, dependency installs, design-system edits, benchmarks, provider calls, PR publication or deployment. Any commit uses ws.git.commit, never git commit.

Deliver a canonical Ideogram Editor — Technical Specification index note, six independently reviewable current section notes/mirrors, docs/spec/index.md and one Markdown file per section, plus a synchronization manifest naming note IDs/revisions, approved input versions and output paths/hashes. Supporting traceability/glossary/decision/evidence files are allowed where useful. Keep all current contract details and full API reference evidence; make navigation and core requirements readable without requiring chat history. Historical author/reviewer exchanges belong in clearly separated evidence/history, not interleaved contradictory operative requirements. Preserve original task and review history.

Trace every kickoff requirement and later decision through evidence, capability, UX, commands/events/projections, consumer tests, performance budgets and implementation phase; give reasons for not-applicable cells. Explicitly distinguish documented provider facts, accepted product policy, proposed engineering budgets and unqualified runtime behavior. Map all capability gaps, candidate outpainting, deferred tiling/streaming/training priorities and direct source/mask-plus-LoRA routes consistently. Keep the agreed independent native-layer/composition relationship, exact raster/text/history semantics, unit > integration > e2e priority and runtime/developer performance requirements.

You may consolidate and correct editorial/current-version wording in the owning section notes while preserving labelled history and semantics; record the exact transformation and source-to-mirror mapping. For a newly discovered substantive contradiction, report the owning clauses and a bounded fix to the coordinator before changing approved technical contracts. Do not reopen or revise verified budgets merely to assemble documents. Assemble the unresolved implementation/provider qualifications into one owned register with impact and decision/validation phase; do not represent future tests as already passed.

Verify complete coverage, portable local links/anchors, table/fence/JSON integrity, manifest hashes and semantic note-to-repository parity. Report changed files, git diff/status, source revisions, docs verification actually performed and remaining limits. App tests or provider calls are neither required nor authorized. Set original Task 7 review_required at author handoff, not complete. Independent final verification is required before final specification completion.