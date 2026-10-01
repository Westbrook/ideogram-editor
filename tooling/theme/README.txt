Spectrum density themes

The immutable vendor/themes/spectrum inputs remain the approved Spectrum source.
The existing spectrum-inspired theme is its byte-identical compact output. The
app starts with spectrum-inspired-comfortable and offers the compact baseline
and spectrum-inspired-spacious using the public En Reve density context.

The producer replays each verified light/dark source, then resolves the complete
graph with createReviewDraft.setContext({density}). All Spectrum palette,
typography, geometry pins and companion definitions stay intact. Control minimum
sizes and derived size roles, surface padding, rows, actions and section spacing
respond to density; a seed CSS override is not used. Native target floors can
make two nearby densities' control heights similar, particularly for touch.
App-owned fixed pixel geometry, such as the canvas/tool rail, remains unchanged.

  node tooling/theme/spectrum.mjs
  node tooling/theme/density.mjs

Both commands verify exact reproduction. To regenerate only the new application
density artifacts after a deliberate source/producer change:

  node tooling/theme/density.mjs --write

The new generated receipt is tooling/theme/density.generated.json. Generation
does not write the frozen theme source or the original compact artifact.
Density is a local appearance preference, independent of document/UI drafts,
stored under ideogram.density; unavailable storage still permits live changes.

After the repository typecheck and prerequisite app/server builds, focused tests:

  node --import ./tests/store/no-network.mjs --test tests/browser/density-theme.test.mjs
  DENSITY_OUTPUT=artifacts/density-unique DENSITY_BROWSER=chromium npm exec -- playwright test --config tests/browser/density.config.ts

Use firefox and webkit for the other pinned engines. The browser fixture owns its
server/profile and verifies no provider effects. Retain a unique output directory
for each invocation; these correctness tests do not qualify R16/P-I timing or
manual assistive-technology behavior.
