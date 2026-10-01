import type { BlobRef } from '../../src/protocol/store.js';
import type { RasterInfo, RasterManifest } from '../../src/protocol/raster.js';
import type { RasterResult } from '../raster/engine.js';
import { resolveRasterProfile } from '../raster/profile-registry.js';
import { canonical } from '../storage/canonical.js';
import { invalid } from './zip.js';

export class UnsupportedRaster extends Error {
  constructor() { super('RASTER_ENCODER_REPLAY_UNAVAILABLE'); }
}

/** Only encoded-byte variation with independently equal decoded content can
 * reduce a known foreign export to inspection. All other failures stay invalid. */
export async function assertExportRecomputation(
  retained: { manifest: RasterManifest; info: RasterInfo; blob: BlobRef },
  computed: RasterResult,
  currentEncoder: string,
  decode: (which: 'retained' | 'computed') => Promise<RasterInfo>,
): Promise<void> {
  const { manifest, info, blob } = retained, plan = manifest.plan as Record<string, unknown>;
  if (!['frozen-image-export-v1', 'frozen-png-export'].includes(String(plan.kind)) || !resolveRasterProfile(manifest.pipeline, plan) ||
      canonical(computed.manifest) !== canonical(manifest) ||
      canonical(computed.info.pixels) !== canonical(info.pixels) ||
      computed.info.pixelIdentity !== info.pixelIdentity ||
      computed.info.width !== info.width || computed.info.height !== info.height) invalid();
  if (canonical(computed.png) === canonical(blob)) return;
  if (plan.encoder === currentEncoder || blob.mediaType !== computed.png.mediaType) invalid();
  const original = await decode('retained'), replayed = await decode('computed');
  if (original.width !== info.width || original.height !== info.height ||
      replayed.width !== info.width || replayed.height !== info.height ||
      canonical(original.pixels) !== canonical(replayed.pixels)) invalid();
  throw new UnsupportedRaster();
}
