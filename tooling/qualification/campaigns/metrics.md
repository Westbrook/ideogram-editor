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
seven actual native-control presentation invariants. P `I` separately includes
ten reset one-second first-use windows and three preserved-document hot edits.
The same checks are available independently as `evaluateFirstUse(firstUse)` and
`evaluateHotEdit(hotEdits,{profile})`. Hot edits use three warm records for P or
exactly ten cold and ten warm records for Q3, with each cache's ordinal 1–10.
The runner attaches cache/ordinal only from verified scheduled attempts. Q3 D05
can thus be checked without inventing an unrelated P interaction session; its
cold/warm elapsed statistics remain separate and all 20 ceilings still apply.

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

`evaluateAdapterLifecycle` accepts `P-A` or `Q3-A`, fixed weights/config SHA-256
identities and an independent B0 plus two WA cycles. Phases are actual
import/select/unselect/close/release with one to three selected identities.
Its assertions cover fixed-artifact import, restored selection, durable fixture
preservation, no browser tensor decode and zero unexpected fetches. The same
idle, observation and resource ledger is required. Applicable caps and release
bounds are checked; no editor acute or hundred-cycle growth claim is made.
The runner still enforces each whole AC2/AH2 or I8 job deadline.

`evaluateVisits({profile,metric,cache,cohortKey,library,expectedVisits,reports})`
accepts P/Q3/FIELD and LCP/CLS/INP. Reports retain exact visit/navigation/metric
identity, lifecycle finalization, sequence, visibility, observer support and
interaction count from a pinned `web-vitals` implementation. The latest
finalized report per visit supplies P maxima or Q3 cross-visit p75. Missing
observers, no interactions and incomplete lifecycle remain unavailable. The
success-only p75 is diagnostic and cannot replace a missing required visit.
Optional FIELD evidence additionally requires at least 200 real visits over
28 days; scripted lab visits never establish it.
