# Design System Integration — en-reve

Assembly revision **DS-1.1+A1**, 2026-09-26 UTC. Approved technical baseline: **DS-1.1** with accepted Spec addenda. SPEC-A2 is independently approved for specification/source readiness at technical commit **083579cdb1bfd24e3fdb64f4f051524393e50861**, as recorded in the [final approval](approvals/769bd9b2-f482-41fa-abc8-0bee99d453ef-SPEC-A2.md). This is a metadata-only approval closeout; the technical section revision is unchanged. Underlying source approvals remain in the [index](index.md#source-versions-and-approvals). No application, provider or performance qualification is claimed.

[Technical Specification](index.md) · [Traceability](index.md#requirement-traceability) · [Owned qualifications](index.md#qualification-register) · [Exact pre-assembly source and history](history/bf7b9cc0-391c-4fce-97a8-5da1a660a4a2.md).

Current policy: one style per text box, explicit Apply/Cancel, explicit field links between separate Layers and Composition lists, and previewed font substitution are accepted. Engineering choices and performance ceilings remain proposals requiring qualification. API facts retain their original evidence date and class.

This section specifies a separate Lit editor application consuming en-reve as UI infrastructure. It does not implement the editor or change the design system. The [accepted operation policy](index.md#accepted-decisions) remains authoritative: explicit operation and attachments determine compatibility; preserve incompatible drafts; freeze submitted versions; never silently discard context or switch models.

API evidence update (DS-1.1): use the accepted policy note’s 2026-09-25 provider-evidence addendum and Task 1’s final endpoint-specific constraints. The coordinator verified dedicated image-to-image/lora and inpaint/lora routes; the UI must permit the compatible source/adapter and source/mask/adapter operations after validation. The initial six-route inventory is not a family boundary. Fast, Instant, tiling and streaming semantics remain distinct and belong to Task 1’s reference. This integration section contains no family-wide source/mask+LoRA prohibition; its command and frozen-input rules apply to every eligible route. This paragraph records the coordinator’s evidence handoff, not an additional API audit by Task 2.

<a id="s1"></a>

## 1. Evidence identity and limits

Source repository inspected: /Users/westbrook/Documents/repos/design-system. HEAD: `6d09b31cf43523ac8c75352208ab9697b62e2673`, committed 2026-09-23, “test: seal scoped-registry main integration evidence.” No Git remote was listed. All source paths below are relative to this repository, not to ideogram-edit. The absolute path identifies the audited local source only; it is not an installation requirement.

**This is a working-tree audit, not a claim that HEAD alone reproduces everything described.** The checkout has extensive modified/untracked package, docs, tooling and test files. Current package versions are all private 0.1.0; those numbers do not distinguish snapshots. No upstream edits, builds, installations, live provider calls or application tests were performed. Behavioral tests were read, not rerun; old verification receipts retain their original scope.

Identity anchors (SHA-256 of bytes read):

| Source | Digest | Relation to HEAD |
| --- | --- | --- |
| package.json | a34853a850b90ee812c15b8b31c60e18fd516625b98c01b0b3355fcde84bc0bd | Modified |
| package-lock.json | 495784328f6a3e500e0fd40726377b650a978f290554305edb4bf6c29be4e622 | Modified |
| packages/elements/public-api.json | 71980beca2a69afee31adf526ff34261de4772e4ef198efacaa4d3daf100a088 | Modified |
| packages/elements/custom-elements.json | ef15177573ae327736d5627b9bcf0d41ec90741208b0461a8850bf873f8a3efc | Modified |
| packages/elements/public-types.json | 89335e5dddbeb3c3d9d12e4b33b429cb055b6e976a52030986aeb6414ef28c55 | Modified |
| packages/primitives/src/interactions/events.ts | 0d4a8948ca160189c50b8349c8b34b27bd911c09f29bdf30369b15de41c866b9 | Unchanged |
| packages/primitives/src/state/draft.ts | df2e3e8869177fd482da605350f366615c0ed4e7a0a607f59984efee7d35a441 | Unchanged |
| packages/elements/src/forms-private/form-field.ts | 0962086c61c18e98818ed658aaab8efe76f5204af42aff0e3b340e1efafffc49 | Modified |
| packages/primitives/src/interactions/virtual-collection.ts | 22ce815d1bbe6f0977f586655f0d0e0131664efbb72e391a9aa3c6a9ca708041 | Modified |

The 1,831-file audit identity corpus (tracked plus nonignored untracked files under packages/elements, primitives, styles, tokens, ssr, apps/docs, tooling, plans, plus root package/lock/tsconfig; excluding dist, node_modules, results, test-results and playwright-report path segments) hashes to `3afd03c9ef47c11d031e0b73710416ece2fd1402910efe21e26147cf97aab6b9`. Algorithm: sort unique relative paths; SHA-256 each file; hash newline-terminated records `path + NUL + hexDigest`. This detects snapshot drift; it is not a saved source archive or proof of reproducible output. Final verification observed the same 1,831-file corpus at digest 3d058d0aa84a70f9bfc2c886e7dc124d2e35bd6ac7a166f5095fef6398c7dbb3 while HEAD remained unchanged. The nine identity anchors in the table were rehashed and all remained identical. Other upstream work changed the broader corpus during this audit; this note does not claim one immutable whole-tree snapshot. Seal and requalify the selected source when producing packages.

Relevant working changes include field hydration default-value preservation; dialog description semantics/template; range/choice/selection behavior; rich/token editor and clipboard/extension behavior; virtual collection geometry; SSR choice-description projection; style/control/theme authoring refinements; regenerated element metadata; and replacement test orchestration with untracked tooling/testing modules. The field change explicitly detaches native live value before changing defaultValue; the SSR change preserves descriptionAssigned. Qualify these behaviors on the delivered archive, not just HEAD.

Plans provide intent and history. For example, older registration prose in plans/architecture.md says split-view closure is missing, while current definitions and tests implement dependency closure; an older tree README paragraph excludes lazy loading/reorder, while its later contract, public types, implementation and tree-operations tests implement them. Use the current public metadata plus implementation/test evidence below. Do not import a capability merely because a plan names it.

<a id="s2"></a>

## 2. Public dependency and import contract

| Package | Actual public boundary | Adopted use |
| --- | --- | --- |
| @en-reve/elements | Root class/type barrel; supported top-level `<component>.js`, `definitions/<component>.js`, `define/<component>.js`; additional entries enumerated in public-api.json | Named controls, explicit definition registration, lazy feature groups |
| @en-reve/primitives | `state/*.js`, `interactions/*.js`, `templates/*.js`; no root export | Signals models, controller lifecycle, collection and native template helpers |
| @en-reve/styles | Explicit family JS/CSS export map; root JS exports named style results | Lit static styles or explicit CSS for app-owned native markup |
| @en-reve/tokens | Root pure utilities, defaults/source/sizing/color/overrides/customization/properties entries, default.css, themes/*.css, tokens.json, manifest.json | Shared theme and sizing; build-time coordinated customization |
| @en-reve/ssr | Root renderToString/renderRequest; install.js; scoped.js; client.js | Optional shell/control rendering, only when selected below |

Evidence: five package.json files, elements/src/index.ts, elements/public-api.json policy/entrypoints/components, primitives/README.md, styles/src/index.ts, tokens/src/index.ts, ssr/src/index.ts. Current metadata enumerates 96 custom-element declarations and 531 entrypoints including unsupported internals. These counts are inventory, not proof of uniform maturity.

Elements' wildcard export makes many deep files technically importable. Its public-api policy explicitly labels other deep imports unsupported implementation details. Consumer code must not import `forms-private`, `internal`, private templates, dist paths, docs code or repository tooling. Use public types/metadata to check properties, event maps, slots, Parts and attributes, then compile the consumer against packed declarations. Metadata can lag source and must be regenerated/checked by the package producer.

Exact audited runtime dependencies: Lit 3.3.3; primitives peers signal-polyfill ^0.2.2 and signal-utils ^0.21.1 (root locks 0.2.2 and 0.21.1); elements uses @lit/context 1.1.6 and ProseMirror packages; SSR uses @lit-labs/ssr 4.1.0, ssr-client 1.1.8 and parse5 8.0.1. Avoid importing the elements root barrel in the startup graph: optional text-editor dependencies and the complete catalog are unnecessary for the first usable canvas. Type-only imports must remain type-only.

<a id="s3"></a>

## 3. Control inventory, behavior and application gaps

All class imports in this table are `@en-reve/elements/<name>.js`; their corresponding explicit descriptor imports are `definitions/<name>.js`. The public metadata maps each tag to the named class, source, members, events and customization surface.

| Surface / public exports | Implemented contract and editor use | Evidence and limits |
| --- | --- | --- |
| EnButton; EnTextField, EnTextarea, EnNumberField, EnSelect/EnSelectOption, EnCombobox, EnCheckbox, EnSwitch, EnSlider; EnValidationSummary | Native-backed command buttons and property/prompt fields; form participation, draft/accepted value distinction, validation, reset and silent author writes. Use numeric controls for strength/seed/opacity with app endpoint validation. A combobox query is not a selected asset identity. | elements/src/forms-private/form-field.ts and form-controller/editing-controller primitives; forms-private/tests/forms.spec.ts explicitly asserts tentative FormData/validity and retained canceled text; apps/docs/tests/selection.spec.ts exercises explicit selected ID versus unfinished query. API validation, unit conversion and compatibility remain app-owned. |
| EnToolbar, EnMenu/EnMenuItem, EnCommandPalette; optional EnMenubar, EnContextMenu, EnActionOverflow | Toolbar automatic roving focus supports direct native/en-button children; explicit keyboard-navigation=tab gives a named group for mixed fields/sliders. Menus use same-root external triggers, cancelable actions, nested/checkable choices and distinct open changes. | toolbar/element.ts + README; menu/element.ts, menu-item/element.ts, commands/tests/commands.spec.ts; public top-level pattern entries. Displayed shortcut hints install no shortcuts. App registers commands, eligibility, shortcuts, loading and outcomes. Do not bind both native click and en-action for the same command. |
| EnDialog, EnDrawer, EnPopover, EnTooltip; optional EnSheet | Native modal/popover surfaces remain in theme ancestry. Tentative open changes settle before owned native top-layer/focus effects. Same-root literal for identifies a native/en-button trigger. | dialog/dialog.ts, dialog/template.ts, dialog/tests/overlays.spec.ts and modal-for.spec.ts; SSR browser tests. App owns unsaved-work policy, confirmation content, failure state and fallback focus if opener is removed. Unexpected completed native close is reconciled silently, not a retrospectively vetoable document event. |
| EnTree/EnTreeItem, TreeDataItem, TreeMove | Parent selectedKey/selectedKeys/expandedKeys are canonical; legacy value/values/expanded aliases remain. Data items have unique nonblank keys; data and authored modes are exclusive. Virtual data trees, multiple selection, lazy branches and reorder are implemented. en-reorder is a before-mutation proposal, unlike tentative en-change selection/expansion. | tree/element.ts + tree-operations primitives; apps/docs/tests/tree-view.spec.ts, tree-data.spec.ts, tree-operations.spec.ts include veto, lazy abort, moves and unmounted targets. Tree owns focus/hierarchy, not layer semantics. Data labels are plain text with no renderItem; authored labels permit noninteractive rich content, not inline visibility buttons or name fields. Use an adjacent layer inspector/actions or an app-owned accessible list composition for rows needing controls. No checkbox propagation. |
| EnSplitView, EnSplitter; SplitPane/SplitCollapsed | Two panes, percentage value, keyboard/pointer resize, RTL, bounds, collapse/restore. en-change resizes; separate tentative en-collapse changes visibility. Hidden panes retain nodes with hidden/inert. | split-view/split-view.ts, definitions/split-view.ts; apps/docs/tests/split-collapse.spec.ts asserts cancellation before geometry/focus, equal author writes, node retention, RTL and keyboard restore. App composes nested splits and owns breakpoint/orientation, saved layout and canvas resizing. |
| EnColorField, EnColorPicker, EnColorPlane, EnColorSlider, EnColorWheel, EnSwatch; ColorValue helpers | Literal sRGB/Display-P3 and immutable colorValue; parseColor/serializeColor/convertColor/inGamut/exportSRGB/colorPaint are public. Plane/wheel previews use en-input; release proposes a semantic change. Named scalar controls/exact fields provide alternatives to pointer color selection. | color-picker.ts facade, color-picker/color-value.ts, plane/wheel implementations; color-picker tests and apps/docs/tests/color-plane.spec.ts, color-picker.spec.ts. App owns Apply/Cancel, undo grouping, brush color and image export color/alpha policy. Picker support for P3 is not proof of color-managed raster compositing. Swatch is an action, not a built-in clipboard or color-setting command. |
| EnFileUpload, FileSelectionReason/FileRejection types | Form-associated file selection/drop/removal; immutable File[] projection; local batch constraints; cancelable en-change and noncancelable en-reject. Selection replaces rather than appends. | file-upload/element.ts, README, apps/docs/tests/file-upload.spec.ts. No transfer, content decoding, previews, authentication, durable storage, directory traversal or clipboard ingestion. App validates bytes/MIME/dimensions and stages durable assets; File references are not persistent asset IDs. |
| EnActivityFeed/EnActivityItem; ActivityRecord, ActivityPage, ActivityLoadRequestEvent | Application-owned keyed history presentation; all/paginated/virtual modes; buffer/reveal and older-page requests. respondWith is claimed synchronously; request signal and stale-result guards bound component loading. en-load-state-change is an applied-state notification. | activity-feed.ts and apps/docs/tests/activity-history.spec.ts: bounded DOM, key/offset/node retention, full page reading, canceled late loads. No event store, document undo/redo, job journal or audit authority. Do not reinterpret display order as event-log sequence. |
| VirtualCollection, VirtualCollectionController, virtualListRows/virtualTableRows; EnTable/EnDataTable | Public primitives split pure keyed state, connected browser measurement and semantic rendering. getKey is canonical; key is a compatibility alias. Measurement/focus retention, explicit pin/unpin and scrollToKey are supported. | primitives/state/virtual-collection.ts, interactions/virtual-collection.ts, templates/virtual-collection.ts; virtual-collection and virtual-rendering Node tests; docs/virtual-collection.md. Virtualization bounds DOM, not input records. Vertical layout only; app owns selection, sorting, records and data access. Theme/font/density changes require invalidateMeasurements for offscreen estimates. |
| EnTokenEditor, EnRichTextEditor, EnEditorTrigger, EnEditorToolbar, editor-extensions types | Optional prompt authoring: text/token document, local selection/history, extension sessions, explicit command and composition contracts; rich text uses ProseMirror. | top-level facades, token-editor/element.ts, rich-text-editor/element.ts, editor/extensions.ts; probes/api-outcomes/outcomes.spec.ts and api-transactions/transactions.spec.ts; composable-editor plan is context only. These are text editors, not a raster/image engine. Start with EnTextarea; add token/rich features only for a defined UX need and bundle budget. |

**App-owned graphics gap:** document/layer/asset identities; canvas/WebGL/worker choice; decode/encode; pixel buffers; coordinate transforms/DPR; zoom/pan; selection/masks/feathering; brush gestures; compositing/blending; crop/resize; source/mask alignment and polarity; thumbnails; export; durable undo/replay; result placement; provider jobs. None is supplied by en-reve text/token editing. Canvas must have app-designed keyboard/numeric alternatives and meaningful DOM status; a generic role or aria-label alone does not make pixel editing accessible. Tasks 3/4 define the raster contract and Task 5 tests it.

<a id="s4"></a>

## 4. Application state, draft and command boundary

Use Lit for view composition and Signals for synchronous read models. Public `createValueModel`, `createSelectionModel`, `createDisclosureModel`, `createDraftModel` live in primitives/state entries. `SignalController` is exported from interactions/signal-controller.js: subscribe on connection, coalesce Lit update requests, unsubscribe on disconnect, reread on reconnect; dispose permanently removes the controller. Do not dispose a shared model when one view leaves.

There is one authoritative application document writer (Task 4 specifies its durable transaction mechanism). Signals expose derived immutable snapshots, not a second mutable document store. Distinguish:
- document events and stored asset versions;
- operation/inspector drafts and gesture previews;
- UI preferences/selection/expansion/focus;
- external job observations and user result adoption.

Component state is a projection or local draft. A tree selecting a layer does not select pixels or implicitly attach that layer to an inference request. Expanded branches and DOM focus are separate from selected layer keys. Persist only the categories deliberately selected by Task 4; do not append every pointer or native composition sample.

Models increment revision when state changes. Component author authority increments on every explicit property write, including equality. Those are different counters. Route every application projection write through one adapter-owned function that also invalidates pending proposal generations, including resets, same-value echoes, document switches, selection changes and disposal. Do not reach into private author-revision fields. Replace arrays/objects; shallow readonly snapshots are not deep-frozen application values.

### Exact library event semantics

`dispatchChange` from primitives/interactions/events.js stages coherent tentative property/model/FormData, emits one synchronous bubbling/composed cancelable `en-change` with shallow-frozen {previous, proposed, reason}, checks remaining ownership and optional canCommit, then finalizes. Outcomes: committed, unchanged, canceled, superseded. Object.is no-op skips dispatch. Only still-owned staging rolls back. Author writes and accepted nested transactions supersede the outer action; canceled inner attempts do not. A finalization exception may leave accepted state. No controlled mode, en-request-change, post-commit notification or asynchronous settlement API remains.

`dispatchDraftInput` emits noncancelable en-input; it is a draft observation. `dispatchAction` emits en-action and returns a dispatch result, not the command or remote result. Named page/collapse/reorder/load channels retain their own contracts. Filter origin with composedPath and the expected host; descendant events intentionally cross shadow roots.

### Selected application adapter contract

The editor uses **staged drafts with explicit application command acceptance**. It does not persist or send an API request from a control's tentative event.

1. At a known host, an en-change listener verifies origin and synchronously applies cheap eligibility checks. It captures a detached, validated proposal plus document ID, expected document revision, target IDs, field/draft generation and owner lifetime. If invalid, cancel immediately. Never capture FormData as a committed request during this event.
2. For ordinary draft edits, schedule reconciliation after the dispatch stack. Check the final event.defaultPrevented, connection/lifetime, current application generation and settled public property. A later veto or newer authority invalidates that candidate. A microtask is only a scheduling boundary; equality alone is not evidence of component acceptance. The app may reconcile the **current settled value** into an ephemeral DraftChanged command after revalidating it; it must not infer a durable document mutation from a component outcome. If ownership is ambiguous, keep the authoritative draft and show/reconcile it rather than dispatching work.
3. DraftChanged is accepted by the app draft reducer, producing an application-owned draft event/view and a silent property update. This event is not durable document acceptance. Invalid text remains editable with feedback; do not overwrite the native draft on unrelated renders.
4. Apply, Generate, Import, Move layers or another explicit action creates the document/job command from current app draft and explicit attachments. For menu/palette en-action, defer until full dispatch completes and check final cancellation; await the surface's updateComplete/accepted dismissal only when that command's focus policy requires dismissal. Native buttons use one click/submit path. Revalidate eligibility and expected revisions immediately before application acceptance.
5. The authoritative writer validates and accepts/rejects the command. Only successful durable append/transaction produces the authoritative accepted document/job event; a Signal projection then silently updates properties. Storage failure leaves the prior authoritative document, preserves the draft and shows retry/recovery. Pending projection is labeled pending.
6. Provider submission belongs to the accepted job/outbox workflow, outside staging/rollback and render. It receives frozen source/mask/adapter/settings versions. Queue acceptance, provider completion, durable result storage and user adoption are distinct. Remote failure updates job feedback and preserves the document/draft; no compensating property write may overwrite newer work. Replay never triggers dispatch.

For a field requiring asynchronous approval **before its local default is allowed**, cancel en-change synchronously before awaiting anything. Preserve the proposed draft and create a separately identified application validation request. On response, check request ID, field generation, document/target revision and live owner; then explicitly accept an app command and write the authoritative property. This is an app-owned deferred workflow, not eventual acceptance of the canceled DOM event. Use one adapter owner and central validation rules: independent late DOM veto listeners cannot distinguish the adapter's own preventDefault from another veto. Do not use that canceled event as a shared asynchronous voting protocol; additional rules must reject the application request/command. Ordinary post-dispatch draft observation above still honors late DOM vetoes.

Layer reorder is intercepted synchronously at en-reorder and canceled when the application owns hierarchy. Copy its key/target/position proposal into the explicit Move command workflow. Only application acceptance replaces tree.items; never persist the component's temporary hierarchy as the document. For local-only expansion, menu-open or splitter preference, component default may settle and the app can record the settled UI preference without a durable document event.

Evidence: events.ts implementation; primitives/tests/events.test.mjs tests late veto, equal author write, accepted/canceled nesting, revalidation and exceptions; forms-private/tests/forms.spec.ts asserts tentative FormData then rollback while native text remains; apps/docs/src/workflows/settings/index.ts queues menu actions, checks generation/dismissal and preserves newer local edits after save failure. The docs workflow is useful consumer evidence, not the editor's durable architecture.

### Required walkthroughs

| Case | Observable result |
| --- | --- |
| A→B proposal, later listener cancels | No app document event, no upload/API call; component rolls back owned accepted/form state. Native text draft may remain B with validation guidance. |
| A→B, author writes C or A during dispatch | New authority wins even when numerically equal. Adapter generation invalidates old queued work; no rollback of C/A. |
| Outer B, nested C accepted | C supersedes outer default/rollback. App reconciles latest eligible settled draft; outer candidate cannot issue work. |
| Inner C canceled, outer B accepted | Library restores B and can accept outer B. App reads settled state; no command is inferred merely from seeing both events. |
| Async validation for B, then C/reset/document switch/dispose | Abort B where possible; ignore its late completion even if abort is ignored. Preserve C/reset state. |
| Composition start → intermediate input → final composition | Intermediate en-input updates preview only; do not submit, shortcut-dispatch or make document undo entries. Semantic completion is deduplicated. An author write during composition defers draft reconciliation and wins at composition end. |
| Apply accepted locally, remote generation fails | Accepted submission/job state can remain; document raster is unchanged. Error/retry is visible and frozen request provenance retained. A retry is an explicit command under Task 4 deduplication rules. |
| Generation succeeds after cancel, deletion or revision change | Keep result as job/asset evidence; never silently write into current layer/document. Explicit adoption revalidates target and expected revision. |
| Reversible stage/rollback or observer reads FormData | Zero provider calls and zero durable writes. Captured tentative reads cannot be retracted, so they are not submission authority. |

<a id="s5"></a>

## 5. Forms, editing, lifecycle and accessibility

Use native-backed form controls and their public label/description/error/validation APIs. FormController is a public low-level adapter; the private FormFieldElement is not an app base class. Accepted submission values and editable drafts may differ. Native reset restores the documented baseline silently; app document Reset is a separate command. If needed, preventDefault on the outer native reset event before taking over. Form restoration is an authoritative silent lifecycle write, not a user event; disabled/read-only guards must not block restoration.

EditingController (interactions/editing-controller.js) preserves native editing, selection and composition. For app-owned native controls using it, do not separately bind live .value in the Lit template; call model.setValue plus editing.sync only for an authoritative update. Its hydrate/input/change/compositionend callbacks still require the consuming pattern's semantic policy. Detaching an editing surface ends an orphan composition without inventing acceptance. Synthetic IME tests do not establish physical IME, dictation or autofill compatibility.

App elements use a distinct `ie-` prefix; `en-` remains the library namespace. Prefer composition over subclassing components or cloning shadow DOM. Use `declare` for Lit reactive fields with static properties and useDefineForClassFields; stable keyed repeat rendering preserves identity. Own listeners with AbortController/disposers; stop observers, animation frames, preview workers and pending callbacks on teardown. Reconnection reads current state. Register document-level shortcuts only within the active editor scope; respect defaultPrevented, composition and native text editing.

Theme entry: load tokens/default.css before first paint. Root data-en-appearance=auto/light/dark controls appearance; named themes use data-en-theme with the corresponding theme CSS after defaults. Comfortable is the initial density; offer compact/spacious through a complete chosen/generated theme, not invented data-en-density behavior. resolveTheme/emitThemeCSS or createThemePair/emitThemePairCSS at build/configuration time support coordinated graph changes. CSS seed overrides alone do not recompute resolved derived colors. Full scopes reset registered optional style overrides; partial overrides retain inherited pins.

Default size is medium without an attribute; small/medium/large are absolute roles; size=inherit is explicit. Density affects geometry, not typography. Use public --en-* names from manifest/customization contracts, public Parts and slots; never private selectors. Use styles family JS in static styles or CSS recipes for native app markup. Keep graphics-specific CSS local while deriving shell surfaces, spacing, type and focus from tokens.

Set lang/dir at the application boundary and localize each documented label/message, including splitter pane names, menu Back, errors and progress. Direction flows through logical CSS and control navigation; do not manually reverse library key handling. RTL UI does not implicitly mirror document pixel coordinates. Keep modal/popover content in its theme tree. Invalidate virtual measurements after font/density/theme changes.

Required consumer review: accessible names; keyboard-only toolbar/menu/dialog/tree/splitter paths; focus restoration and removal; 200% text/zoom/reflow; contrast on actual surfaces; coarse-pointer targets; forced colors; reduced motion; RTL; physical IME and supported browser/AT combinations. Library token defaults (24px minimum target role, 2.75rem coarse role) are starting constraints, not accessibility certification. Provide complete/paginated reading alternatives to virtual history; a known VoiceOver virtual collection traversal report remains unresolved in primitives/docs/virtual-collection.md. DOM-derived ARIA snapshots are not native screen-reader evidence. App owns non-color-only mask feedback, announcements and useful keyboard/numeric canvas alternatives.

<a id="s6"></a>

## 6. Registration, lazy loading and cleanup

Selected delivery: eager selective registration of startup controls in one app scope; optional feature panels loaded on explicit intent. Use createElementScope({document, registry:'auto'}) from elements/element-scope.js, pass scope.creationScope to Lit render, and create/attach roots through the scope. Auto probes real behavior and falls back to the owning global registry. Explicit unsupported/foreign registries error; existing global-associated nodes cannot be rebound as scoped nodes.

Import e.g. treeDefinition from elements/definitions/tree.js and call scope.register. Descriptors include required dependency closures; registerDefinitions/registerDefinition (primitives/interactions/registration.js) preflight constructor conflicts and register dependencies first. Repeating the same constructors is idempotent; conflicting constructors throw. Native registration cannot be rolled back. The global define/<name>.js entry is side-effectful and is only for deliberately global delivery; do not mix it into scoped class/descriptor modules. Do not rename library tags or assume multiple incompatible versions work in a global fallback.

createElementLoader from elements/lazy.js uses the generated allowlist. load fetches/evaluates without registering; ensure imports complete closure then registers; ensure does not mean render-ready. Imports share across scopes while registration belongs to the target registry. Failed imports need explicit retry, subject to browser module caching; failed registration is not undone/retried as if clean.

createElementActivation from activation.js supplies load/activate/cancel/dispose and an app-provided ready(root, signal). Native group/dormant policies require correct registry association; global fallback requires an empty native root plus trusted inert template. Do not put essential startup controls in a dormant failure boundary. Readiness waits for actual component updates and focus/layout needs; cancel does not unimport modules or unregister classes; dispose cancels pending work and releases references, not app DOM. App shows loading/error/retry state and disposes on route/panel teardown.

Evidence: element-scope.ts, lazy-loader.ts, activation.ts, definitions/tree.ts/dialog.ts/color-picker.ts; primitives/tests/registration.test.mjs; probes/lazy-registry/loader.test.mjs and lazy.spec.ts. Those tests check shared imports, conflict preflight, failed imports and separate registries; qualify supported browsers using app fixtures with the packed dependency.

<a id="s7"></a>

## 7. Reproducible private-package consumption

**Decision: vendor immutable npm package archives in the separate editor repository**, produced from an explicitly identified en-reve source snapshot. No npm publication, shared-workspace membership or absolute sibling path is assumed. This has an intentional binary-diff/repository-size cost; it gives an ordinary clean checkout the precise private packages without a new registry or access to the author's computer. Local symlinks are an optional development aid, never release/CI inputs. A Git submodule/checkout-build was considered but would require a portable accessible origin and source toolchain on every consumer install; none is established here.

Planned layout: vendor/en-reve/<snapshot-id>/ with four runtime .tgz archives (tokens, styles, primitives, elements), optional ssr archive, source/provenance manifest and license notices. Keep full source/build provenance in a retrievable immutable archive or reachable source commit; a digest alone cannot reconstruct dirty inputs. If the selected source includes working changes, the producer must preserve those exact changed/untracked source bytes and lockfile, or first use a future committed snapshot. Do not label the audited working tree as the clean HEAD release.

Producer workflow (future authorized packaging work):
1. Copy/export a frozen source snapshot into an isolated directory. Record HEAD, full source content digest, dirty patch/new-file archive, lockfile hash, Node/npm/platform and build command identities. Reject source changes during the run.
2. Use the snapshot's declared Node/npm engines and npm ci. Audited root requests Node ^24.21.0 or >=26.10.0 <27 and npm >=12.1.0 <13, packageManager npm@12.1.0. Pin one exact toolchain per receipt; do not borrow the author's .toolchains path.
3. Build tokens → styles and primitives → elements → metadata; build SSR only if consumed. Public commands include npm run build -w @en-reve/tokens/styles/primitives/elements, npm run metadata, npm run build -w @en-reve/ssr. Root npm run build additionally builds docs. Verify declared dist files and metadata correspond to the same frozen source.
4. npm pack each chosen workspace into a fresh destination. Retain package name/version, filename, npm integrity/shasum and independent SHA-256 for each actual archive, plus dependency/peer graph and producer receipt. Never pack stale dist from the live workspace.
5. In an isolated editor fixture, install only these archives and normal locked third-party dependencies; compile public imports, bundle and run integration gates. Pack all internal packages as a coherent set, because their private transitive dependencies still name 0.1.0.

Consumer manifest declares all four @en-reve packages directly with **relative** file:vendor/en-reve/<snapshot-id>/<archive>.tgz values. Add SSR only when needed. Their internal 0.1.0 requirements must resolve to that same root set; commit package-lock.json with file locations/integrities and exact third-party resolutions. Add exact compatible Lit/Signals peers. Audit npm ls --all and lockfile paths: fail if an @en-reve package resolves from a registry, sibling checkout, nested mismatched snapshot or absolute path. A future app script verifies archive hashes before npm ci. Do not assume semver 0.1.0 alone proves identity.

Clean CI sequence: checkout editor including vendor artifacts → verify vendor manifest/hashes → select pinned Node/npm → npm ci → npm ls validation → typecheck/build/app-owned tests. No design-system checkout, registry publishing credentials, design-system node_modules or machine-local browsers/toolchains are required. CI installs the pinned Playwright browser revision into its own cache. Normal public dependency network access remains necessary unless separately cached.

Local feedback loop: a developer explicitly supplies a design-system source path to an app-owned packing script; build/pack in isolation, create a new content-named vendor directory, update relative dependencies and lockfile, reinstall, restart Vite if dependency optimization requires it, then run targeted browser/adapter tests. Never overwrite an archive under an unchanged identity. Do not commit a development link or source alias. Before promotion, run the same clean packed installation in an empty temporary checkout. Upgrade all coupled package identities together and review metadata/API diffs.

Evidence precedent: probes/scoped-registry/prepare-packed.mjs compiles/bundles extracted archives, but symlinks third-party packages from the upstream workspace; it is **not** clean-install proof. tooling/evidence/prepare-packages.mjs/packed-setup.mjs can prepare actual archives in the source repo but are not exported consumer APIs. No archives or consumer lockfile were produced in this notes-only task. The plan is conceptually complete; the chosen shipped artifact hashes are an implementation gate, not invented evidence.

<a id="s8"></a>

## 8. Proposed app layout, build and test commands

The editor repository remains independent. Proposed ownership:
- src/domain/: pure command validation, operation compatibility, document/event types and reducers.
- src/state/: authority client, immutable projections and Signals read models.
- src/ui/: ie-shell and composed panels; src/ui/adapters/: component/draft/action ownership; registration.ts for eager allowlist and feature modules for lazy groups.
- src/canvas/: client surface and raster services; src/workers/: expensive decode/composite/export tasks where validated.
- src/theme/: token CSS entry and app layout CSS; generated theme artifact only when needed.
- server/: localhost routes, durable writer/assets/job outbox/provider client; no FAL_KEY in browser code.
- tests/unit, tests/integration, tests/browser; tooling/: app-owned launch/measurement/vendor checks; vendor/en-reve and artifacts/: pinned dependencies and fresh evidence outputs.

These are specification conventions, not created folders. Adopt ESM, strict TypeScript, ES2022, .js module specifiers, type-only imports, static Lit styles/properties and separate browser/server entrypoints. Upstream tsconfig.base.json uses NodeNext, strict, useDefineForClassFields and verbatimModuleSyntax; its apps/docs uses Vite and noEmit typechecking. Choose app browser bundler settings deliberately rather than copying workspace relative tsconfig paths. Import only packed public entries; no source aliases in CI. Keep credentials and Node/provider modules out of the client bundle.

App-owned planned package scripts (not claims of currently available commands):
- npm run dev: localhost backend plus Vite with same-origin API proxy.
- npm run typecheck and npm run build: browser/server types and production artifacts.
- npm run test:unit: pure behavior tests; test:integration: actual local persistence/command adapters; test:browser: real en-reve browser interactions; test:e2e: a small complete editor workflow suite.
- npm run test:consumer: packed install/public-import/registration and adapter qualification.
- npm run perf:runtime and perf:dev: distinct reproducible runtime and developer lifecycle receipts.
- npm run verify:vendor: artifact identity and dependency resolution checks.

Use Node's test runner where suitable and pinned Playwright for real browser integration; Task 5 chooses final layers/configuration. Behavior priority is unit > integration > e2e, with complementary layers for distinct risk. Assert user outcomes, accepted values, focus and persistence—not private shadow structure or source-string snapshots. Test ordinary native input and relevant composition sequences separately. Keep provider fixtures credential-free by default; live provider qualification is separate.

Upstream commands such as npm run test:api, test:release, test:theme, test:union and package tests are source-repository gates. They call tooling/testing/invoke.mjs, which is repository-local, not an npm consumer export; invoking installed package test scripts would point at missing ../../tooling. The app must implement its own command entrypoints and resource ownership. Adopt conventions, not that hidden dependency: producers before consumers, fresh outputs, fail closed on missing prerequisites, scoped selection recorded, retained failures/skips, exact argv/tool/browser/source/artifact identity, monotonic timings, owned server cleanup and bounded workers. Discovery/plan output is not a passing test; warm build-cache reuse is not a clean install. Do not run timing campaigns alongside builds or correctness browsers. OS child RSS is not total process-tree memory.

<a id="s9"></a>

## 9. SSR and client canvas boundary

**Initial architecture: client-rendered editor with a native HTML loading/error shell and token CSS before JavaScript. SSR is optional, not a requirement for editing or correctness.** Local interactive documents gain little from serializing transient canvas state into HTML; startup measurements in Task 6 determine whether build-time shell/control SSR earns its cost.

Useful optional SSR scope: static navigation, headings, initial disabled/empty controls and finite panels that improve first paint or delayed-load readability. @en-reve/ssr renderToString/renderRequest produces buffered Declarative Shadow DOM with request-local adapters; it does not register elements automatically. install.js sets up the server environment, never the browser. Server and client must share the exact initial template, snapshot and package identity. Never mutate serialized private hydration metadata or bind early native edits away unintentionally.

If selected, load Lit hydration support before component modules; hydrate/upgrade in the documented ordering. ElementInternals form participation begins at upgrade; no JavaScript-free custom-element form submission is promised. Pre-upgrade text adoption and choice property authority differ: an explicit .value write—even equal—wins over early native edits. Keep meaningful native fallback visible, do not hide the body waiting for hydration. SSR styles may be converted to shared adoptedStyleSheets after hydration; that does not reduce initial HTML bytes automatically.

Canvas is a client-only imperative island with a stable wrapper, size/aspect reservation, fallback/status and app-owned lifecycle. Initialize renderer/workers after client mount and size observation; do not access canvas/GPU/DOM in server module evaluation. Hydrate shell once without replacing an initialized canvas. No pixels, image data URIs, provider credentials or live jobs in HTML. Asset IDs/snapshots are app data and must be validated before client restoration.

For independent versioned SSR islands only, scoped.js exports createScopedRenderer/serializeHydrationManifest/renderIslandMarkup; it uses fresh Node workers with queue/concurrency/timeouts and has real server cost. client.js exports createHydrationIsland with explicit load/activate/ready/dispose. Native/global fallback and partial-hydration failure limits apply; global mode cannot promise independent incompatible versions. This extra machinery is not adopted for the initial single-version client app.

Evidence: ssr/src/index.ts, scoped.ts, client.ts; ssr/README.md; tests/browser/hydration.spec.ts, tests/tree.test.mjs, tests/selection-children.test.mjs and probes/scoped-hydration. apps/docs/scripts/build-ssr.mjs is a build-time static docs example, not evidence of an editor request server.

<a id="s10"></a>

## 10. Foundation constraints and measurement handoff to Task 6

No editor startup, bundle, rendering or test-time measurements exist. PERF-8 owns numerical targets/ceilings and acceptance environments; UX and Architecture now include their reviewed mirrors. The following are required measurement boundaries and design constraints, not benchmark results.

| Area | Required boundary / workload for Task 6 |
| --- | --- |
| Startup | Separate HTML/theme first paint, module fetch/evaluation, definition registration, first component update, usable canvas and first permitted edit. Measure cold and warm startup independently; no registerAll/root-barrel dependency by default. |
| Bundles | Report raw/compressed transfer and evaluated startup JS, per-feature lazy bytes, duplicates and optional rich-editor/SSR code. Measure an actual packed production build, not source size. Lazy loading must include first-use delay/error/focus behavior. |
| Rendering | Distinguish Signals update, Lit updateComplete, layout and next visible canvas frame. Bound DOM rows via virtualization only after full/paged alternatives and AT checks. Account for retained focus/ancestor rows beyond the visible window. |
| Theme/layout | Measure density/theme/font changes, virtual measurement invalidation, split resize and responsive reflow while preserving focus/drafts. Avoid synchronous per-pointer durable writes. |
| Raster | Budget decode/buffers/composite/export/workers separately from controls. 25,000,000 pixels × 4 bytes ≈100 MB for one RGBA8 buffer is arithmetic, not a measured resident-memory ceiling; multiple layers/copies/GPU allocations multiply it. |
| Jobs/assets | Separate app validation, staging/upload, queue wait, inference, download, decode, durable storage and user adoption. Provider time is an observation, not a deterministic PR performance gate. |
| Developer loop | Clean install (including vendor checks), cold build, incremental types/build, hot update, targeted tests, complete CI and browser setup. Report cache state, contention, worker count, failed/aborted runs and exact toolchain. |

Available retained evidence, explicitly outside the future editor:
- `artifacts/test-runtime-2026-09-25/bounded-window-v1/minifier-pairs-v2/summary.json` plus runs.json records three alternating pairs of a complete 22-case minifier command: baseline median 4.728815833 s (4.672635–4.747876), candidate 3.703609833 s (3.688624–3.731815). This is warm host/filesystem/cache work using the recorded Node 26.10.0 darwin-arm64 path, not clean-install or browser startup evidence. Its own limits say staged at receipt time; later plan activation statements do not rewrite this receipt. No whole-library/app speedup is inferred.
- `packages/ssr/verification.json` records a 2026-09-08 sticker-sheet HTML artifact of 3,657,386 bytes with hash, three Node and twelve browser checks. It is old documentation SSR evidence, not current editor bundle size, hydration latency, scoped-island qualification or the current event migration result.
- `packages/primitives/verification.json` is also 2026-09-08 (22 Node/24 browser cases), predates the new event migration, and explicitly excludes physical IME/AT/current-minus-one certification.
- `tooling/testing/README.md` and `plans/test-runtime-reduction-2026-09-25.md` describe current measurement protocols and retained failures; the broad correctness graph explicitly does not establish complete library acceptance. Numerical plan summaries need their linked raw receipts before reuse. No fresh timing campaign was run here.

Each future budget needs workload sizes, hardware/OS/browser/DPR, toolchain, sample count/percentile, cold/warm policy, target and hard ceiling, owner/instrument, baseline source/artifact hashes, retained trends and regression response. Do not transfer the library minifier medians into an editor gate.

<a id="s11"></a>

## 11. Verification, open items and handoff

Completed in this audit: public manifests/export maps and implementation cross-check; relevant behavioral test assertions read; cancellation/supersession/composition/remote failure adapter walkthrough; dependency graph and clean-checkout path review; upstream dirty status/hash capture; raw historical receipt inspection. No test execution or installation is claimed.

Future implementation qualification: the package producer seals actual source and archives; Build runs clean installation/public-import/registration/browser gates; UI and QA qualify native-input and accessible canvas/list outcomes; State qualifies durable command acceptance. The architecture, UX, testing and performance sections now own those detailed contracts. Optional upstream documentation recommendations remain outside this task.

Known limitations remain visible: dirty source snapshot; no clean consumer installation yet; manual virtual collection VoiceOver issue; physical IME/AT and browser support qualification; no measured editor performance; no raster engine supplied; SSR is conditional. These are implementation/review inputs, not reasons to invent a library feature or silently broaden scope.

Source readiness was independently approved as DS-1.1. User review of this assembled version remains pending; source approval is not clean-install or runtime evidence.

## User decision — package delivery

2026-09-25: The user accepted versioned package archives in the editor repository. The archive delivery mechanism in this section is now an accepted preference. Source snapshot selection, immutable provenance capture and clean consumer qualification remain future work. This acceptance covers package delivery; initial browser rendering was also accepted as recorded below.

## User decision — initial rendering

2026-09-25: The user accepted browser rendering first. Section 9’s initial architecture is now an accepted preference: native HTML loading/error shell, token CSS and client-rendered editor; optional SSR requires a measured startup benefit and its own qualification. The local provider server remains required. Both identified preference questions are closed; this does not claim runtime or installation qualification.
