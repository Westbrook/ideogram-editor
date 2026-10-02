import type { D11BuildInventory, D11DuplicateVersion, D11RoleContext } from './browser-d11-build.mjs';

export const D11_STARTUP_BUILD_LIMITS: Readonly<{
  jsRawBytes: 1572864;
  jsGzipBytes: 512000;
  uiCssFontGzipBytes: 204800;
}>;
export interface D11StartupBuildBounds {
  readonly jsRawBytes: number;
  readonly jsGzipBytes: number;
  readonly uiCssFontGzipBytes: number;
  readonly startupFiles: readonly string[];
  readonly uiCssFontFiles: readonly string[];
}
export interface D11StartupBuildBound {
  readonly kind: 'd11-startup-build-upper-bound-1';
  readonly buildSha256: string;
  readonly method: 'verified-static-startup-whole-artifact-upper-bound-v1';
  readonly scope: string;
  readonly qualification: false;
  readonly roleContext: D11RoleContext | null;
  readonly artifactBuildStatus: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  readonly artifactBuildMeasurements: readonly Readonly<{
    name: string; value: number; unit: 'bytes'; method: string; evidence: Readonly<Record<string, unknown>>;
  }>[];
  readonly artifactBuildBudgets: readonly Readonly<Record<string, unknown>>[];
  readonly artifactBuildViolations: readonly Readonly<{
    id: string; method: string; evidence: Readonly<Record<string, unknown>>;
  }>[];
  readonly duplicateVersions: readonly D11DuplicateVersion[];
  readonly limitsExclusive: typeof D11_STARTUP_BUILD_LIMITS;
  readonly counting: string;
  readonly status: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  readonly missing: readonly string[];
  readonly failures: readonly string[];
  readonly bounds: D11StartupBuildBounds | null;
}
export function measureD11StartupBuildBound(inventory: D11BuildInventory): D11StartupBuildBound;
