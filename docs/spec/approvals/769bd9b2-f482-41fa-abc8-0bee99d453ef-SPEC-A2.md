# Verification Summary — SPEC-A2 final verdict

- Verdict: **✅ APPROVED for specification/source readiness** at **083579cdb1bfd24e3fdb64f4f051524393e50861**.
- Confidence: **High** for the document/source assertions checked. Runtime performance, app behavior, native IME/AT, provider behavior and storage durability remain unqualified, as specified.
- **FA-01 is closed. No failing acceptance criterion or unresolved source ambiguity remains.** The SPEC-A1 NOT APPROVED finding below is preserved as historical review evidence.
- All original Task7 criteria and current Spec requirements are VERIFIED within the assigned documentation scope. The unaffected baseline findings are retained, supported by exact unchanged-file and contract checks; this is targeted re-verification, not a new API/runtime review.
- Per the Coordinator’s explicit assignment, **original Task7 remains review_required for Coordinator final disposition and post-approval metadata synchronization**. Tasks1–6 remain complete. Technical final-wave approval is now **4/4**; **user acceptance remains pending**.

Correction parent:46c10ee7f660cfe9e9f7994a2013dfe7c180002d. Original base:7c41c8e708b08b458ebf0f4fc369e2621ad7cd4a. Branch upon-build is clean. Commit subject: “Clarify training ZIP and manifest sidecar in final specification.” No source/repository repair or runtime work was performed by this verifier.

## FA-01 resolution and evidence

**✅ VERIFIED.** [PERF §2 WT](intent://local/file/docs/spec/performance.md):57 and §5:507 now explicitly restrict the ≤201MiB provider ZIP to validated image/caption pairs and keep the app manifest as a separately prepared and persisted durable sidecar. Manifest preparation/storage remains within existing workload and T01/T02 timing/resource accounting. These clauses agree with unchanged [UX §8](intent://local/file/docs/spec/ux.md):424 and [ARCH §10](intent://local/file/docs/spec/architecture.md):570. No combined ZIP-plus-sidecar size cap is introduced.

The targeted diff contains only the authorized PERF version/WT/packaging replacements, SPEC-A2 index/version/handoff references and supporting provenance/checker artifacts. The checker permits exactly the literal WT old→new string, requires one occurrence and identical numerals, and still compares all other table bytes under the existing version-label normalization. It retains the independent exact 60-budget-row comparison. No broad exclusion or numerical concession was added.

The ledger now reconstructs all six current source sections using the original six extracts plus **67** exact replacements (the previous64 plus the authorized three). Original history and five unaffected technical sections have no diff from SPEC-A1. API63 and ARCH13 JSON/TypeScript contracts remain exact, including tilde-fenced architecture contracts.

## Acceptance Criteria Checklist — current final disposition

The detailed baseline evidence and exact original wording remain below. This table records one current verdict for each original Task7 criterion.

| Criterion | Current verdict | Evidence | Verification |
| --- | --- | --- | --- |
| T7-1 titled/tagged index, scope, glossary, risks and handoff | ✅ VERIFIED | Same canonical index; only A2 version, PERF pointer and honest FA-01 handoff changed | Targeted index diff, retained baseline reading |
| T7-2 complete requirements/decisions and meaningful end-to-end traceability | ✅ VERIFIED | 11REQ/26DEC/24CAP and R01–R20 chains unchanged; traceability JSON changes only assembly version | Diff plus checker and baseline owning-clause evidence |
| T7-3 operation compatibility, preserved conflicts and frozen requests | ✅ VERIFIED | API/UX/ARCH/TEST byte-identical to approved baseline; corrected V4/direct editing-LoRA/Fast distinctions retained | Explicit unchanged-file diff and contract comparison |
| T7-4 reconciled final state/raster/job/workload/testing contracts | ✅ VERIFIED | FA-01 WT/packaging now matches UX/ARCH sidecar contract; T01/T02 manifest work retained; all numerical contracts unchanged | Three owning clauses, exact ledger and all26 table/60 budget checks; independent scheduling arithmetic |
| T7-5 full lower-priority training and honest capability dispositions | ✅ VERIFIED | Complete training lifecycle retained; only ZIP membership clarification; P4 versus imported inference P2 unchanged | Targeted diff and retained baseline API/UX/ARCH/TEST evidence |
| T7-6 standalone sections and fact/policy/proposal/runtime boundaries | ✅ VERIFIED | Five unchanged sections, narrowly corrected PERF and explicit source-only A2 status | Contract/source reconstruction, index qualification/handoff diff |
| T7-7 portable mirrors, authoring authority and synchronization | ✅ VERIFIED | Seven actual notes match current files;24 input snapshots,39 seals; original22 snapshots unchanged | Fresh raw-note readback00:55:59.689Z, independent hash/link audit and exact history diff |
| T7-8 owned unknowns and provisional implementation gates | ✅ VERIFIED | Q01–Q27 unchanged; no new preference needed and no runtime qualification implied | Index/traceability diff and baseline register review |
| T7-9 app recovery and matched documentation rollback | ✅ VERIFIED | ARCH unchanged; original history preserved; correction evidence added separately | Unchanged-file/history diff and baseline recovery review |
| T7-10 Spec links, independent evidence and original task accounting | ✅ VERIFIED | All seven links retained; this same review/PR Context/Task7/progress chain records final approval; Tasks1–6 complete | Current notes and assigned review boundary; Coordinator explicitly owns Task7 completion and metadata closeout |

| Current Spec criterion | Current verdict | Evidence | Verification |
| --- | --- | --- | --- |
| REQ-API | ✅ VERIFIED | Complete unchanged API and27 schema appendices, typed/nested contracts | Exact source/block checks plus retained baseline |
| REQ-CAP | ✅ VERIFIED | All24 unchanged direct/candidate/comparison/unsupported/deferred dispositions and field mappings | Traceability-only version diff; baseline owning clauses |
| REQ-OPS | ✅ VERIFIED | Unchanged O1–O9 typed routes, preserved drafts and frozen requests | API/UX/ARCH/TEST exact equality |
| REQ-UX | ✅ VERIFIED | Unchanged J1–J24, exact mask/safe-slot/root semantics, native text, font recovery and accessible interactions | Exact equality; baseline behavioral traceability |
| REQ-STATE | ✅ VERIFIED | Unchanged authority, event/action granularity, pure replay, late candidates, full-history closure and recovery | Exact equality and typed contracts |
| REQ-DS | ✅ VERIFIED | Unchanged public-contract integration, staged adapters, coherent archives and app-owned native editor | Exact DS/UX/ARCH/TEST equality; baseline source evidence |
| REQ-TEST | ✅ VERIFIED | Unchanged consumer U>L>E rationale, J24/S27/TX16/AX10, real/manual layers and60 budget mappings | Independent mapping and source checks |
| REQ-PERF | ✅ VERIFIED | All60 budget rows and26 tables preserved except the exact authorized WT wording; counts and clocks unchanged | Safe checker, independent math and ledger reconstruction |
| REQ-TRAIN | ✅ VERIFIED | Consistent image/caption-only upload ZIP, durable manifest sidecar and existing preparation/storage work; full lifecycle/lower priority retained | Exact three-clause inspection and unchanged T01–T07/TEST mappings |
| REQ-LOCAL | ✅ VERIFIED | Unchanged server-only key, local/backend/fal, staging and reconciliation boundaries | Exact owning source equality and baseline review |
| REQ-DOCS | ✅ VERIFIED | FA-01 corrected in owning source and mirror; exact provenance/history/portable links and current parity | Fresh independent source/link/hash/parity checks; no remaining contradiction found |

## Evidence index — SPEC-A2 round

- Reviewed correction commit083579cdb1bfd24e3fdb64f4f051524393e50861 and its parent46c10ee7f660cfe9e9f7994a2013dfe7c180002d.
- Read SAME PR Context, original Task7 authorization/author handoff, current Spec focused-review instruction, existing progress and this same independent review. No duplicate review note was created.
- Current owning notes remain the same seven IDs listed in the baseline evidence index. SPEC-A2 index and PERF-8+A2 are the only substantive current-document revision identities changed.
- Current raw-note hashes independently rebuilt: index **b2e355b349f9b30a101edca00a6f5988e91077185e2fa07bee318a7361e6e461**; PERF **8dd1e9af57b847e00658fbb1efcdc70c69256e8a0e89cd0f78d23ed3f79af235**. The other five hashes are unchanged.
- New correction snapshots were independently checked against live notes before this review update: Task7 snapshot is an exact prefix of its subsequently appended note; SPEC-A1 review snapshot exactly matched the full then-current review note. They are historical inputs, not current status mirrors.
- Source review examined every changed semantic clause, the exact checker allowance, manifests/receipts, preservation of the prior22 inputs, and newly added correction provenance.

## Tests/Commands Run — SPEC-A2

- Inspect `git diff 46c10ee7f660cfe9e9f7994a2013dfe7c180002d HEAD` for changed current documents/checker/ledger/manifests → **PASS**, authorized bounded change only. The checker remains standard-library read-only and safe to execute.
- `python3 docs/spec/tools/check_spec.py` → **PASS**:7 docs,218 relative links including history,164 tables,67 JSON examples,24 inputs,376 note references,7 recorded parity rows,60 exact budgets,26 tables with exact FA-01 substitution,27 API appendices and39 seals.
- `shasum -a 256 -c SHA256SUMS` from docs/spec → **PASS**, all39.
- Independent source/contract script preserved below → **PASS**:24 input hashes,67 exact replacements,six reconstructed prose documents,seven rebuilt raw-note hashes,API63/ARCH13 contracts,60 test mappings,J24/S27/TX16/AX10.
- Independent portable-link/JSON script → **PASS**:217 current local links/anchors, six JSON artifacts without duplicate keys. Current technical content remains usable outside the workspace.
- Independent finite-math script → **PASS**, unchanged normal5500s/cold6460s core,Q3 critical775/1005min and active110845s, native/Fast and WQ/H4/I6H ledgers, P22/30/40 and Q3 16/19/22 inventories. These are source arithmetic checks, not benchmarks.
- Actual seven-note parity script → **PASS at2026-09-26T00:55:59.689Z**, all seven current raw contents exactly match transformed repository files.
- `git diff --check 46c10ee7f660cfe9e9f7994a2013dfe7c180002d HEAD` → **PASS**.
- `git diff --check 7c41c8e708b08b458ebf0f4fc369e2621ad7cd4a HEAD -- docs/spec ':!docs/spec/history'` → **PASS**.
- `git diff --exit-code 46c10ee7f660cfe9e9f7994a2013dfe7c180002d HEAD -- docs/spec/history docs/spec/api.md docs/spec/design-system.md docs/spec/ux.md docs/spec/architecture.md docs/spec/testing.md` → **PASS**, no changes.
- `git status --short --branch` → **PASS**, clean upon-build.
- Application/build/browser/nativeIME/AT/CI/benchmark/provider commands → **not run**, outside the authorized documentation task. No runtime evidence or pre-existing CI claim is inferred.

## Risk Notes and final handoff

No required source fix remains. Q01–Q27 continue to own future provider/runtime/build/font/storage/accessibility/performance qualifications. Technical document approval does not authorize implementation, paid work or deployment.

Canonical feedback was empty at focused-review start00:55:40.913Z and at the final all11-note check **2026-09-26T00:56:21.572Z**. No user review card was marked and no feedback was resolved on the user’s behalf.

**Coordinator next action:** finalize original Task7 and synchronize status-only Spec/index/manifest/receipt wording to this approval, retaining named current note/file pairs and history. Their current “review pending/0/4” text describes the pre-approval handoff; routine post-approval metadata is not a technical defect or reason to repeat unrelated source review. Any actual contract change would require its own targeted check. User review of the final specification remains pending.

---



# Historical SPEC-A1 baseline verification — superseded by SPEC-A2 verdict

- Verdict: **❌ NOT APPROVED** for SPEC-A1 at **46c10ee7f660cfe9e9f7994a2013dfe7c180002d**.
- Confidence: **High for documentation/source verification.** No application, provider, accessibility, native IME, durability or performance runtime certification is claimed.
- One required correction: **FA-01 (P2), contradictory training ZIP contents**. The acceptance criteria are specific and testable; their meaning did not block review. This is a conflict between owning source clauses, not a request for a new product preference.
- Original Task 7 stays **review_required** for Coordinator disposition. Tasks 1–6 remain complete. Final wave stays **0/4**; user acceptance of the final assembly remains pending.

Reviewed branch: upon-build. Actual parent/base: **7c41c8e708b08b458ebf0f4fc369e2621ad7cd4a**. Commit subject: “docs: assemble the reviewed Ideogram editor specification.” The change contains documentation only. No repo edits, commits, source repairs, builds, installs, browser/native tests, benchmarks, provider calls, PR publication or deployment were performed by this review.

## Required correction — FA-01

**Severity:** P2, required specification correction before final assembly approval. **Owner:** Performance/Training source owner, coordinated through original Task 7.

**Failing criterion:** “Reconcile Tasks 3/4 document/raster/asset/job semantics and refine Task 6 workload budgets with documented rationale. Validate the Task 5 assertions against the final contracts. Finish this before claiming specification completion.” Also REQ-DOCS: “Fix contradictions in source sections; document existence alone is insufficient,” and the consistent dataset-preparation portion of REQ-TRAIN.

**Evidence / reproduction:**

- [PERF §2 WT](intent://local/file/docs/spec/performance.md), line 57, says “≤201 MiB ZIP including captions/manifest.”
- [UX §8](intent://local/file/docs/spec/ux.md), line 424, expressly limits the initial uploaded archive to validated image/caption pairs and retains the manifest separately.
- [ARCH §10](intent://local/file/docs/spec/architecture.md), line 570, expressly retains the app manifest as a durable sidecar and forbids assuming undocumented manifest members belong in the provider ZIP.
- PERF line 507 says packaging uses captions and an app manifest without making the sidecar distinction. That sentence is not independently wrong, but should be aligned when clarifying WT.
- The same WT wording is in the sealed PERF-8 input, history/1b7b659d-d577-4257-b677-4850bbf86143.md:49. This is an inherited cross-section discrepancy missed during reconciliation, **not editorial data loss**.
- Read-only author clarification confirmed UX/ARCH as the explicit owning payload rules and confirmed there is **no existing clause** defining WT’s wording as combined accounting. The author made no source change.

**Impact:** An implementor following WT could build and benchmark a ZIP containing an extra manifest, contrary to the initial upload contract. Exact mirror parity and the unchanged-table checker preserve this discrepancy; neither proves semantic consistency.

**Minimal required change:** Align current PERF WT and its packaging explanation with the existing UX/ARCH rule: upload only validated image/caption pairs; retain the app manifest as a separate durable sidecar, with its preparation/storage still included in the existing work. Preserve all accepted image/byte/caption limits, numerical budgets and campaign counts. Update the owning performance note and its mirror together, record the exact correction/version in the editorial ledger, and refresh affected manifests, parity receipts and seals. If the checker’s unchanged-table assertion needs to accommodate this approved wording correction, allow only that exact recorded transformation; retain comparison of every other workload/campaign value. Do not modify sealed historical evidence or weaken the 60 budget-row checks. No provider research, paid call or new product decision is needed to align with the existing initial payload rule.

**Re-verify:** Read the three owning clauses together; confirm image/caption-only upload plus separately durable manifest and unchanged preparation/storage work; reproduce the commands and fresh seven-note comparison below. Inspect the targeted diff and recheck the unaffected numerical budget/campaign preservation assertions.

## Acceptance Criteria Checklist — original Task 7

Each entry is a documentation/source verdict, with current addenda applied.

1. **✅ VERIFIED — T7-1: titled/tagged index with goal, scope, links, glossary, risks, priorities and handoff.**
   - Evidence: index note df180a35-40dd-43d7-b9c6-1f1dd0306088 is titled Ideogram Editor — Technical Specification and tagged spec-section; docs/spec/index.md contains the reading path, accepted scope, glossary, qualifications, phases and review handoff.
   - Verification: cold reading of the current index, live note metadata and portable navigation checks.

2. **✅ VERIFIED — T7-2: stable end-to-end requirements and accepted-decision traceability.**
   - Evidence: index requirements/decisions/capabilities and traceability.json map 11 REQ, 26 DEC and 24 CAP entries, plus R01–R20. Mappings name owning behaviors, commands/projections, tests, budgets and phases; deferred/document-only cells explain N/A.
   - Verification: inspected actual referenced contracts, not only IDs. Examples: dedicated masked LoRA → O7 → frozen masked intent/JobQueued/candidate → exact preservation/adoption tests → R09–R15/R24–R29/R40/T05–T06 → P2; native text Apply → staged TextVersion/font/layout/render → CommitTextEdit → TX/F05 → R04/R20/R33/R34 and IText → P1–P3; full-history copy → closure/atomic namespace/inert imported jobs → L-copy/E1 → R39 → P1–P3. FA-01 is a consistency defect in an otherwise present training chain.

3. **✅ VERIFIED — T7-3: operation selection, preserved conflicts and frozen requests.**
   - Evidence: API operation schemas, UX O1–O9, ARCH §4 and TEST §5 preserve the corrected V4 family, direct source-plus-LoRA and mask-plus-LoRA, independent Fast/Instant rules, explicit attachments, resize approval and immutable accepted inputs.
   - Verification: audited all accepted compatibility rows and CAP-01–24, including mask without source, incompatible Instant/Fast attachments, batch versus concurrency, multiple references, candidate outpaint, unsupported upscale, comparisons and disabled fallback.

4. **⚠️ DEVIATION — T7-4: reconcile final document/asset/job/workload/testing contracts.**
   - What differs: FA-01’s ZIP payload conflicts with the separate-manifest contract.
   - Why it matters: workload qualification could encode the wrong provider payload; cross-section handoff is not fully reconciled.
   - Suggested minimal fix: the owning PERF correction described above; no numerical redesign.
   - Re-verify: exact clause inspection, targeted diff, checker, hashes and fresh live-note parity. Other document/raster/job semantics and TEST/PERF mappings were verified as detailed below.

5. **✅ VERIFIED — T7-5: full lower-priority training and honest capability dispositions.**
   - Evidence: API trainer fields/outputs, UX guided stages, ARCH dataset/adapter lineage and recovery, TEST conditional E5, PERF T01–T07/WT/WA and index P4 preserve full training scope. Imported-adapter inference remains P2 and independent of trainer completion.
   - Verification: reviewed dataset/caption/crop preparation, frozen parameters, uncertainty/cancellation/offline recovery, separate durable weights and config, explicit adapter registration/use. Direct editing LoRA is distinct from a proposed multi-call workflow; outpaint, upscale, references, streams and tiling retain their accepted dispositions. FA-01 is isolated under T7-4/REQ-TRAIN.

6. **✅ VERIFIED — T7-6: independently reviewable sections and fact/policy/proposal/runtime boundaries.**
   - Evidence: six +A1 sections retain definitions, original dated/source-versioned evidence, limitations and testable outcomes; API S/M/P differences, DS source evidence, engineering proposals and unexecuted qualification are explicit.
   - Verification: complete API A/B appendix equality (27 endpoint appendices), nested-definition coverage, all JSON/TypeScript contract fences and reviewed source-to-current transformations. No runtime pass is inferred from an upstream source approval.

7. **✅ VERIFIED — T7-7: portable mirrors, authority and synchronization.**
   - Evidence: seven named current documents; note-map, sync-manifest, editorial ledger, input history, parity receipts and SHA256SUMS; index synchronization/conflict policy.
   - Verification: actual current note raw contents matched rebuilt repository-to-note text for all seven at **2026-09-26T00:47:13.781Z**, in addition to earlier checks. Independently resolved 215 current relative links/anchors inside docs/spec; checker resolves 216 including history. The single current intent link is progress provenance; no sole technical dependency on workspace notes. All 22 input and 37 sealed artifact hashes pass.

8. **✅ VERIFIED — T7-8: owned unknowns and explicit provisional implementation handoff.**
   - Evidence: index Q01–Q27 names accountable roles, practical impact, next action and phase/trigger; front matter makes implementation provisional at qualification gates.
   - Verification: checked provider sizing/protocol/billing/retention, archive interoperability, DS/tool provenance, codecs/fonts/IME/AT, real filesystem durability, closure storage, hardware/capacity/suite evidence and optional future scope. Accepted text/list preferences are not reopened. No runtime implementation blocker is falsely called tested or resolved. FA-01 is newly identified here for source correction.

9. **✅ VERIFIED — T7-9: application recovery and matched documentation rollback.**
   - Evidence: ARCH §§5–10/16 and index recovery/synchronization prescribe staged required bytes before acceptance, single durable writer, conservative uncertain dispatch, pure replay, inert imported remote history, versioned migration with old namespace/backup, dependency-complete copies and matched note/doc/manifests rollback.
   - Verification: reviewed failure/late-result/undo/reopen and schema/resource paths; rollback retains original task/review history and never claims to reverse a paid request.

10. **✅ VERIFIED — T7-10: Spec links, verifier record and original task accounting within the assigned review boundary.**
    - Evidence: current Spec links all six sections and index; this independent record is linked under PR Context, Task 7 and the existing progress report. Task metadata confirms Tasks 1–6 complete and Task 7 review_required.
    - Verification: live note/task reads. The latest assignment explicitly reserves Task 7 completion and post-approval status/receipt synchronization for Coordinator; pending metadata is not a separate technical defect. No peer task was reopened or changed.

## Acceptance Criteria Checklist — current Spec

- **✅ VERIFIED — REQ-API**
  - Evidence: API catalog/A01–A27/B/C/E, endpoint-specific request/output matrices, eight nested definitions/29 properties, official protocol source distinctions and dated unresolved conflicts.
  - Verification: schema/typed-block preservation and owning UX/ARCH/TEST mappings; no upstream research rerun or fresh runtime claim.

- **✅ VERIFIED — REQ-CAP**
  - Evidence: all CAP-01–24 dispositions and field-to-control/output/provenance/internal-policy mappings, with proposed/unsupported/deferred distinctions.
  - Verification: actual route/field matrices and negative-path mappings, including color_weight and native-text versus caption-profile separation.

- **✅ VERIFIED — REQ-OPS**
  - Evidence: operation-specific allowlists, conflict-preserved drafts, explicit resize approval, frozen source/mask/adapter/settings, no older-model fallback.
  - Verification: API→UX O1–O9→ARCH typed union→TEST U-route/L-provider/B-controls cross-read.

- **✅ VERIFIED — REQ-UX**
  - Evidence: J1–J24 and document/create/import/save/reopen/export, source/mask/selection, result states, failure recovery and practical AX interactions; explicit Photoshop-parity limits.
  - Verification: CP-1 M=0 byte preservation, safe original-K slot, unsafe contiguous regrouping rejection, separate new document and full-root conditions; native text/fonts/Apply–Cancel/separate lists and explicit bindings remain consistent.

- **✅ VERIFIED — REQ-STATE**
  - Evidence: typed document/raster/asset/job/adapter models; action categories; atomic acceptance, event sequence/identity, pure projections and undo/replay; job outbox/journal and recovery.
  - Verification: S1–S27 coverage, no remote effects in replay, uncertain-submit/new-attempt separation, late candidate retention, immutable full-history closure and migration/read-only recovery contracts.

- **✅ VERIFIED — REQ-DS**
  - Evidence: DS current public source contract audit and provenance; tentative component events feed staged app adapters; one app authority; four coherent runtime archives with private dependency closure; app-owned native textarea and testing gaps.
  - Verification: source-preserving assembly audit and DS→UX/ARCH/TEST/PERF consistency. Dirty source is not treated as a sealed distributable; public controls do not supply a private native-selection bridge.

- **✅ VERIFIED — REQ-TEST**
  - Evidence: consumer outcome-based U > L > E priority with justified complementary browser/manual layers; J24/S27/TX16/AX10; real local/browser boundaries; all 60 budget mappings.
  - Verification: checked fixtures, assertions, owner/layer rationale, native IME/AT evidence requirements, no string/snapshot/coverage-only proof, failure retention and no duplicate performance campaign.

- **✅ VERIFIED — REQ-PERF**
  - Evidence: all 60 numerical rows and 26 campaign/workload tables preserved; workload/environment/owner/sample/clock/instrumentation/regression/retention policy and separate provider observation cohorts.
  - Verification: independent finite scheduling arithmetic and TEST mappings pass. The WT payload consistency defect is recorded under REQ-TRAIN/REQ-DOCS and T7-4; no numerical budget or timing-evidence failure was found.

- **⚠️ DEVIATION — REQ-TRAIN**
  - What differs: PERF WT includes a manifest inside the ZIP; UX/ARCH require a separately retained sidecar.
  - Why it matters: the full training handoff has two incompatible payload descriptions.
  - Suggested minimal fix: FA-01 owning PERF clarification preserving existing limits and work.
  - Re-verify: all three clauses, training TEST mappings and documentation/parity/hash checks.

- **✅ VERIFIED — REQ-LOCAL**
  - Evidence: server-only FAL_KEY environment boundary, local session versus provider secret, deployment injection boundary, staging, durable polling/reconciliation, hosted webhooks optional.
  - Verification: API protocol and ARCH §7–8/TEST failure-redaction mappings; no browser key or required hosted service introduced.

- **⚠️ DEVIATION — REQ-DOCS**
  - What differs: one inherited owning-source contradiction survives in an otherwise complete, portable and synchronized assembly.
  - Why it matters: source consistency is an explicit acceptance requirement; passing hashes does not resolve it.
  - Suggested minimal fix: FA-01 plus synchronized correction/provenance records.
  - Re-verify: targeted semantic review, documentation checker, current links/structure, exact live parity, hashes and unchanged numerical contracts.

## Evidence index

- Commit reviewed: 46c10ee7f660cfe9e9f7994a2013dfe7c180002d; actual base/parent 7c41c8e708b08b458ebf0f4fc369e2621ad7cd4a.
- Planning/task records: current Spec; original Task 7; original Tasks 1–6 and their completion metadata; SAME PR Context 337dd04c-2911-4227-8217-1e2fc0b6a9f0; existing progress b6884312-45fe-4295-a5a3-70180a701223; accepted compatibility 6df7045b-6f0a-42c5-a32d-879b38d54c51.
- Approved inputs/current owners: API 2728dafd-4209-4558-a762-3a0192e0610f; DS bf7b9cc0-391c-4fce-97a8-5da1a660a4a2; UX 3febb57d-ea57-42de-a098-b12fb4e010e4; ARCH c0689bcd-8dca-4ce6-bccb-e538e0a45477; TEST d7819c6b-68ff-4d89-835d-9acabe779cae; PERF 1b7b659d-d577-4257-b677-4850bbf86143; index df180a35-40dd-43d7-b9c6-1f1dd0306088.
- Approval/history evidence: foundation99dd9c46-10a3-404d-b4b7-458c2c34758d; jointV1–V5 176843a5-c21b-4de6-84a6-53ef5b9ca804; TEST0843a4b2-b4f5-449b-b109-2f851e2cca7b; PERFbb86b142-0129-4293-b3c4-ebbb458490d7; accepted wireframe1dd17672-e2f0-4c89-a9bb-414f871fa7a4.
- Files: seven current Markdown documents; traceability, editorial, note-map, parity, verification and sync JSON; SHA256SUMS; safe checker; 22 sealed original note snapshots and history README.

**Editorial-loss audit:** independently applied all six source extracts and 64 exact replacements from the ledger after common link rewriting, then compared every remaining nonblank prose line (ignoring only added anchors/link destinations). No unexplained substantive removal appeared. Excluded API receipt appendix, UX/ARCH old review handoffs/arithmetic receipts and PERF old failed/replaced review records remain in exact history; accepted text defaults are in current owning sections and DEC-23–26. All API JSON/TS fences (63) and ARCH fences using either backticks or tildes (13, more than the author checker’s backtick-only seven) are identical to their inputs. All 27 API schema appendices, 60 budget rows and 26 performance tables remain exact under the declared version-label normalization. This preservation result also explains why FA-01 survived.

## Tests/Commands Run

All shell commands used the repository root unless stated otherwise.

- Read all of docs/spec/tools/check_spec.py before execution → **PASS, safe**: standard-library documentation reads, hashes, parsing and exit status; no app/provider/network execution or source mutation.
- `python3 docs/spec/tools/check_spec.py` → **PASS**: 7 docs, 216 relative links including history, 164 tables, 67 JSON examples, 11 requirements, 26 decisions, 24 capabilities, 27 qualifications, R01–R20, 22 snapshots, 351 historical/current note references, 7 recorded parity rows, 60 budgets, 26 performance tables, 27 API appendices, 37 seals.
- `shasum -a 256 -c SHA256SUMS` with cwd docs/spec → **PASS**, all 37.
- Independent in-memory Python editorial/hash/contracts audit (appendix below) → **PASS**, exact replacement counts, six reconstructed prose sections, input/output hashes and seven rebuilt raw-note hash identities.
- Independent current portability/JSON audit (appendix below) → **PASS**, 215 current relative targets/anchors stay inside docs/spec; 6 support JSON artifacts parse without duplicate keys.
- Fresh workspace raw-note comparison (appendix below) → **PASS**, all seven actual current notes exactly match transformed files at 00:47:13.781Z; no reliance on archived readback receipts alone.
- Independent scheduling arithmetic (appendix below) → **PASS**, ordinary core normal5500s/cold6460s; Q3 C520/805min,H720/900min,critical775/1005min; total active110845s; I0 actual5980s. C9/I10C direct164.1/528s and total300/1800s; WQ39.05s, compound6.350s with four publications/six paints; H4/I6H362.1/1027s plus explicit overhead fit480/2400s. These are sums, not measurements.
- `git diff --check 7c41c8e708b08b458ebf0f4fc369e2621ad7cd4a HEAD -- docs/spec ':!docs/spec/history'` → **PASS**.
- `git diff --check 7c41c8e708b08b458ebf0f4fc369e2621ad7cd4a HEAD -- docs/spec` → **expected exit2**, only the four original whitespace-only lines at sealed history/bb86b142-0129-4293-b3c4-ebbb458490d7.md:948/952/956/960. Not a requested fix.
- `git status --short --branch` and `git show --no-patch --format='%H%n%P%n%s' HEAD` → **PASS**, clean upon-build and expected head/parent.
- Semantic cross-section verification → **FAIL FA-01 only**.
- App/build/browser/native IME/AT/benchmark/provider/CI commands → **not run: outside this documentation-only assignment**. No runtime assertion or pre-existing CI-failure claim is made; no base rebuild was performed.

## Risk Notes and handoff

The remaining risk is a misleading training payload contract, not broken executable code. The owning correction should be small and reviewed without reopening accepted product decisions or unrelated completed tasks. Future runtime evidence remains intentionally unexecuted under Q01–Q27, including actual provider behavior, immutable package production, renderer/font/IME/AT compatibility, storage durability and empirical performance.

Canonical open feedback was checked at start and again at **2026-09-26T00:46:35.201Z** across Spec, PR Context, original Task7, progress, index and all six owners: **zero open threads**. FA-01 is the new finding in this record. No user feedback was resolved or review card marked on the user’s behalf.

Coordinator next action: authorize the bounded owning-source FA-01 correction through original Task7, then request targeted re-verification against a named new revision. Keep Task7 review_required, final wave0/4 and user review pending until the appropriate checks and disposition. Routine post-approval status/receipt updates are not additional technical findings. No separate workspace, implementation or unrelated follow-up is proposed.


## Historical review-start checkpoint — 2026-09-26 00:40 UTC

Review in progress for SPEC-A1 at 46c10ee7f660cfe9e9f7994a2013dfe7c180002d on upon-build. Base: 7c41c8e708b08b458ebf0f4fc369e2621ad7cd4a. This is an independent documentation/source review against original Task 7 and the current Spec, not runtime certification.

Initial report, Spec, Task 7 and PR Context feedback checks found no open threads. Seven CURRENT saved notes normalize exactly to their repository mirrors at 2026-09-26T00:40:43Z. The inspected standard-library documentation checker passes. Semantic and editorial-loss review is still in progress; no approval or user acceptance is claimed.

Original Task 7 remains review_required for coordinator disposition. Final wave remains 0/4 until independent approval. No source or repository edits, app tests, builds, installs, benchmarks or provider calls are part of this review.


## Reproduction appendix — bounded read-only checks

These scripts are verification evidence stored in this note, not added to the repository. Run Python snippets from the repository root using `python3 - <<'PY'` followed by the snippet and closing `PY`. They read documentation only. The live-note snippet runs through workspace_api; require all seven comparisons to be true. A later authorized correction must update its recorded transformation/receipts before the preservation assertions can pass.

<details>
<summary>Independent source, editorial and contract audit</summary>

```python
import pathlib,json,hashlib,re
p=pathlib.Path('docs/spec');mp=json.loads((p/'sync-manifest.json').read_text());nm=json.loads((p/'note-map.json').read_text());par=json.loads((p/'note-parity.json').read_text())['receipts']
h=lambda b:hashlib.sha256(b).hexdigest()
for r in mp['inputs']: assert h((p/r['snapshotPath']).read_bytes())==r['sha256'],r['noteId']
for r in mp['outputs']:
 if 'sha256' in r:assert h((p/r['path']).read_bytes())==r['sha256'],r['path']
for r in par:
 s=(p/r['path']).read_text()
 def link(m):
  t=m[1]
  if re.match(r'^[a-z][a-z0-9+.-]*:',t,re.I):return m[0]
  bits=t.split('#',1);return ']('+nm['noteLinkMap'].get(bits[0],nm['supportLinkPrefix']+bits[0])+('#'+bits[1] if len(bits)>1 else '')+')'
 raw=re.sub(r'\]\(([^\n)]+)\)',link,s)
 assert h(raw.encode())==r['readbackRawSha256'],r['path']
 print(r['path'],h(raw.encode()),'raw hash independently rebuilt')
ledger=json.loads((p/'editorial-transformations.json').read_text());texts={};ops=0
for op in ledger['operations']:
 n=op['section']
 if op['kind']=='extract':
  lines=(p/'history'/f"{op['sourceNoteId']}.md").read_text().splitlines(keepends=True)
  texts[n]=''.join(''.join(lines[a-1:b]) for a,b in op['inclusiveSourceLineRanges'])
  for path,url in nm['noteLinkMap'].items():texts[n]=texts[n].replace(url,path)
 else:
  assert texts[n].count(op['old'])==op.get('count',1),(n,op['kind'])
  texts[n]=texts[n].replace(op['old'],op['new']);ops+=1
def prose(s):
 s=re.sub(r'<a id="[^"]+"></a>\n\n','',s)
 s=re.sub(r'\]\([^\n)]+\)','](LINK)',s)
 return [l for l in s.splitlines() if l.strip()]
for n,s in texts.items(): assert prose(s)==prose((p/f'{n}.md').read_text()),n
def contracts(s):
 return [(m[2],m[3]) for m in re.finditer(r'^(\x60{3}|~{3})(json|ts|typescript)\n(.*?)^\1\s*$',s,re.M|re.S)]
for r in nm['sections']:
 n=r['path'];old=(p/'history'/f"{r['noteId']}.md").read_text();cur=(p/n).read_text()
 a,b=contracts(old),contracts(cur)
 if a or b:assert a==b,n
 print(n,'all JSON/TS fenced contracts',len(b))
ids=lambda s:set(re.findall(r'^\| ((?:R|T|D)\d\d)\b',s,re.M))
perf=(p/'performance.md').read_text();test=(p/'testing.md').read_text()
assert len(ids(perf))==60 and ids(perf)==ids(test)
for prefix,end in [('J',24),('S',27),('TX',16),('AX',10)]:
 for i in range(1,end+1):
  token=prefix+(f'{i:02}' if prefix in ['TX','AX'] else str(i))
  assert re.search(r'\| '+token+r'\b',test),token
print('PASS',len(mp['inputs']),'input hashes;',ops,'ledger replacements; 6 reconstructed prose documents; 7 raw note hash proofs; 60 test budget mappings; J24/S27/TX16/AX10')

```

</details>

<details>
<summary>Independent portable-link and JSON audit</summary>

```python
from pathlib import Path
from urllib.parse import urlsplit,unquote
import re,json,collections
root=Path('docs/spec').resolve()
names=['index','api','design-system','ux','architecture','testing','performance']
def anchors(text):
 out=set();counts=collections.Counter();fence=None
 for line in text.splitlines():
  f=re.match(r'^(`{3,}|~{3,})(.*)',line)
  if f:
   if fence and f[1][0]==fence[0] and len(f[1])>=len(fence):fence=None
   elif not fence:fence=f[1]
   continue
  if fence:continue
  a=re.search(r'<a id="([^"]+)"',line)
  if a:assert a[1] not in out;out.add(a[1])
  if re.match(r'^#{1,6} ',line):
   h=re.sub(r'^#+ ','',line).lower()
   h=re.sub(r'\[([^]]+)\]\([^)]*\)',r'\1',h)
   h=re.sub(r'<[^>]+>','',h)
   h=re.sub(r'[^\w -]','',h).replace(' ','-')
   n=counts[h];counts[h]+=1;out.add(h+('-'+str(n) if n else ''))
 return out
links=0;external=collections.Counter()
for name in names:
 p=root/(name+'.md');s=p.read_text()
 anchors(s)
 for m in re.finditer(r'\]\(([^\n)]+)\)',s):
  u=urlsplit(m[1].strip('<>'))
  if u.scheme:external[u.scheme]+=1;continue
  assert not u.path.startswith('/'),(name,m[1])
  q=(p.parent/unquote(u.path)).resolve() if u.path else p
  assert q.is_relative_to(root) and q.is_file(),(name,m[1])
  if u.fragment:assert unquote(u.fragment) in anchors(q.read_text()),(name,m[1])
  links+=1
 assert not re.search(r'\]\((?:file://|/Users/)',s)
print('PASS independently resolved',links,'current portable links/anchors within docs/spec; external provenance schemes',dict(external))
def no_duplicate(pairs):
 d={}
 for k,v in pairs:
  assert k not in d,'duplicate JSON key '+k
  d[k]=v
 return d
files=list(root.rglob('*.json'))
for p in files:json.loads(p.read_text(),object_pairs_hook=no_duplicate)
print('PASS',len(files),'support JSON artifacts with no duplicate object keys')

```

</details>

<details>
<summary>Independent finite scheduling arithmetic</summary>

```python
import re
from pathlib import Path
from decimal import Decimal as D
s=Path('docs/spec/performance.md').read_text()
rows={m[1]:m[2] for m in re.finditer(r'^\| (C\d+|H\d+) \| ([^|]+)\|',s,re.M)}
pairs=lambda t:[tuple(map(int,p)) for p in re.findall(r'(\d+)\s*/\s*(\d+)',t)]
def total(prefix,cold=False,target=False):
 return sum(pairs(v)[-1 if cold else 0][0 if target else 1] for k,v in rows.items() if k.startswith(prefix))
for cold,wall,active in [(False,5500,7960),(True,6460,9130)]:
 c,h=total('C',cold),total('H',cold)
 ready=sum(pairs(rows[k])[-1 if cold else 0][1] for k in ['C0','C1','C2'])
 assert 2*max(c,ready+h)==wall,(c,h,ready)
 assert 2*(c+h)==active
print('PASS parsed ordinary core: normal5500s/7960s active; cold6460s/9130s active; exactly11C+11H blocks')
assert len(rows)==22
q={m[1]:pairs(m[2])[0] for m in re.finditer(r'^\| (I[\dA-Za-z/]+) \|[^\n]*\| ([\d/]+)min(?: combined| each host| each)? \|$',s,re.M)}
cids=['I1','I2','I6C/I6H','I7N','I7A','I7T','I8C/I8H','I9C/I9H','I10C','I12C']
hids=['I3','I4','I5a/I5b','I6C/I6H','I8C/I8H','I9C/I9H','I10H','I11H','I12H','I13H']
ct=sum(q[k][0] for k in cids); cc=sum(q[k][1] for k in cids)
ht=sum(q[k][0] for k in hids); hc=sum(q[k][1] for k in hids)
assert (ct,cc,ht,hc)==(520,805,720,900)
assert q['I0'][0]+max(ct,ht)==775
assert q['I0'][1]+max(cc,hc)==1005
assert (cc+hc)*60+3980+4565==110845
assert 2750+3230==5980
print('PASS parsed Q3: C520/805min,H720/900min; critical775/1005min; active110845s; I0 actual5980s')
family=[(8,'0.350'),(15,'0.300'),(1,'0.800'),(6,'0.275'),(6,'0.850'),(6,'0.050'),(1,'1.050'),(1,'3.050'),(1,'1.350'),(1,'4.250')]
assert sum(n for n,_ in family)==46
direct=sum(n*D(t) for n,t in family)
assert direct*6+14*D('.5')+16*D('.5')==D('164.1')
assert direct*20+46*D('.5')+16*D('.5')==528
assert D('164.1')+30+290*D('.2')+30+D('17.9')==300
assert 528+300+966*D('.5')+240+249==1800
wq=[D(x) for x in ['1.950','2.100','2.100','6.350','4.950','7.950','5.950','7.150','.550']]
assert sum(wq)==D('39.050')
assert D('4.750')+4*D('.250')+6*D('.100')==D('6.350')
h4=6*sum(wq)+18*D('4.1')+3*6+3*2+3*10
assert h4==D('362.1')
assert h4+30+81*D('.5')+30+D('17.4')==480
i6=20*sum(wq)+60*D('4.1')
assert i6==1027 and i6+300+240*D('.5')+240+713==2400
print('PASS complete native/Fast ledger164.1/528s and bounds300/1800s; WQ39.05s; H4/I6H362.1/1027s within480/2400s')
assert (22,22+8,22+8+10)==(22,30,40)
assert (16,16+3,16+3+3)==(16,19,22)
print('PASS P22/30/40 and Q3 16/19/22 finite inventories; scheduling arithmetic only, no measurements')

```

</details>

<details>
<summary>Actual current note comparison</summary>

```javascript
const m = JSON.parse(await ws.file.read('docs/spec/note-map.json'));
const rows = [{noteId:m.indexNoteId,path:'index.md'},...m.sections];
return {time:new Date().toISOString(),parity:await Promise.all(rows.map(async r=>{
  const [f,n] = await Promise.all([ws.file.read('docs/spec/'+r.path),ws.note.read(r.noteId)]);
  const expected = f.replace(/\]\(([^\n)]+)\)/g,(match,t)=>{
    if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return match;
    const [p,fragment]=t.split('#');
    return ']('+(m.noteLinkMap[p]||m.supportLinkPrefix+p)+(fragment?'#'+fragment:'')+')';
  });
  return {...r,exactRawParity:expected===n.rawContent};
}))};
```

</details>


Final handoff check at2026-09-26T00:49:43.791Z: Spec, PR Context, original Task7 and progress still have zero open feedback threads; Task7 is still review_required. Verdict, evidence, reproduction scripts and links are saved. Repository remains clean at the reviewed commit.