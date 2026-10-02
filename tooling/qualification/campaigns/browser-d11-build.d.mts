/** Read-only public inventory emitted by browser-d11-build.mjs.
 * Nested proof payloads stay unknown until the existing runtime verifiers
 * validate them; these declarations do not confer proof authority. */
export interface D11ByteIdentity {
  readonly sha256: string;
  readonly rawBytes: number;
  readonly gzipBytes: number;
  readonly computedGzipBytes: number;
}
export interface D11InputIdentity {
  readonly path: string;
  readonly rawBytes: number;
  readonly sha256: string;
}
export interface D11BuildFile extends D11ByteIdentity {
  readonly file: string;
  readonly modules: readonly string[];
  readonly sources: readonly string[];
  readonly kind: 'js' | 'css' | 'font' | 'wasm' | 'other';
  readonly authoringFont: boolean;
}
export interface D11RoleContext {
  readonly kind: 'd11-role-context-1';
  readonly viewport: Readonly<{ width: 1440; height: 900 }>;
  readonly deviceScaleFactor: 2;
  readonly boundary: 'document-ready-via-Open';
  readonly workloads: readonly ['W0', 'W1'];
  readonly counting: 'union';
}
export interface D11BuildRoles {
  readonly complete: boolean;
  readonly missing: readonly string[];
  readonly startupFiles: readonly string[];
  readonly textEngineFiles: readonly string[];
  readonly uiCssFontFiles: readonly string[];
  readonly lazyFeatures: readonly Readonly<{ id: string; files: readonly string[]; closureFiles?: readonly string[] }>[];
  readonly excludedImports?: readonly Readonly<Record<string, unknown>>[];
  readonly excludedWorkers?: readonly Readonly<Record<string, unknown>>[];
  readonly startupUpperBounds?: readonly Readonly<Record<string, unknown>>[];
  readonly startupProof?: readonly Readonly<Record<string, unknown>>[];
}
export interface D11DuplicateVersion {
  readonly package: string;
  readonly versions: readonly string[];
}
export interface D11StaticDocument {
  readonly bootstrap: D11BuildFile & Readonly<{ file: 'inline:bootstrap'; kind: 'js'; authoringFont: false }>;
  readonly document: D11ByteIdentity;
}
type D11RetainedInputName = 'buildEvidence' | 'manifest' | 'lock' | 'textManifest' | 'textProfile' | 'staticSource' | 'staticModule' | 'index';
export interface D11BuildInventory extends D11StaticDocument {
  readonly kind: 'perf-d11-build-1';
  readonly sha256: string;
  readonly files: readonly D11BuildFile[];
  readonly dynamicFeatures: readonly Readonly<{ id: string; entryFile: string; files: readonly string[] }>[];
  readonly textWasmHash: string;
  readonly duplicateVersions: readonly D11DuplicateVersion[];
  readonly duplicateVersionsScope: string;
  readonly gzip: Readonly<{ algorithm: 'gzip'; level: 'zlib-default'; source: string }>;
  readonly inputs: Readonly<Record<D11RetainedInputName, D11InputIdentity>>;
  readonly retainedInputs: Readonly<Record<D11RetainedInputName, string>>;
  readonly roles: D11BuildRoles;
  readonly roleInputs: Readonly<{
    sourceTextByPath: Readonly<Record<string, string>>;
    outputTextByFile: Readonly<Record<string, string>>;
    parser: Readonly<{ name: 'rolldown'; version: string }>;
    registrationContract: Readonly<Record<string, unknown>>;
    invocationContract?: Readonly<Record<string, unknown>> | null;
  }>;
  readonly roleContext: D11RoleContext;
  readonly toolchain: Readonly<{ node: string; npm: string; zlib: string; built: Readonly<{ node: string; npm: string }> }>;
  readonly sourceInputs: readonly D11InputIdentity[];
  readonly dependencyInputs?: readonly D11InputIdentity[];
  readonly compilation?: Readonly<Record<string, unknown>>;
  readonly sourceAttribution: string;
}
export function deriveD11StaticDocument(input: { staticModule: string; index: string }): D11StaticDocument;
export function loadD11Build(options: { repo: string; cacheDirectory?: string }): Promise<D11BuildInventory>;
