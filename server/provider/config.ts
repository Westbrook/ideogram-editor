import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { canonical, parseControlJSON } from '../../src/protocol/json.js';
import { PRODUCTION_PRIVACY, PRODUCTION_PROFILE } from './production-profile.js';

/** Local authorization is nonsecret. Each dispatch also needs its exact durable review authorization. */
export type FalAuthorizationManifest = Readonly<{
  schemaVersion: 1;
  id: string;
  approvedAt: string;
  expiresAt: string;
  endpoint: 'ideogram/v4';
  operation: 'generate';
  maxRequests: number;
  maxImages: number;
  output: Readonly<{ width: number; height: number; count: 1; format: 'png' }>;
  expansion: 'None';
  profileId: string;
  profileVersion: number;
  evidenceDigest: string;
  disclosureDigest: string;
  acknowledgeChargeAndPrivacy: true;
}>;

/** Backend memory / explicit writer channel only. Never publish or log this object. */
export type ExecutableProviderRuntimeConfig = Readonly<{ mode: 'disabled' }> | Readonly<{
  mode: 'fal';
  manifest: FalAuthorizationManifest;
  manifestHash: string;
  key: string;
}>;

export type V45BlockedRuntimeConfig = Readonly<{mode:'fal-v45-blocked';requestedMode:'disabled'|'fal'}>;
export type ProviderRuntimeConfig = ExecutableProviderRuntimeConfig | V45BlockedRuntimeConfig;

export class ProviderConfigurationError extends Error {
  readonly code = 'PROVIDER_CONFIGURATION_INVALID';
  constructor() { super('Provider configuration is invalid.'); this.name = 'ProviderConfigurationError'; }
}
const invalid = (): never => { throw new ProviderConfigurationError(); };
const disabled: ExecutableProviderRuntimeConfig = Object.freeze({ mode: 'disabled' });
const APPROVAL_BYTES = 64 * 1024;
const KEY_BYTES = 4 * 1024;

function privateFile(stat: BigIntStats, max: number): void {
  if (typeof process.getuid !== 'function' || !stat.isFile() || stat.isSymbolicLink() ||
      stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o7777n) !== 0o600n ||
      stat.nlink !== 1n || stat.size < 1n || stat.size > BigInt(max)) invalid();
}
function unchanged(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid &&
    a.gid === b.gid && a.nlink === b.nlink && a.size === b.size &&
    a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function trustedDirectory(stat: BigIntStats): void {
  if (typeof process.getuid !== 'function' || !stat.isDirectory() || stat.isSymbolicLink() ||
      (stat.uid !== 0n && stat.uid !== BigInt(process.getuid())) ||
      ((stat.mode & 0o022n) !== 0n && (stat.mode & 0o1000n) === 0n)) invalid();
}
function components(path: string): Array<{ path: string; stat: BigIntStats }> {
  let current = parse(path).root;
  const root = lstatSync(current, { bigint: true });
  trustedDirectory(root);
  const out: Array<{ path: string; stat: BigIntStats }> = [{ path: current, stat: root }];
  for (const part of relative(current, dirname(path)).split('/').filter(Boolean)) {
    current = join(current, part);
    const stat = lstatSync(current, { bigint: true });
    trustedDirectory(stat);
    out.push({ path: current, stat });
  }
  return out;
}
/**
 * Bounded descriptor reads under trusted ancestors. Root/current-user ownership
 * and write/sticky checks prevent other users replacing path components. A
 * process with the current UID already has authority to read/change these files.
 */
function readPrivateFile(path: string | undefined, max: number): Buffer {
  if (typeof path !== 'string' || !path || path.length > 4096 || path.includes('\0') ||
      !isAbsolute(path) || resolve(path) !== path) return invalid();
  const parents = components(path), before = lstatSync(path, { bigint: true });
  privateFile(before, max);
  // NONBLOCK prevents a concurrent replacement with a FIFO from hanging startup.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const bytes = Buffer.alloc(Number(before.size) + 1);
  try {
    const opened = fstatSync(fd, { bigint: true });
    privateFile(opened, max);
    if (!unchanged(before, opened)) invalid();
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd, { bigint: true });
    privateFile(after, max);
    if (BigInt(length) !== before.size || !unchanged(before, after) ||
        !unchanged(before, lstatSync(path, { bigint: true }))) invalid();
    for (const parent of parents) {
      const afterParent = lstatSync(parent.path, { bigint: true });
      trustedDirectory(afterParent);
      if (parent.stat.dev !== afterParent.dev || parent.stat.ino !== afterParent.ino ||
          parent.stat.mode !== afterParent.mode || parent.stat.uid !== afterParent.uid ||
          parent.stat.gid !== afterParent.gid) invalid();
    }
    return bytes.subarray(0, length);
  } catch (error) {
    bytes.fill(0);
    throw error;
  } finally { closeSync(fd); }
}
function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function isoTime(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return invalid();
  const time = Date.parse(value);
  if (!Number.isSafeInteger(time) || new Date(time).toISOString() !== value) return invalid();
  return time;
}
function manifest(value: unknown, now: number): FalAuthorizationManifest {
  if (!exactKeys(value, ['schemaVersion', 'id', 'approvedAt', 'expiresAt', 'endpoint', 'operation',
    'maxRequests', 'maxImages', 'output', 'expansion', 'profileId', 'profileVersion', 'evidenceDigest',
    'disclosureDigest', 'acknowledgeChargeAndPrivacy']) || value.schemaVersion !== 1 ||
    typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.id) ||
    value.endpoint !== 'ideogram/v4' || value.operation !== 'generate' || value.expansion !== 'None' ||
    value.acknowledgeChargeAndPrivacy !== true || !Number.isSafeInteger(now) ||
    isoTime(value.approvedAt) > now || isoTime(value.approvedAt) >= isoTime(value.expiresAt) ||
    !Number.isSafeInteger(value.maxRequests) || Number(value.maxRequests) < 1 || Number(value.maxRequests) > 100 ||
    !Number.isSafeInteger(value.maxImages) || Number(value.maxImages) < 1 || Number(value.maxImages) > 400 ||
    value.profileId !== PRODUCTION_PROFILE.id || value.profileVersion !== PRODUCTION_PROFILE.version ||
    value.evidenceDigest !== PRODUCTION_PROFILE.evidenceDigest ||
    value.disclosureDigest !== PRODUCTION_PRIVACY.disclosureDigest) return invalid();
  const output = value.output;
  if (!exactKeys(output, ['width', 'height', 'count', 'format']) || output.count !== 1 || output.format !== 'png' ||
      ![output.width, output.height].every(side => Number.isSafeInteger(side) && Number(side) >= 512 &&
        Number(side) <= 3840 && Number(side) % 16 === 0)) return invalid();
  return Object.freeze({ schemaVersion: 1, id: value.id,
    approvedAt: String(value.approvedAt), expiresAt: String(value.expiresAt),
    endpoint: 'ideogram/v4', operation: 'generate', maxRequests: Number(value.maxRequests),
    maxImages: Number(value.maxImages),
    output: Object.freeze({ width: Number(output.width), height: Number(output.height), count: 1, format: 'png' }),
    expansion: 'None', profileId: PRODUCTION_PROFILE.id, profileVersion: PRODUCTION_PROFILE.version,
    evidenceDigest: PRODUCTION_PROFILE.evidenceDigest, disclosureDigest: PRODUCTION_PRIVACY.disclosureDigest,
    acknowledgeChargeAndPrivacy: true });
}

/** Revalidate the explicit backend worker channel; never accept browser configuration. */
export function validateProviderRuntimeConfiguration(value: unknown, now = Date.now()): ProviderRuntimeConfig {
  try {
    if (exactKeys(value, ['mode']) && value.mode === 'disabled') return disabled;
    if (exactKeys(value, ['mode','requestedMode']) && value.mode === 'fal-v45-blocked' && (value.requestedMode === 'disabled' || value.requestedMode === 'fal')) return Object.freeze({mode:'fal-v45-blocked',requestedMode:value.requestedMode});
    if (!exactKeys(value, ['mode', 'manifest', 'manifestHash', 'key']) || value.mode !== 'fal' ||
        typeof value.key !== 'string' || value.key.length > KEY_BYTES || !/^[\x21-\x7e]+$/.test(value.key)) return invalid();
    const authorization = manifest(value.manifest, now);
    const manifestHash = createHash('sha256').update(canonical(authorization)).digest('hex');
    if (value.manifestHash !== manifestHash) return invalid();
    return Object.freeze({ mode: 'fal', manifest: authorization, manifestHash, key: value.key });
  } catch { return invalid(); }
}

/** FAL_KEY alone never enables access and is never read. No caller-supplied profiles or endpoints. */
export function loadProviderConfiguration(environment: NodeJS.ProcessEnv, now = Date.now()): ProviderRuntimeConfig {
  try {
    const mode = environment.IDEOGRAM_PROVIDER_MODE ?? 'disabled';
    const model = environment.IDEOGRAM_PROVIDER_MODEL ?? 'ideogram/v4';
    if (!['disabled','fal'].includes(mode) || !['ideogram/v4','ideogram/v4.5'].includes(model)) return invalid();
    // The model selector exposes a blocked capability without reading approval or secrets.
    // Selecting the new endpoint is never authorization to change the safety policy.
    if (model === 'ideogram/v4.5') return Object.freeze({mode:'fal-v45-blocked',requestedMode:mode as 'disabled'|'fal'});
    if (mode === 'disabled') return disabled;
    // The deadline limits new submissions. Expired manifests retain exact
    // identity for explicitly authorized status/cancel/result recovery.
    const authorization = manifest(parseControlJSON(readPrivateFile(environment.IDEOGRAM_FAL_APPROVAL_FILE, APPROVAL_BYTES), APPROVAL_BYTES), now);
    const keyBytes = readPrivateFile(environment.FAL_KEY_FILE, KEY_BYTES);
    let key: string;
    try {
      key = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(keyBytes).replace(/\r?\n$/, '');
      if (!/^[\x21-\x7e]+$/.test(key)) return invalid();
    } finally { keyBytes.fill(0); }
    return Object.freeze({ mode: 'fal', manifest: authorization,
      manifestHash: createHash('sha256').update(canonical(authorization)).digest('hex'), key });
  } catch { return invalid(); }
}
