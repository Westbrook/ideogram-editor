# Ideogram Editor — current project plan

Updated 2026-09-30 for migration to another harness. [Handoff and startup](HANDOFF.md) are the entry point. This plan describes current work and supersedes obsolete dispatch/approval prerequisites to the user-requested local-main integration. It does not replace the approved technical contracts or turn unfinished work into accepted work.

## Progress and remaining scope

| Work | Earned / weight | Current state and next action |
| --- | ---: | --- |
| P1a/P1b/P1c foundations | Previously accepted | Local editor, durable assets/history, native text/fonts, Composition and recovery are in the imported lineage. Keep existing qualification limits. |
| P2.1 Provider boundary/emulation | 12/12 | Accepted `8b2ae732`; real provider claims remain unqualified. |
| P2.2 Typed operations/review | 12/12 | Accepted `92688fb7`; immutable public request review. |
| P2.3 Queue/outbox/cap | 18/18 | Accepted `9764b03a`; uncertain attempts retain holds, no silent resubmit. |
| P2.4 Retained candidates/E2 | 14/14 | Accepted `086c9a67`; full document deletion belongs to P2.5. |
| P2.5 Recovery/cancel/deletion/E4 | 0/14 | Integrated `93fa312`; F1–F4 closed. Final author three-engine results await whole-slice outcome disposition; combined-load failure remains explicit. |
| P2.6 Mask review/adoption/E3 | 0/12 | Not implemented. Separate request masks from layer masks; validate capture/mapping/halo and exact source identities. Atomic safe adoption/history, original-slot or captured-root replacement, unchanged M=0 pixels and zero-call undo/redo; unexpected dimensions require new review. |
| P2.7 Local adapters/direct LoRA | 0/10 | Not implemented. Bounded local file import, immutable version/provenance, sealed V4 eligibility and explicit runtime acknowledgement; 1–3 distinct versions/order/scales including zero. Direct LoRA operations without hidden substitutes. Unknown compatibility stays unattached; training and URL import remain future scope. |
| P2.8 Independent whole-P2 review | 0/8 | Pending final exact integrated source. Verify E2–E4, security/durability/retention/UI contracts and evidence reuse boundaries; coordinator accepts and releases P3. |
| Spectrum theme | 0/3 | Standalone approved `5d8dd5df`; integrated unchanged with source/build checks only. Integrated acceptance is outstanding. |
| P3 Initial release qualification | Unstarted | Existing functional/security/durability/accessibility/browser/native/platform/runtime/developer-performance matrix, with actual supported environments and raw evidence. Keep A-R01, physical presentation/IME/AT, CI/Docker and provider gaps explicit. |

**P2 is 56/100.** Reviews already included in implementation slices earn no extra weight; parent tasks earn no duplicate credit. Importing source, generating a report, passing builds and user review are distinct from functional acceptance. Retain the existing report denominator, scope-change events and burndown rather than recomputing a smoother history.

## Continue in this order

1. Confirm the main commit, portable report snapshot and required raw evidence locations. Read unresolved feedback and the latest handoff before changing files. Preserve the old source/evidence roots and unrelated refs.
2. Finish disposition of the existing P2.5 current-build outcomes and residual limits, then scope affected integrated Spectrum checks. Use the available evidence first; no automatic qualification replay. Prior approval gates were removed only as prerequisites to this consolidation, not silently satisfied.
3. Start the usable-Fal/manual-preview milestone promptly when its engineering prerequisites are met. Advance P2.6 and other independently ready work without waiting for pilot input or user testing. Separate source ownership where work overlaps.
4. Complete P2.6, P2.7 and final independent P2.8 review, then run the existing P3 campaigns. Record measured results separately from targets and unavailable evidence. Use bounded checks and failure disposition; do not repeat successful unchanged work without a reason.

## Usable real Fal and manual preview

Deliver a reviewed, working **named in-app Fal operation**, not only an emulator demo or readiness checklist. Prepare server-only secret configuration, explicit provider mode and immutable request review, a supported production endpoint/privacy profile, uncertainty/request limits, real result handling and retained inspection. Existing normal-launcher production profiles are denied, so a key alone is insufficient. Define and record any extra engineering effort before credit.

Give the user a separate usable preview URL and short walkthrough when ready; preserve the frozen preview and disclose incomplete masks/adoption/adapters. Before actual real calls, obtain a locally supplied key and explicit approval for the concrete endpoint, request/image count, maximum spend or request limit, privacy/retention behavior and failure/cancellation handling. Never put keys in chat, notes, report data, browser code or logs. A request cap does not guarantee a currency cap. No paid call, upload or production enablement is authorized by this handoff.

The prior notification automation is **cancelled**. Notify during active work when readiness is reached; do not recreate the hook without renewed authorization. The milestone remains required and nonblocking for independent work.

## Contracts, open feedback and evidence

Use `docs/spec/{architecture,ux,api,testing,performance,design-system}.md` for the approved contracts. Prefer suitable public En Reve controls and document narrow justified exceptions. No dependency upgrades are part of this handoff.

A-R01 remains open for the historical 25 MP WebP RSS breach above 512 MiB; admission accounting/refusal does not prove the full resource envelope. P2.5's 222-test failure and later isolated 25-test pass must remain distinct. Spectrum's first-paint and native/visual limitations remain attached to its reviewed version. Preserve version-specific feedback/checkpoints; neither a read receipt nor report visibility means acceptance. Exact source mappings, package hashes and validation boundaries are in the [handoff](HANDOFF.md).
