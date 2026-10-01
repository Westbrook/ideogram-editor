import { createHash } from 'node:crypto';
import { canonical } from '../../src/protocol/json.js';
import { PIXEL_PIPELINE } from '../../src/raster/core.js';
import { CODEC_PROFILES } from './codec-platform.js';
import { BOUNDED_WEBP_PROFILES } from './webp-platform.js';
import { WEBP_OUTPUT_PROFILES } from './webp-output-platform.js';
import { LINUX_COLOR_ARM64 } from './linux-color-arm64-identity.js';
import { LINUX_COLOR_X64 } from './linux-color-x64-identity.js';

export type RasterProfile = Readonly<{
  pipeline: string;
  rasterCodecId: string;
  codecId: string;
  platform: string;
  arch: string;
  decoderBuild: string | null;
  outputBuild: string | null;
  decodeTransport: 'webp-bounded-v1' | 'webp-file-v1' | null;
  legacy: boolean;
  current: boolean;
}>;

const hash = (value: unknown) => 'sha256:' + createHash('sha256').update(canonical(value)).digest('hex');
const colors = [LINUX_COLOR_ARM64, LINUX_COLOR_X64] as const;
const mac = CODEC_PROFILES.find(profile => profile.codecs.platform === 'darwin' && profile.codecs.arch === 'arm64')!;
const legacy: RasterProfile = Object.freeze({
  pipeline: PIXEL_PIPELINE + '/' + mac.codecId,
  rasterCodecId: mac.codecId,
  codecId: mac.codecId,
  platform: mac.codecs.platform,
  arch: mac.codecs.arch,
  decoderBuild: null,
  outputBuild: null,
  decodeTransport: null,
  legacy: true,
  current: false,
});

const implementations = CODEC_PROFILES.map(({ codecs, codecId }) => {
  const boundedWebP = BOUNDED_WEBP_PROFILES.find(profile => profile.platform === codecs.platform && profile.arch === codecs.arch);
  if (!boundedWebP) throw new Error('RASTER_PROFILE_IDENTITY');
  const linuxColor = colors.find(profile => profile.platform === codecs.platform && profile.arch === codecs.arch);
  if (codecs.platform === 'linux' && (!linuxColor || linuxColor.codecIdentity !== codecId)) throw new Error('RASTER_PROFILE_IDENTITY');
  const webpOutput = WEBP_OUTPUT_PROFILES.find(profile => profile.platform === codecs.platform && profile.arch === codecs.arch);
  if (!webpOutput || webpOutput.decoderHash !== boundedWebP.hash || webpOutput.converterHash !== (linuxColor?.hash ?? boundedWebP.hash)) throw new Error('RASTER_PROFILE_IDENTITY');
  return { codecs, codecId, boundedWebP, linuxColor, webpOutput };
});

// This inventory names issued profiles, rather than accepting every combination
// of known hashes. In particular, no Linux base-only legacy profile was issued.
// The original mac aggregate has exactly its historical two properties.
export const RASTER_PROFILES: readonly RasterProfile[] = Object.freeze([
  legacy,
  ...implementations.map(({ codecs, codecId, boundedWebP, linuxColor }) => {
    const rasterCodecId = hash({ base: codecId, boundedWebP, ...(linuxColor ? { linuxColor } : {}) });
    return Object.freeze({ pipeline: PIXEL_PIPELINE + '/' + rasterCodecId, rasterCodecId, codecId,
      platform: codecs.platform, arch: codecs.arch, decoderBuild: boundedWebP.hash, outputBuild: null,
      decodeTransport: 'webp-bounded-v1' as const, legacy: false, current: false });
  }),
  ...implementations.map(({ codecs, codecId, boundedWebP, linuxColor, webpOutput }) => {
    const rasterCodecId = hash({ base: codecId, boundedWebP, ...(linuxColor ? { linuxColor } : {}), webpOutput });
    return Object.freeze({ pipeline: PIXEL_PIPELINE + '/' + rasterCodecId, rasterCodecId, codecId,
      platform: codecs.platform, arch: codecs.arch, decoderBuild: boundedWebP.hash, outputBuild: webpOutput.hash,
      decodeTransport: 'webp-file-v1' as const, legacy: false, current: true });
  }),
]);

export function findRasterProfile(pipeline: unknown): RasterProfile | undefined {
  return typeof pipeline === 'string' ? RASTER_PROFILES.find(profile => profile.pipeline === pipeline) : undefined;
}

export function findCurrentRasterProfile(platform: string, arch: string): RasterProfile | undefined {
  return RASTER_PROFILES.find(profile => profile.current && profile.platform === platform && profile.arch === arch);
}

// Unsupported hosts retain a readable profile, but codec qualification still
// compares the host platform/architecture before any native operation.
export const CURRENT_RASTER_PROFILE = findCurrentRasterProfile(process.platform, process.arch) ?? findCurrentRasterProfile('darwin', 'arm64')!;
export const RASTER_CODEC_ID = CURRENT_RASTER_PROFILE.rasterCodecId;
export const PIPELINE = CURRENT_RASTER_PROFILE.pipeline;

export function isKnownRasterEncoder(encoder: unknown): encoder is string {
  return typeof encoder === 'string' && CODEC_PROFILES.some(profile => profile.codecId === encoder);
}

const retainedPlans = new Set([
  'cp1-composition', 'request-source-capture-v1', 'cp1-layer-contribution-v1',
  'authored-mask-v1', 'authored-mask-v2', 'authored-request-mask-v1',
  'request-mask-binary-v1', 'request-source-transport-v1', 'request-preservation-v1',
  'request-mask-resize', 'retained-candidate-v1', 'retained-text',
]);

/** Resolve producer bindings after the independent structural manifest check. */
export function resolveRasterProfile(pipeline: unknown, value: unknown): RasterProfile | undefined {
  const profile = findRasterProfile(pipeline);
  if (!profile || !value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const plan = value as Record<string, unknown>;
  if (plan.kind === 'decoded-native') {
    if (plan.codec !== profile.rasterCodecId) return undefined;
    if (plan.decodeTransport === 'webp-file-v1') return profile.decodeTransport === 'webp-file-v1' && plan.decoderBuild === profile.decoderBuild && plan.outputBuild === profile.outputBuild ? profile : undefined;
    if (plan.outputBuild !== undefined) return undefined;
    if (plan.decodeTransport === 'webp-bounded-v1') return profile.decodeTransport === 'webp-bounded-v1' && plan.decoderBuild === profile.decoderBuild ? profile : undefined;
    if (plan.decoderBuild !== undefined) return undefined;
    if (plan.decodeTransport === 'webp-opaque-incremental-v1') return profile.legacy ? profile : undefined;
    return plan.decodeTransport === undefined ? profile : undefined;
  }
  if (plan.kind === 'frozen-image-export-v1') {
    if (plan.encoder !== profile.codecId || !plan.options || typeof plan.options !== 'object' || Array.isArray(plan.options)) return undefined;
    const format = (plan.options as Record<string, unknown>).format;
    if (format !== 'png' && format !== 'jpeg') return undefined;
    return plan.encoderTransport === undefined || format === 'jpeg' && plan.encoderTransport === 'jpeg-file-baseline-v1' ? profile : undefined;
  }
  // Native-size PNG export retains its source pipeline. The producing encoder
  // can therefore belong to a different known host than the retained pixels.
  if (plan.kind === 'frozen-png-export') return isKnownRasterEncoder(plan.encoder) && plan.encoderTransport === undefined ? profile : undefined;
  return typeof plan.kind === 'string' && retainedPlans.has(plan.kind) ? profile : undefined;
}
