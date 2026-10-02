# Raw protocol metrics

These exported evaluators implement PERF-8 arithmetic; none authenticates a host
or certifies a complete campaign. `FAIL` takes precedence over `INCONCLUSIVE`,
and unavailable measurements are never passing zeros. Tests use synthetic
records solely to test this arithmetic.

`evaluateInteraction({profile, protocol, cohortKey, sessions, firstUse, hotEdits})`
accepts `P` or `Q3` and `I` or `IText`. P requires one warm session; Q3 requires
one cold and five warm sessions with independent ordinal identities. Every
session is exactly 60 seconds, visible at 60 Hz, with trace-backed physical
presentation and complete app main-thread attribution. `I` includes 20 strokes
of 120 samples and 80 discrete actions; `IText` includes 106 actions with the
native-control presentation invariants and the explicit stale-guard evidence below. P `I` separately includes
ten reset one-second first-use windows and three preserved-document hot edits.
The same checks are available independently as `evaluateFirstUse(firstUse)` and
`evaluateHotEdit(hotEdits,{profile})`. Hot edits use three warm records for P or
exactly ten cold and ten warm records for Q3, with each cache's ordinal 1–10.
The runner attaches cache/ordinal only from verified scheduled attempts. Q3 D05
can thus be checked without inventing an unrelated P interaction session; its
cold/warm elapsed statistics remain separate and all 20 ceilings still apply.

The additive native HMR route can establish a conservative D05 ceiling without
inventing an exact paint timestamp. The campaign replays the sealed producer
receipt, prepared source and fixed edit, owned browser and native process,
retained collector build, exact externally pinned wordmark oracle, browser
save/task marks, full-display capture pixels and source/document restoration.
Only that replay mints a process-local proof accepted by `evaluateHotEdit`.
Serialized approval flags and upper-bound values cannot substitute for it.
An observed WindowServer correct-pixel upper bound at or below 500 ms satisfies
that edit's ceiling; a later observed bound remains `INCONCLUSIVE` because
capture does not establish the earliest correct frame. Product/document failures
and measured exact legacy ceiling violations keep their failure precedence.

Native records keep `presentedMs:null`. Their `upperBounds` statistics and
`maximumUpperBoundMs` phase observations are separate from exact elapsed/cache
statistics and `maximumMs`; exact relative comparisons cannot consume them.
The 200 ms target remains unknown for a native bound that cannot resolve it.
The existing P three-warm and Q3 ten-cold/ten-warm inventory remains mandatory.
This named WindowServer endpoint does not establish physical scanout, photons,
atomic historical occlusion, complete display slots or R07 dropped-slot bounds.
The oracle still requires external semantic review: a byte pin proves identity,
not that the selected ROI correctly depicts the requested wordmark state.

Action records contain `id`, `kind`, `inputMs`, `presentedMs`, `meaningful` and
optional stroke `samples`. Each stroke also carries `pointerSchedule` with
`clock:'runner-monotonic'`, `frequencyHz:60` and exactly 120 ordered
`{index,scheduledMs,dispatchStartedMs,dispatchCompletedMs}` observations. Requested
schedule intervals are exactly 1/60 second; actual dispatches cannot begin before
their scheduled times, overlap, or lose samples. Browser `inputMs` remains the
actual native timestamp, and input-to-presentation uses that browser clock.
Dispatch lateness and native interarrival statistics are reported separately;
runner and browser clocks are never subtracted. PERF specifies no native-arrival
jitter tolerance, so the evaluator adds none and does not rewrite observed times
to the requested schedule. Required gesture counts, the 60-second session,
physical presentation, frame and latency ceilings remain unchanged.

The trace identity is
`{kind:'browser-presentation-trace',sha256,attributionComplete:true}`. A hash
does not establish those facts: the collector must independently establish them.
DOM mutation, rAF, Paint or render submission is not physical presentation.
Missing physical correlation stays unavailable. Active frame segments contain
`startMs`, `endMs`, complete ordered `{index,presented}` display `slots` and
`mainThreadIntervals`. Nested/overlapping app intervals are unioned per slot;
worker/GPU/wait lanes must not be inserted as main-thread work. Reported R04
acknowledgement max, R07 slot max, pointer p95, drop share and R08 slice limits
remain separate. INP is a finalized visit metric, not these pointer samples.
The 8 ms frame-work target is reported for each active segment; a longer fast
segment cannot hide a shorter target miss. Dropped slots are aggregated over
expected active slots within the full 60-second I session, then the cohort takes
its worst session. Dividing the same trace into shorter segments does not change
that ratio. Contiguous missed slots retain stalls crossing a segment boundary.

IText retains the fixed 106-action protocol and six presentation requests. Its
final explicit Cancel can supply one compound retirement observation for the
actual still-pending request: session epoch, general generation, and independent
draft text version have become stale at that existing native-end boundary. This
is one guard-mask evaluation, not three independently exercised rejection
branches or three additional requests. Draft text version advances only when
current draft session text changes; formatting-only invalidation advances generation
without advancing that text version.

The current `textPresentation.deferredRequestRejection` contract has kind
`deferred-presentation-rejection-2`, positive `requestSequence`, reason
`cancelled`, `nativeBoundary:'cancel-native-end'`, and `guardMask:7` (session=1,
generation=2, draft text version=4). Its six request/current epoch, generation,
and text-version values must be nonnegative safe integers, with all three
current values increased. `capturedState` and `currentState` bind the respective
scalar tuples to the actual public request and native editor observations.
It also requires `presentationUnchanged:true`, `requestNotSettled:true`,
`extraMutationOrRequest:false`,
`witnessedGuards:['stale-session','stale-generation','stale-version']`,
`unobservedGuards:[]`, and `versionMeaning:'draft-text-version'`.
The companion `staleDeferredRequestRejected` reflects the observed outcome.

The accepted document/layer version is a separate invariant. Its bit 8 must be
absent, and `acceptedVersion` states
`{scope:'accepted-document-layer-version',invariantUnchanged:true,rejectionObserved:false}`.
This fixed specimen does not change an accepted layer version and cannot claim
that accepted-version rejection was exercised. Its independent product
regressions cannot be substituted for timed campaign observations.

Historical kind `deferred-presentation-rejection-1` records remain readable as
generation-only evidence: reason `stale-generation`, equal request/current epochs,
increased generation, `nativeBoundary:'existing-final-composition-cancel'`,
unchanged presentation, no settlement or extra request, only `stale-generation`
witnessed and session/version unobserved. They retain explicit `INCONCLUSIVE`
obligations for the current compound tuple and missing session/draft-version
observations. A legacy `staleSessionGenerationVersionRejected:true` flag cannot
supply any tuple. Missing new raw snapshot scalars are never synthesized.

`textGuardCoverage` reports the precise observed/unobserved guards, draft-version
meaning, and separate unobserved accepted-version rejection. Source implementation
or authored fixtures alone supply no runtime qualification. A model-settled
sequence is not physical presentation and cannot populate a missing presented
timestamp; native input provenance, independent display feedback, and all other
PERF130 timing obligations remain separate.

`evaluateLifecycle({profile,workload,processIdentity,fixtureIdentity,B0,cycles,
windows,sampling,forcedGC,processRestarted})` accepts `P-M` or `M` and W1/W2/WXn/WXs.
Each baseline and cycle includes an actual requested 30-second `idle`, a later
resource `observation:{startMs,endMs}`, and `resources`. Each cycle has actual
ordered action phases, the explicit byte oracles below, peak `resourceSamples`,
last-consumer `releaseMs`, the same process/fixture identities, and scheduled
real worker restart identities. Both `forcedGC` and `processRestarted` must
explicitly be false. Resource observation latency is part of elapsed work and
cannot be subtracted from the 90-second cycle deadline. M's five consecutive
30-minute windows begin at B0's idle end, including its observation latency.

Resources contain browser/backend process-tree RSS, CPU/GPU/cache allocation
bytes, settled bytes, unused handles, texture side and actual device limit.
All memory/handle fields are required, along with continuous attributed sampling
evidence. Actual app-owned textures require measured `textureSide` and a
positive `deviceTextureLimit`, enforcing min(2048, device limit). The sole N/A
path requires `rendererOwnership.textureLimitApplicability:'not-applicable'`
and `rendererOwnershipProof` accepted by the shared independently reviewed
source/build predicate. Both numeric texture fields must remain `null`; a
runtime declaration, unknown review, absent artifact or invented zero limit
cannot pass. The full runner independently verifies retained proof bytes and
parent executable identities before replaying these arithmetic checks. Canvas2D
RGBA backing estimates still count against `gpuBytes` and every existing cap.
P-M has two cycles and its own 4/8 MiB target/ceiling; M has 100 cycles and its
own 16/32 MiB target/ceiling. Final and worst settled growth are both retained.
`cycle.action.assertions.lifecycleRaster` has `schemaVersion:1` and scope
`M-authored-mask-candidate-replacement-undo`. Every cycle requires true
`strokeAuthoredGeometry`, `adoptedLayerPixelsEqualPreparedCandidate`,
`otherLayersAndTargetSlotPreserved`, `canonicalDocumentPixelsVerified`,
`undoAdoptionPixelsRestored`, `undoBaselinePixelsRestored` and `retainedInputs`.
These mean the actual 120 consumed native points and 64px brush match the durable
mask authoring record; independently decoded adopted layer bytes match the fixed
prepared candidate; other layers and target position remain unchanged; actual
canonical document pixels are checked; and each Undo restores its corresponding
pre-operation document pixels while all fixed inputs remain retained. A document
with retained overlays or transparency is not assumed equal to the candidate.
The scope explicitly records `nativeDisplayPixels:false` and
`independentStrokeRasterization:false`; generic `exactPixels:true` cannot replace
these witnesses. This resource lifecycle proof does not certify native display or
independently predicted stroke raster output. The separate functional, R10/R15
preservation and presented-pixel gates remain required.

Worker restarts occur after P-M cycle 1 or M cycles 20/40/60/80. The entire
process must remain alive; deleting the durable fixture cannot reset growth.
The actual series `startMs` and `endMs` are required. For M, the end observation
must cover the final 150-minute window; nominal window labels cannot qualify an
early-ending run.

`evaluateAdapterLifecycle(raw,{cell})` accepts `P-A` or `Q3-A`, fixed weights/config SHA-256
identities and an independent B0 plus two WA cycles. Phases are actual
import/select/unselect/close/release with one to three selected identities.
The immutable planned cell determines resource applicability: AC2/I8C are C
backend cells and AH2/I8H are H browser cells. The exact WA lifecycle ID,
operation, handler, host, two cycles, 30-second idles, 256 MiB weights and
1 MiB config bound must match. Runtime declarations cannot choose a smaller
scope. Every selected artifact is recomputed with `selectedAdapterIdentity` and
must match the fixed weights/config, typed byte lengths/media types, and actual
cycle import's `observations.importedBinding` immutable version/adapter/version.
An older version with the same bytes, an unrelated eligible fixture, or an
unverified asserted identity cannot satisfy that binding.
Its assertions cover fixed-artifact import, restored selection, durable fixture
preservation, no browser tensor decode and zero unexpected fetches. C requires
actual process/worker RSS, owned CPU allocation bytes and unused handles, with
`resourceScope:'wa-backend-process-workers-allocations-1'`. Its
`backendOwnership` has kind `wa-backend-owner-evidence-1`, the exact lifecycle
process identity, retained `{path,bytes,sha256}` evidence and complete coverage
for `processTree`, `workerThreads`, `stagingBuffers`, `hashBuffers`,
`headerBuffers`, `configBuffers`, `ioCopies`, `metadataConsumers`,
`assetReadHandles`, `proofHandles` and `streamHandles`. RSS is not an allocation
ledger, and scoped campaign read handles cannot establish global unused handles.
Browser RSS, GPU, preview cache, texture side and device limit remain `null` on C;
its continuous sampling kind is `attributed-backend-process-and-allocation-ledger`.
For active C action/peak observations, `unusedHandles:null` is admissible only
with the retained producer's explicit active-owner classification:
`coverage.handles:false`, `handleClassification.kind:'scoped-handle-classification-1'`,
`complete:false`, `settled:false`, `retainedHandles:null`, all six nonnegative
integer `activeOwners` counts with at least one positive, and actual integer
service-handle counts. All eleven allocation/process ownership coverage flags
and real CPU/RSS values remain mandatory. This means unused-handle classification
is unavailable during intentional active work; it is never interpreted as zero.
B0 and settled post-release cycle observations still require actual numeric
unused-handle accounting; an active classification cannot replace either.
Known post-release nonzero unused handles fail. Peak/resource registry completeness
checks use those distinct observation roles, and H browser rules are unchanged.
Backend RSS and CPU retain their 512 MiB ceilings. H retains the complete
browser/backend resource ledger and its independently reviewed texture N/A path.
Both retain real B0, cycle idles, observations, action order and 5-second release
bounds. No editor acute or hundred-cycle growth claim is made.
The runner still enforces each whole AC2/AH2 or I8 job deadline.

`deriveLifecycleMeasurements(raw,{cell})` translates actual editor or WA raw
lifecycles to `{measurements,unavailable}` for the named registry rows. It also
exports the alias `deriveAdapterLifecycleMeasurements`. Resource maxima use
actual B0/end/peak observations and `sampling.peakSamples[key]`, an original
observation at `sampling.peaks[key]`, tied to the retained sampling artifact,
process identity and sample ordinal. A composite of unrelated maxima is not a
sample. The runner must independently replay the retained bytes and verify each
peak witness. `sampling.textureLimits` retains the actual per-observation
`complete`, `observedSamples`, `violations` and `notApplicableSamples` counters;
maximum texture side cannot be compared against an unrelated maximum device
limit. The complete counter is replayed from actual paired samples or reviewed
renderer applicability. R19 final/worst growth comes from `evaluateLifecycle`;
an incomplete cycle prefix cannot be labelled a final observation.

C CPU additionally requires `sampling.allocationPeaks.cpuBytes` with kind
`owned-allocation-continuous-peak-1` and scope `independent-B0-lifecycle-window`.
This is the actual simultaneous shared-atomic allocation peak from a separate
observation window, not the sum of realm peaks or a rewritten current sample.
It carries the actual shared identity, producer sequence, source sample ordinal,
window ID, decimal monotonic-nanosecond start/end, sealed/intact flags and retained
artifact. `sampling.observationWindow` binds that ID/process to actual runner
start/end observation brackets around B0 window creation and final sealing.
The lifetime peak, including preparation, remains diagnostic: a preparation-only
exceedance cannot become a scored failure or an exact CI comparison point.
An absent or incomplete window leaves the exact CPU row unavailable; actual
in-window sampled ceiling breaches remain lower-bound failures. Creating the
window does not reset product allocations, erase the lifetime peak or force GC.

H CPU uses a separate `independent-B0-browser-cpu-window` join. The first
manual B0 observation begins the synchronous browser ledger plus text-reservation
observer; the final observation seals it. The retained begin/end ACKs name the
same ledger instance, window, ordinal and browser-performance clock origin.
Their exact producer times/sequences are checked against the window, while
source sample ordinals and runner observation brackets bind the lifecycle.
Browser and runner clocks are never subtracted or treated as interchangeable.
The sealed peak must equal its actual simultaneous ledger/text byte sum. Raw
replay verifies the exact producer snapshots and footer before metric replay;
`sampling.peaks` and `peakSamples` retain their original sampled meaning.

The current `combined-cpu-window-1` contract explicitly has
`ownerCoverageComplete:false`. Its five global ownership gaps remain disclosed
even when `observationComplete:true` and the continuity failure list is empty.
Such a clean sealed window can reveal a transient **lower-bound failure** above
the CPU ceiling, including one missed by the 100 ms samples. It cannot produce a
complete under-cap CPU row or a paired exact regression point. Missing endpoints,
fault-disclosed continuity, mismatched identities or artifacts leave the scoped
peak unavailable; actual in-window sampled breaches remain failures. Sampled
preparation-only maxima and lifetime combined peaks remain diagnostic. This
changes no C window contract, resource budget, RSS measurement or ownership claim.

The additive `app-ownership-observation-1` witness keeps those v1 flags and gaps
unchanged. Its current point inventories the fixed ten application reservation
kinds, while its window retains each kind's exact initial/current amounts and
reserved/resized/released/observed transitions. Reconciliation uses the original
ledger sequences and the same browser CPU window, clock origin and text source.
The begin ACK precedes snapshot-reader admission, so B0 current amounts may
legitimately differ from the retained initial amounts. Current B0 CPU must still
equal its actual ledger-plus-text point and sample. Sealed windows are immutable;
subsequent live points may change without replacing the sealed end observation.

`appOwnedCpuCandidate(begin,end,processIdentity,observationWindow)` is the shared
pure join used by sampling, retained replay and metric translation. It returns
`null` for absent or inconsistent endpoints. A coherent witness contains the
original full B0/final app and CPU observations, exact source ordinals and runner
brackets, identical renderer proof, the existing simultaneous CPU peak, and
`artifact:null` in the raw footer. The returned evidence binds that same object
to the retained raw artifact. Structural validity alone leaves `complete:false`.

H R18 CPU, GPU and preview-cache exact rows additionally require the fixed
reviewed app scope, pinned source/native/build/runtime proof, and complete
reconciled windows. CPU uses the simultaneous v1 kernel maximum; GPU/cache use
the app window's continuous mutation maxima, never a sampled or lifetime maximum.
The exact planned lifecycle inventory, process identity and artifact are still
required, including original B0, settled and active samples for every completed
cycle. A thrown final cycle does not become complete because its ordinal fills
the planned count. The scored interval is the original B0/final interval, and preparation
maxima remain diagnostic. The final live sample is excluded from sampled candidates because reader
owners may change after the seal; the continuous maximum already includes every
through-seal reservation. Missing or unreviewed proof cannot create an under-cap
pass; actual in-window sampled or clean continuous breaches retain lower-bound
failure precedence. The fixed review registry is currently empty.

This application-owned conservative-reservation route does not establish global
native memory or process RSS coverage. Global incompleteness does not erase an
independently valid app scope. Retained replay continues disclosing the legacy
CPU ownership gap even if a fixed reviewed app scope later supplies the scoped
allocation requirement; every other required observation, including RSS, keeps
its own completion gate. R17, whole-lifecycle completeness, C backend allocation
semantics and all resource ceilings remain separate and unchanged.

For T05/T06/R32 and R21/R25/R35/R38, each actual cycle may supply
`action.measurements` rows with exact `name`, `value`, `unit`, `method`,
`complete:true` and `evidence:{kind:'lifecycle-measurement-evidence-1',cellId,
cycleOrdinal,processIdentity,fixtureIdentity,coverage:'complete-cycle-actions',
artifact:{path,bytes,sha256}}`. The retained artifact must establish that specific
metric boundary; a generic true assertion or start/end count is insufficient to
prove a peak or a zero. Each planned cycle must supply exactly one complete row.
An interrupted collector may instead use `complete:false` with
`coverage:'observed-partial-cycle-actions'`; its actual witnessed ceiling breach
remains a failure, but its zero or within-budget observation cannot pass.
Violation counts are summed across distinct cycles; other values use the maximum.
Missing collectors remain unavailable, including browser tensor/network counts
when only harness activity is known. An incomplete observed value is emitted only
when it already breaches the registry ceiling, marked `complete:false` and
`lowerBound:true`, so a partial trace preserves failure without creating a pass.

`evaluateVisits({profile,metric,cache,cohortKey,library,expectedVisits,reports})`
accepts P/Q3/FIELD and LCP/CLS/INP. Reports retain exact visit/navigation/metric
identity, lifecycle finalization, sequence, visibility, observer support and
interaction count from a pinned `web-vitals` implementation. The latest
finalized report per visit supplies P maxima or Q3 cross-visit p75. Missing
observers, no interactions and incomplete lifecycle remain unavailable. The
success-only p75 is diagnostic and cannot replace a missing required visit.
Optional FIELD evidence additionally requires at least 200 real visits over
28 days; scripted lab visits never establish it.
