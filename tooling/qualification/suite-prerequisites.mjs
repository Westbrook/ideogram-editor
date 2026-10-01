// Shared, side-effect-free prerequisite metadata for every execution entry point.
export function requiredSuiteEnvironment(files) {
  return files.some(file => file.startsWith('tests/campaigns/')) ? {IE_CAMPAIGN_PRODUCT_INTEGRATION: '1'} : {};
}
export const nodeGroups = Object.freeze({
  base: ['session', 'store', 'protocol', 'assets', 'raster', 'history'],
  features: ['provider', 'request', 'queue', 'adapters', 'candidates', 'export', 'composition', 'text-state', 'portable', 'recovery'],
  helpers: ['browser', 'editor', 'text', 'qualification', 'campaigns'],
});
export const nodeGuard = group => group === 'store' ? 'tests/store/no-network.mjs' : group === 'provider' ? 'tests/provider/no-egress.mjs' : 'tests/session/no-egress.mjs';
