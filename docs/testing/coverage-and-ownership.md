# Validation ownership and duplicate-work decisions

The executable file inventory is `npm run test:preflight`; aliases select the same owning records. The independent Node and Playwright reporters reconcile actual discovered/completed cases at execution. This review retains every product assertion. Similar examples at different boundaries are not evidence of duplication.

| Family / owning layer | Invariant and observable oracle | Why retain this boundary; disposition |
| --- | --- | --- |
| Session / real local HTTP | Pairing, private roots, authentication, launcher and network restrictions; actual status/headers, admitted roots and launched app | A pure validator cannot detect an exposed listener or missing launcher assets. Keep; select app build before launcher. |
| Store / SQLite and processes | Durable receipts, one writer, corruption/refusal/recovery; actual reopened tables, bytes, process death and receipts | Mocks cannot prove durable recovery. Keep serial with no-network preload and fresh writable roots. |
| Protocol / HTTP and projection | Command identity, snapshot/tail/SSE consistency and content hashes; wire responses and independent expected state | Distinct from storage admission and browser publication. Keep wire and browser oracles, share prerequisite builds. |
| Assets / writer and HTTP | Upload ownership, offset, staging, content identity and migration; actual files/receipts and independent digests | HTTP/authentication and durable writer admission catch different defects. Keep both; cache only archived compiler output. |
| Raster / native decode, writer, browser | Approval before conversion, exact pixels, admission and rollback; frozen inputs and pixel/hash expectations | Native decoder, protocol approval and visible preview have different failure modes. Keep engines and fresh physical resource cohorts. |
| History / pure, writer, browser | Undo/redo branches, replay and schema compatibility; expected commands/state and actual prior executable | Pure malformed-input coverage does not prove atomic browser publication or old-reader compatibility. Keep; restore legacy preparation into independent directories. |
| Provider / policy and guarded local transport | Authorization, cancellation, request identity and evidence; explicit policy outcomes and local HTTP observations | No live paid provider call is implied. Keep local boundary tests and their provider guard. |
| Request / controller, writer, browser | Draft completeness, command ownership and actionable UI; independent expected commands, durable receipts and DOM state | Controller and native interactions are distinct. Keep; group browser work after Node checks. |
| Queue / writer and browser | Admission, cancellation, retention and ordering; actual queued jobs, blobs and visible state | UI can look correct with stranded jobs. Keep fresh state and failure cases. |
| Adapters / fixture integration and browser | Artifact acceptance, cleanup and user approval; sealed public fixture and resulting admission/state | Preserve the large fixture's explicit prerequisite; do not download it for build-free checks. |
| Candidates / writer and browser | Candidate ownership, prompt retention and schema rollback; durable state and accepted historical reader | Retain real prior readers and fresh DBs. No replacement with current implementation as oracle. |
| Export / writer and browser | Authorized destination commit, correct output and cancellation; file bytes, destination observation and operation receipts | Export computation is not proof of destination persistence. Keep dedicated destination-commit selection. |
| Composition / domain and controller | Geometry/state transitions and final composition; independent expected values and published state | Keep pure edge cases and wiring checks; do not repeat builds per alias. |
| Text state / writer and native workers | Text admission, schema and native equivalence; retained fonts, independent expected state and rendered outputs | Engine/platform distinctions remain necessary. Node-hosted browsers belong in the browser phase. |
| Portable / archives and historical reader | Closure, retention, hostile input refusal and rollback; ZIP/table inventories, independent hashes and prior reader | Keep real archive and process boundaries; no cached mutable archive/database. |
| Recovery / state, HTTP, browser | Atomic projection, metadata, stream recovery and ownership cleanup; state generations and real browser results | Synthetic failing harnesses are owned by Node parents that assert their failure and teardown. Ordinary recovery selects product consumer/metadata only. |
| Shell/editor / complete browser workflows | Session/CSP, keyboard, layout, native editing and completed operations; DOM/pixels and independent completion monitoring | Keep native engine differences. Display-image and integration keep dedicated fixtures/configs. Batch only compatible editor files with isolated contexts and per-spec receipts. |
| Text rendering / browser engines | Shaping/rendering/budgets, first-load requests and storage denial; explicit image/worker/request assertions | One observed initial navigation suffices per ordinary case. Retain explicit reloads, all engines and the independently owned stock-storage specimen. |
| Qualification / tooling controls | Fail-closed inventory, seals, accounting, locks and orchestration; adversarial synthetic receipts and known failures | Build-free; run after types/preflight. Synthetic negative outcomes must be asserted, never counted as product failures or skipped. |
| Campaigns / product integration | Required campaign command/result coverage; actual integration environment and exact case ledger | Preserve `IE_CAMPAIGN_PRODUCT_INTEGRATION=1`. These are not interchangeable with runner-unit controls. |
| Vendor/imports/Python tooling | Frozen archives, public imports, safe review/archive lifecycles; independent manifest digests, boundary/refusal and fresh restore | Verify before install; retain restore tests for archive-tool changes. Review audit never authorizes deletion. |
| P/Q3, native/manual/live / physical environment | Defined timing/resource/native/provider claims; prescribed independent cohorts and authorized observations | No development receipt substitutes for these. Retain fresh samples, timing exclusion, manual authorization and unresolved A-R01. |

## Executions removed or consolidated

| Repeated work | Retained owner / proof of defect detection |
| --- | --- |
| Repeated server/app builds across maintained wrappers | One dependency gate per invocation; changed source/dependencies or output corruption invalidates reuse. Orchestration tests deliberately mutate these inputs. |
| Redundant import checks inside development producers | The owning plan's imports prerequisite. Public standalone producers keep their own check. |
| Five repeated text navigations and an unused page in stock-storage testing | Observers installed before the single initial navigation; all original request/render/admission assertions remain. The independent storage specimen owns its browser/context. |
| Duplicate integration/display selection by generic editor configs | Dedicated configs own each file; inventory equality and discovered/completed accounting reject omissions. |
| Up to 18 separate compatible editor invocations per engine | Opt-in single invocation retaining the same file/engine selection, per-spec output namespaces, test-scoped contexts and required persistent profiles. Serial fallback remains. |
| Repeated archival compilation | Content-verified immutable archive/compiler output; each caller gets independent writable copies and seeds. Corruption/compiler-change controls force regeneration; migration assertions still execute. |
| Rechecking unrelated successful Node gates after a failure | Explicit resume only, with exact input key and retained successful log/counts; failed and pending gates execute. Source drift never publishes reusable evidence. |

No malformed-input matrix, negative control, engine distinction, cold-start assertion, restart boundary or physical sample has been removed. The decision for overlapping product assertions is **keep**: there is no demonstrated equivalent retained oracle justifying removal. Case-level consolidation beyond these setup/navigation changes requires its own defect-detection evidence.
