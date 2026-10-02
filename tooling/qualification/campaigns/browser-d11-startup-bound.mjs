import { isDeepStrictEqual } from 'node:util';
import { observeD11Build } from '../developer-campaigns/commands.mjs';
import { D11_ROLE_CONTEXT } from './browser-d11-registration.mjs';

// B01 keeps its original strict comparisons. These are static upper bounds;
// actual fetched/evaluated bytes remain independent H campaign obligations.
export const D11_STARTUP_BUILD_LIMITS = Object.freeze({
  jsRawBytes: 1.5 * 1024 * 1024,
  jsGzipBytes: 500 * 1024,
  uiCssFontGzipBytes: 200 * 1024,
});

/** Accept only the immutable inventory produced by loadD11Build (or reproduced
 * by verifyD11RetainedBuild). This reducer cannot establish source provenance
 * for arbitrary caller data; it independently replays the complete C byte audit
 * before narrowing the former all-reachable B01 diagnostic to a startup bound. */
export function measureD11StartupBuildBound(inventory) {
  const audit = observeD11Build(inventory);
  const base = { kind: 'd11-startup-build-upper-bound-1', buildSha256: inventory.sha256,
    method: 'verified-static-startup-whole-artifact-upper-bound-v1',
    scope: 'Conservative C build upper bound for the fixed W0/W1 startup union; not an evaluated-module or transfer observation',
    qualification: false, roleContext: inventory.roleContext ?? null,
    artifactBuildStatus: audit.status, artifactBuildMeasurements: audit.measurements,
    artifactBuildBudgets: audit.budgets ?? [], artifactBuildViolations: audit.violations ?? [],
    duplicateVersions: inventory.duplicateVersions, limitsExclusive: D11_STARTUP_BUILD_LIMITS,
    counting: 'Whole emitted artifact once per scope; shared startup chunks and inline bootstrap included; distinct emitted paths counted separately even when content hashes match' };
  const missing = [...(audit.missing ?? [])];
  if (!isDeepStrictEqual(inventory.roleContext, D11_ROLE_CONTEXT)) missing.push('Exact fixed W0/W1 startup role context is required');
  if (inventory.roles?.complete !== true) missing.push('Complete source-proved startup, feature, text-engine and UI role classification is required');
  if (audit.status !== 'PASS') missing.push('Every required C artifact-build budget must pass before applying the startup bound');
  if (missing.length) return { ...base, status: audit.status === 'FAIL' ? 'FAIL' : 'INCONCLUSIVE', missing: [...new Set(missing)], failures: [], bounds: null };

  const files = new Map(inventory.files.map(file => [file.file, file]));
  const select = (names, accepts) => names.map(name => {
    const file = files.get(name);
    if (!file || !accepts(file)) throw Error('D11 startup bound contains an unknown or incompatible artifact: ' + name);
    return file;
  });
  const startup = select(inventory.roles.startupFiles, file => ['js', 'css', 'font', 'wasm'].includes(file.kind)).filter(file => file.kind === 'js');
  const ui = select(inventory.roles.uiCssFontFiles, file => file.kind === 'css' || file.kind === 'font' && file.authoringFont === false);
  if (!inventory.bootstrap || !startup.some(file => file.file === inventory.bootstrap.file && file.sha256 === inventory.bootstrap.sha256)) {
    return { ...base, status: 'INCONCLUSIVE', missing: ['The exact inline bootstrap must be included in the startup bound'], failures: [], bounds: null };
  }
  const total = (selected, field) => {
    const value = selected.reduce((sum, file) => sum + file[field], 0);
    if (!Number.isSafeInteger(value) || value < 0) throw Error('D11 startup bound has an invalid byte total');
    return value;
  };
  const bounds = { jsRawBytes: total(startup, 'rawBytes'), jsGzipBytes: total(startup, 'gzipBytes'),
    uiCssFontGzipBytes: total(ui, 'gzipBytes'), startupFiles: startup.map(file => file.file).sort(),
    uiCssFontFiles: ui.map(file => file.file).sort() };
  const failures = Object.entries(D11_STARTUP_BUILD_LIMITS).filter(([name, limit]) => bounds[name] >= limit)
    .map(([name]) => name + ' does not satisfy the unchanged strict B01 ceiling');
  return { ...base, status: failures.length ? 'FAIL' : 'PASS', missing: [], failures, bounds };
}
