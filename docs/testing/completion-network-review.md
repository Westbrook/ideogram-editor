# Completion network boundary review

Status: **source-reviewed successor; managed execution unverified**. This document reconciles the committed donor record at `29e5bcf94214e2bae7b0d492b903065f189c5488`, read with `git show`, with the reviewed managed-workflow packets. The donor record originated in `/Users/westbrook/Documents/repos/ideogram-edit`; its observations describe that original working environment and are not validation of `/Users/westbrook/.codex/worktrees/ideogram-integrated-validation/ideogram-edit`. This file was absent from the managed checkout when the successor was staged.

No tests, builds, emitted issuer preparation, browser work or producer ran for this document reconciliation. Historical producer/evidence seals remain unchanged. The original checkout's later uncommitted edits are not inputs to this record.

## Historical donor review — 2026-09-30

The donor source review was limited to request issuers and their reachable ownership wrapper. Its implementer reviewed product changes already present in the original checkout. The following rationale and three identities are retained as that historical review; they do not identify the final managed assembly. It was not product acceptance, a human review checkpoint, or approval of memory/resource qualification.

`RecoveryClient` routes the same paths and request options through `RecoveryWorkspace.request`. That wrapper forwards the original transport and options and substitutes the workspace abort signal. It introduces no request API, destination, credentials, redirect behavior, body or keepalive flag. The release POST still uses the same local endpoint, CSRF header and protocol body. Cancellation can prevent cleanup requests; this review does not claim stronger release delivery semantics. Content/control/stream readers and bounded buffers change ownership and parsing, not issuer permissions.

`readSealedAsset` retains the same-origin URL check, bounded expected length, same-origin credentials, redirect rejection and original signal. Its new `readTextAssetResponse` helper only consumes/cancels/unlocks the response already obtained. Cleanup failures retain their owner; they do not launch retries or additional network requests. The recovery ownership helper is now pinned explicitly alongside the two changed boundaries. Session transport and text engine pins are unchanged.

The emitted classifier still requires exactly eight fetch calls and three XHR constructors, exact option shapes, fallback GET/null bodies, and body issuers confined to the main application. No count, option whitelist or historical producer identity is relaxed. Candidate preparation must pass those checks on the newly built application before dependent browser work.

Historical donor-reviewed source identities (SHA-256; not the current twelve-pin map):

```json
{
  "src/state/recovery-client.ts": {
    "prior": "6aad855f2d51645759637e1cbb64e1ffacae16e3b86df48d5848077b435d5fd7",
    "reviewed": "43f23b5cfb96db02e99a624ba0fcbe45aef3c1c96bd3db69b18a78aec5eabef4"
  },
  "src/text/contracts.ts": {
    "prior": "80173a85fd2eeca2cac63ea0806c23643668dfc2c3249859e9d07426e3730686",
    "reviewed": "96aa65d78cf834c14def464df88d3b94982193cfeabc8f70b1eaba3d86fae6ec"
  },
  "src/observability/recovery-memory.ts": {
    "prior": null,
    "reviewed": "52c4b1f97ae3ee5e3eec4e88ca0274174aaea1b54f611ec27a948393f052b492"
  }
}
```

## Reviewed managed-source successor

The final source-pin successor is `artifacts/validation-workflow-completion-pins-02/manifest.json`; its bounded semantic review and exact twelve-pin comparison are recorded in `source-review.json` and `peer-review.json` beside it. The classifier and its independent expected-map test must be adopted together, after their reviewed predecessors and with the matching product sources:

| Target | Reviewed SHA-256 |
| --- | --- |
| `tests/editor/completion/issuer-classification.mjs` | `a5c40e942a16f7e2cd66377b69b95cd24caaff784b381bdce8c5816bba1526e9` |
| `tests/editor/completion/issuer-classification.test.mjs` | `d05865b18c11eab5374f2d3a1fe7442f7a35c078193ff7b88a50a15fbde17c8f` |

Pins02 changes exactly two reviewed source identities from the allocation45 predecessor; the other ten pins, classifier logic, frozen/deep-equality assertions and other test bytes are preserved. The historical recovery-client hash above is not a substitute for its final unchanged pin, `a8c1d5abd96ede4564721818f8d814f5894fe5a91587e597ba00611403c91d8e`. The complete final map remains in `NETWORK_BOUNDARIES` and its independent expected-map test.

| Boundary | Immediate reviewed predecessor → final reviewed source |
| --- | --- |
| `src/observability/allocations.ts` | `58ef1c541d76f914dcf770e33f8245404d7a9d10d69292197836cea74e21fbf6` → `273e3745edf95b948581b9e7bec197b3e6cba64b2ceb0033f8a3edb34a3b161b` |
| `src/state/editor-client.ts` | `f7362efd9346f90dc05723cfca9d8d48ce8759f681a4db1ef6649a0205b1f9d7` → `6719b5526a342fb1384a935de3e042c4b0676fdd98fc82bf8b37c77b212fe518` |

The allocation successor adds fixed-kind accounting, guarded points/windows and observed-prompt accounting, and increases fixed observer bookkeeping from 4096 to 65536 bytes. It introduces no issuer or transport operation; the existing native stream read/cancel/closed-promise cleanup is unchanged. Global/native coverage flags remain false. Counters and source fixtures do not establish native retirement or approve an ownership registry.

The editor successor extracts the existing connection invalidation and publishes a preadmitted shared terminal view before retiring prior metadata. This changes terminal UI publication and admission behavior, including disposal under allocation pressure. Existing transport bodies/options, abort operations, response cleanup, the asynchronous retirement list and cache/journal close/error handling are preserved. It depends on the final terminal-view `view-models.ts` from the same reviewed allocation assembly. Its publication/accounting fixtures do not prove real transport completion.

## Checks still required on the assembled source

The shared runner's `completion-source` prerequisite invokes `tooling/qualification/completion-issuers/index.mjs --check-source` against the actual assembled sources. The existing issuer preparation rechecks the same boundaries, consumes the current app build and binds the emitted closure. A source-pin match alone supplies no emitted or runtime result. The editor-completion preparation retains its `build-app` dependency.

The classifier still requires exactly eight emitted fetch sites, three XHR constructors, one application Worker constructor, the reviewed option shapes and bodyless fallback GET/send(null), body issuers confined to the main application, and no production keepalive option. None of these requirements is relaxed by source succession. Actual current-build preparation must establish them before dependent browser work.

The supporting reviewed recipe is in `artifacts/validation-workflow-integration-01/runtime/after/tooling/qualification/completion-issuers/index.mjs`; pins02 binds that recipe and the unchanged historical producer identities. This document grants no managed validation result, registry approval, memory/resource qualification, or human review checkpoint.


## Correction71: ordinary observation and Storage Library boundaries

This source-only successor is retained at `artifacts/integration-corrections/completion-source-refresh-71/manifest.json`. Its source review compares every existing boundary with the actual managed checkout after Corrections66 and69/70. Of the twelve prior pins, only `src/state/editor-client.ts` changed: `26f7ef07e3baf221901c013a724a38e133fdefb65ef805b47becce94d6e5a07f` → `27a6405716558542e9a912f999c5fab0a9c97aaf7b6a8bc299830c5f00d34a41`. The other eleven are byte-identical.

The EditorClient delta publishes bounded navigation observations after existing validated model installation, resets them on session/document transitions, and exposes observation forwarding methods. It changes no request URL, method, headers, body, CSRF, signal, response reader, upload, command/draft delivery, retry, or cleanup operation. The associated browser/native/shell observation changes were independently reviewed in the Correction66 packet. They neither issue additional requests nor authorize an action, and do not establish physical presentation or transport completion.

Storage Library adds delegated local request producers. Two additional exact boundaries are now pinned in both the classifier and its independent expected-map assertion:

| Boundary | Reviewed SHA-256 |
| --- | --- |
| `src/ui/storage-library.ts` | `d545b60a0d2cc13707b9d42bd58480693bbf61b533a2269fad0e4ba964878216` |
| `src/ui/model-owner.ts` | `b6e6daa3fc7ec66dc5f5e6a8f193d6d395028326f739a2802bb8e18232346524` |

Inventory/dependency/repair-review GETs use fixed `/api/v1/storage` route families and encoded validated identifiers. `UIModelOwner.read` delegates to `EditorClient.ownedJSON`, the already pinned bounded `readOwnedJSON`/original response reader, and the unchanged Session transport. The Library's POSTs clear only the explicit preview-cache scope or submit the six-field exact-repair request. File content travels through existing `ownedUpload` staging POST/PUT operations; it is not placed in the repair JSON. Session transport still supplies mutation CSRF, same-origin credentials, no-store and redirect rejection. No direct provider traffic, new fetch primitive, keepalive, permission request or automatic repair retry is added.

The Library action remains held by `UIModelOwner.run`; abort/read settlement, typed native-reader cleanup failures, and retired render owners remain reachable through its explicit drain and retry paths. Exact file identity, completed staging identity, original owner/generation and repair-result association are checked before publication. Shell opening, closing and handoff paths preserve the Library owner until cleanup settles, and fence dynamic loading/publication to the current session/document/panel. Shell, control-adapter and both storage DTO files are retained as reviewed enclosing inputs in this packet; they are not represented as new direct browser network APIs.

The classifier now has fourteen fixed source boundaries. Its classification implementation, eight-fetch/three-XHR partition, one Worker constructor, request-option checks, fallback GET/null rules, unknown-issuer and keepalive refusals, and historical producer/manifest seals are unchanged. The existing cheap source verifier checks every map entry, including the two added boundaries. This update does not adopt or rewrite generated application identity/issuer manifests and grants no runtime, memory, browser, native or performance result. Root must rerun the source prerequisite and prepare/audit a fresh issuer manifest only after the matching current build; the failed prior run remains evidence of the old-pin refusal.


## Correction106: committed recovery publication ownership

This source-only successor is retained at `artifacts/integration-corrections/completion-source-refresh-106/manifest.json`, with exact prior/current inputs and the bounded network review in `source-review.json`, followed by independent `peer-review.json`. It governs only Correction102's already integrated `src/state/recovery-client.ts`: `a8c1d5abd96ede4564721818f8d814f5894fe5a91587e597ba00611403c91d8e` → `faf5498835f4de89d0bac8126c72f7e6900883ef0387f5f52753e865408314dd`. The other fourteen current boundary pins are byte-identical. Prior reviews and generated/historical issuer evidence remain unchanged.

The exact delta moves local generation cleanup ownership immediately after successful IndexedDB publication in both SSE branches, before a subsequent pointer read or staged-row cleanup can fail. A nested final cleanup also attempts deletion of a genuinely unpublished generation when stage cleanup rejects. This changes local cache cleanup and preserves the published projection. It adds no fetch, request route, method, header, body, CSRF operation, keepalive flag, transport binding, retry or network cleanup request. Default transport options, supplied Session transport, workspace abort forwarding, original response readers and stream cancellation/retirement are unchanged. The existing recovery release POST remains byte-identical. Observable local cleanup errors remain errors and do not grant transport-completion evidence.

The successor changes one pin literal in the classifier and its existing independent fixed-map assertion. It changes no classifier logic or refusal case. The current post-Correction89/91 contract has fifteen source boundaries, nine emitted fetch sites, three XHR constructors, three sealed-asset fetches (two in the main application and one in the worker), one Worker constructor, and five bodyless CanvasKit fallback sites. These current assertions remain strict; older eight-fetch/fourteen-pin prose above describes preceding reviews. Unknown issuers, unreviewed options, keepalive and bodyful fallback requests remain refused.

Correction102's projection browser result is separate evidence and does not satisfy the completion-source or current emitted-issuer gates. Root must run the cheap source prerequisite, then prepare/audit a fresh issuer manifest against the current verified app build before dependent completion browser work. The unchanged issuer-classification cases and updated fixed-map assertion remain the meaningful Node selection when the owning editor group is next selected; this pin-only successor requires no additional test campaign. The retained run13 refusal remains evidence of the old-pin mismatch. This packet executes no gate, adopts no generated issuer/application identity, changes no sealed text profile, and grants no native, resource, browser-completion or product qualification.


## Correction107: owned empty 204 response consumption

This governed successor is retained in `artifacts/integration-corrections/owned-json-204-107`, with exact original/candidate inputs and network disposition in `network-source-review.json`, joined through `network-targets.json` and independently reviewed in `network-peer-review.json`. It changes only the fixed `src/observability/model-memory.ts` boundary from `53a4c4d4d13aaf41fd9fa98d628f117feb3745867d9b1d6dbd0fb3f2a77b8a7a` to `79d5f368134a38dcc01abdf29d42bff9840c4f42d6e3f8aa3c83864d5e58f118`. The other fourteen pins, including Correction106's recovery publication successor, are retained exactly.

The source change addresses a 204 response exposed with a non-null empty readable body. It supplies an expected length of zero to the existing `readRetainedPrompt`, then returns the zero-payload undefined model only after that reader observes actual zero-byte EOF, unlocks successfully, and the existing current-owner check passes. Any positive body bytes still fail `PROMPT_CONTENT_SIZE`; status alone cannot bypass the body reader or establish completion. The existing null-body 204 case and all non-204 length/JSON parsing paths are unchanged.

The exact `transport(path, options.init)` call, source request producers, URL/method/header/body/CSRF values, signal binding, response preadmission, and caller-controlled model lifetime remain unchanged. The delegated reader's abort, read, cancellation, unlock, typed cleanup failure retention and lease release code is byte-identical; the retained response lease still releases through its existing finally. This is a bounded response-acceptance correction, with no new fetch, route, retry, keepalive or transport binding. Native cleanup refusal remains an error requiring the existing owner to retain and drain the actual resource.

The classifier and its existing independent expected-map test each change only this one literal. All fifteen source boundaries and the strict nine-fetch/three-XHR/three-sealed-asset/one-Worker/five-fallback emitted contract remain intact. Prior source approvals, generated issuer identities and native/browser evidence remain historical. The source review grants no gate or qualification result: root must run the current completion-source prerequisite and prepare/audit a fresh enclosing issuer against the matching verified app build before dependent completion/browser validation. Regression validation for the changed response behavior belongs to Correction107's owning test packet, separately from this source-authority review.


## Correction108: ordered shell, editor and session retirement

The governed source successor is retained in `artifacts/integration-corrections/shell-remount-lifecycle-108`, with exact inputs and disposition in `network-source-review-03.json`, join identities in `network-targets-03.json` and independent review in `network-peer-review-03.json`. It advances two existing boundaries; the other thirteen pins, including Corrections106/107, remain exact.

| Boundary | Prior → reviewed candidate SHA-256 |
| --- | --- |
| `src/state/editor-client.ts` | `27a6405716558542e9a912f999c5fab0a9c97aaf7b6a8bc299830c5f00d34a41` → `f9a9edf2837d510ca3a015a7eb6bb5eebc09ff01f73c769ab1e2b403c26850af` |
| `src/state/session-client.ts` | `003e962b9e0f6cbc809c5007378324b1a758726cc96e9cb0a5880a480baf352c` → `7d134699839c9c260022e736260b8581931d07a8b44d5cac06882c3f702a386a` |

Session local routes, GET/POST choice, protocol bodies, headers/CSRF and fixed same-origin/no-store/redirect-error fetch policy are unchanged. Its action now supplies one captured controller signal through session and capabilities reads instead of consulting mutable active state; existing CommandControlReads cancellation plus ten-second timeout composition remains.

Session publishes a joinable disposal barrier before callbacks, aborts and joins the captured action, resets busy state and retains uncertain capability/publication owners until explicit successful cleanup. This intentionally changes signal selection and cleanup scheduling, not network permission.

Editor connection/disposal joins existing connect/stream/sync/refresh/UI-tail/draft-flush work, fences stale post-await operations and retires exact cache/journal handles. Failed closes remain reachable and block reconnect. Command, upload and draft request construction and the original reader implementations are unchanged.

EditorClient no longer releases its externally owned Session. Shell awaits all captured editor/UI drains before disposing Session, preserving current CSRF for mandatory recovery-release POSTs through unchanged Session.transport. Refused dependent cleanup retains that authority and blocks remount; explicit retry uses failed retained owners. Final Session disposal remains retryable if it fails.

This ordering repairs the source-confirmed early-session-clear cycle where command-result recovery release failed SESSION_REQUIRED and the remount barrier prevented resume. No credential capture, transport-policy exemption or new cleanup route is added. Genuine session expiry or revocation remains an external failure boundary.

Shell remount may execute existing Session/recovery reads after retirement succeeds. Initial pairing uses the existing bootstrap body and ephemeral token; token clears on abort/settlement. Pending start/retry promises are installed before reentrant callbacks. Public renew/revoke callbacks check current connected shell generation and restoration state before dispatch. No automatic uncertain session-mutation replay is introduced.

Existing issuer sites may run after a successful user/remount reconnect; invocation timing, explicit retry scheduling and cleanup lifetimes are deliberately changed and are not claimed unchanged. Unsuccessful native cleanup cannot grant completion.

The classifier and existing independent expected-map assertion change exactly two fixed hash literals. All fifteen pins and the strict nine-fetch/three-XHR/three-sealed-asset/one-Worker/five-fallback assertions and refusal logic remain intact. The shell is required enclosing product context, not a new direct networking API.

Prior source reviews, emitted identities and runtime evidence remain historical. Root must validate Correction108 lifecycle regressions, the current completion-source prerequisite and fresh current-build issuer preparation/audit. This source-only review executes no gate, adopts no generated identity and grants no native, browser-completion, memory or product qualification.


## Correction113: producer-identified text profile loading

The source-only network successor is retained in `artifacts/integration-corrections/startup-profile-projection-113`, with exact inputs and disposition in `network-source-review.json`, target joins in `network-targets.json` and independent review in `network-peer-review.json`. It advances only `src/text/durable.ts` from `85bd32f26331df372374713890f7672e0dafab0a67c8df057e78e880104c3c70` to `6b426048f78f1a95d8a23c9b4e7724ce2774e7a0cc47bea8968b4258a2682d52`. All other seventeen current source pins, including Corrections103/106/107/108/109, remain exact. Older counts and identities above describe their historical reviews.

The manifest reader retains the same fixed same-origin profile asset URL, GET, same-origin credentials, redirect refusal, supplied abort signal, Content-Length bound and original `readTextAssetResponse` reader. It stages the same original response Blob after validation. No fetch, route, method, header, body, CSRF, transport, keepalive or fallback site is added or removed. The server's existing exact-current-profile raw-byte admission remains required.

The old whole-object canonical comparison is replaced by the profile producer's existing identity algorithm: the parsed `id` must equal the current named imported ID, then SHA-256 of `JSON.stringify` of the parsed metadata with `id` removed must equal that same ID. Every metadata field participates. `parseControlJSON` still rejects duplicate keys, invalid Unicode, nonfinite values, excessive recursion and oversized input before native parsing. The check intentionally follows insertion order, as `seal-profile.mjs` and `verify.mjs` already do; a reordered document formerly equal after canonicalization can now be refused. The trusted server serves the exact generated profile asset, so no alternative serialization is required for this path. This is a bounded validation change, not a claim of byte-identical execution.

The digest introduces an awaited hash inside the existing full-Apply reservation and before the retained abort check and staging call. The original 3MiB copy/upload reservation still owns the bounded manifest reader, parsed metadata and hash workspace until handoff. Cancellation, reader unlock, typed cleanup failure retention, generation fencing and realm admission/release code remain unchanged. Digest or stale-owner failure cannot stage the manifest.

Named imports of the existing ID and engine fields in durable preparation, engine in text memory, and fonts in Text Library allow unused profile provenance to be eliminated from executable startup code. Values, font selection and reservation arithmetic are unchanged. The separately reviewed predecessor-retention packet preserves current891a4688 before the official producer reseals the actual final application sources; these source changes do not manually rewrite generated profiles, vendor manifests, native binaries or historical evidence.

The classifier and existing independent fixed-map assertion change only this one source hash. All eighteen pins and strict nine-fetch/three-XHR/three-sealed-asset/one-Worker/five-fallback checks remain intact. Source review supplies no measured size reduction, emitted-build result or runtime pass. Root must run the official text producer/verifier and current type/build/source gates, prepare a fresh enclosing issuer manifest, and execute the focused profile/lifecycle and strict unchanged D11 validation against the final assembled build.


## Correction163: bounded local pending-delivery pages

The source-only successor is retained in `artifacts/integration-corrections/pending-delivery-pages-163`, with exact inputs and disposition in `network-source-review.json`, independent core review in `core-peer-review.json`, and companion pin review in `network-peer-review.json`. It advances only `src/state/editor-client.ts` from `e8034959552c5121aa967d1f97dbf39830214987d1cc67324f5bafe737519331` to `f6e6e766e812011af95158a3e075aff0f3924304cf24b6999fcaeaeecec86748`. The other seventeen governed source boundaries and fourteen opaque-upload source identities remain exact. Historical approvals and generated issuer evidence are retained unchanged.

Recovery already stores the exact original request bytes for every discovered pending command. This change replaces refusal at a thirty-third unresolved local record with bounded keyset navigation: at most thirty-two visible deliveries, one unretained lookahead, bounded cursor scalars, a reverse previous-page scan and first-page fallback after an emptied range. An independent existence probe keeps unresolved document creation blocked even when its original command is off the visible page. Page rows and navigation metadata publish atomically only for the matching read generation, lifecycle, journal and session owner; failed or superseded reads retain the previous complete view and original journal records. Native IndexedDB record-size admission, clone uncertainty, transaction settlement, abort and cleanup authority are preserved. No total pending inventory or cursor history is retained.

Local page navigation issues no network request. Recovery discovery, command lookup and retry retain the same routes, methods, headers, CSRF, original command identity and exact saved wire. The owned command and delivery paths pass their existing tracked signal into the local page refresh; independent navigation uses the existing CommandControlReads admission and drain. This avoids an additional nested reader slot while keeping disposal responsible for all pending reads. The create path captures and rechecks its control owner across the new asynchronous global existence probe before constructing a command. These are deliberate local read scheduling and ownership changes; no transport reader or completion claim is introduced.

The JSON helpers, opaque upload implementation, response readers, fetch/XHR sites, keepalive refusal, transport policy, original upload/file roles and recovery-release operations are unchanged. The eighteen-entry classifier and its independent expected-map assertion each update only this source hash. The existing fifteen-entry opaque campaign approval updates only the EditorClient hash and byte count. The strict nine-fetch/three-XHR/three-sealed-asset/one-Worker/five-fallback contract is unchanged. The shell, new-document guard, BrowserJournal and view metadata are enclosing reviewed application changes, not additional network APIs.

This source review executes no validation and grants no browser, native, resource or completion qualification. Root must run the current type/source gates, affected whole-file Node regressions, actual app build and unchanged D11 ceiling, fresh current-build issuer preparation/audit, and the complete recovery browser family including all forty original commands and a page-two exact-wire retry. Earlier scoped results do not prove these changed local recovery and control lifetimes. The five changed product files are outside the current text-profile source recipe, so this packet does not reseal or edit generated profiles.


## Correction178: navigation publication and bounded resource observations

The final joined source review is retained under `artifacts/final-source-union-01/governed-network`; its source-review receipt binds the H1 semantic component, the independently reviewed R35 product component, and the exact combined BrowserPhases source. The prior source approvals and generated issuer evidence remain unchanged.

| Reviewed source | Exact predecessor and successor SHA-256 |
| --- | --- |
| `src/state/editor-client.ts` | `f6e6e766e812011af95158a3e075aff0f3924304cf24b6999fcaeaeecec86748` → `a6724c187618d422bbf913946bba65fc1cbe3cae26458c66176e05f5fa5a26b9` |
| `src/observability/allocations.ts` | `273e3745edf95b948581b9e7bec197b3e6cba64b2ceb0033f8a3edb34a3b161b` → `95ea4f1dd0e6cba1cce3950d48df473d78168a76cd5c2bc16d5e83c92ab16e9d` |
| `src/observability/diagnostic-memory.ts` | `d25f69b5d6d9d4d031bd55eaeeb912ad6ca5df84a05e8c33dba7a74d41292138` → `1c0fb3ff0c1ea0e346106d84ca6f561cf1a097fb1ec355f96ff49429318d27cf` |
| `src/observability/browser.ts` | `a475742e19350564ffb81f5c3fd81796d2864c215e84a2b296141d056cae49ce` → `bf2d6fa12ae6de9e8d13405574643e664b32fed12ff57d697b6eaacd9c9bc2a1` |

EditorClient now records bounded synchronous state-publication and accepted-checkpoint evidence. The explicit Open completion message waits for preference settlement and the current session, owner, document generation and installed image; automatic recovery keeps its recovery status. These observation calls follow the existing command-result, recovery and draft-owner settlement. No request URL, method, body, CSRF header, response reader, abort signal, upload role, stream or recovery-release path changes.

R35 adds fixed-capacity, centrally charged observations of reservation transitions and a synchronous realm-local text-pool bridge. BrowserPhases exposes scoped observation windows and one owned snapshot read, and its joined disposal releases both the H1 status owner and R35 text read owner. The existing allocation limits, network cleanup helpers and opaque-upload path remain unchanged. Observer totals describe owned reservations; they are not physical RSS/GPU measurements or permission to send data.

The two classifier source declarations and their independent expected-map entries advance only EditorClient and allocations. The fifteen-entry opaque-upload declaration advances those two sources plus BrowserPhases and diagnostic-memory with exact byte counts. All other declarations and strict nine-fetch/three-XHR/three-sealed-asset/one-Worker/five-fallback assertions remain unchanged. No generated application identity, issuer manifest, text profile or historical result is authored by this review.

After the complete source union is applied, root must run the official text profile producer/verifier on its frozen declared inputs, then current type/source/build gates and the non-adopting completion-issuer producer against the actual generated build. The startup owner derives D11 from that real post-profile source corpus. Existing issuer, navigation, resource and opaque-upload regressions and the selected browser/campaign gates remain required; this source review supplies no runtime or qualification result.
