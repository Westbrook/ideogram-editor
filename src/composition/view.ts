// Typed Composition storage/view limits. These are wire/retention bounds, not
// extra allocation capacity: every consumer must still admit its owned payload.
export const DRAFT_GRAPH_BYTES=8*1024**2;
export const COMPOSITION_VALUE_BYTES=1024**2;
export const COMPOSITION_DRAFT_VIEW_BYTES=9*1024**2;
// One accepted graph plus at most 100 layer descriptions/native-text values,
// including the maximum JSON escaping of their independently bounded strings.
export const COMPOSITION_VIEW_BYTES=48*1024**2;
