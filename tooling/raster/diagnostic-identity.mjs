import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { release } from 'node:os';
import { CODEC_ID } from '../../dist/local/server/raster/codec-platform.js';
import { PIPELINE } from '../../dist/local/server/raster/profile-registry.js';
import { BOUNDED_WEBP } from '../../dist/local/server/raster/webp-platform.js';
import { LINUX_COLOR } from '../../dist/local/server/raster/linux-color-platform.js';
import { WEBP_OUTPUT } from '../../dist/local/server/raster/webp-output-platform.js';

const files = [
  'server/raster/engine.js', 'server/raster/worker.js', 'server/raster/worker-owner.js', 'server/raster/worker-protocol.js', 'server/raster/container.js',
  'server/raster/active-compute.js', 'server/raster/failure.js', 'server/raster/webp-output.js', 'server/raster/webp-pixels.js',
  'server/raster/webp-output-platform.js', 'server/raster/webp-output-darwin-arm64-identity.js', 'server/raster/webp-output-linux-arm64-identity.js', 'server/raster/webp-output-linux-x64-identity.js',
  'server/raster/bounded-webp.js', 'server/raster/webp-metadata.js', 'server/raster/webp-frame.js',
  'server/raster/webp-color.js', 'server/raster/webp.js', 'server/raster/linux-color.js',
  'server/raster/png.js', 'server/raster/png-input.js', 'server/raster/png-scratch.js', 'server/raster/jpeg.js',
  'server/raster/codec-platform.js', 'server/raster/webp-platform.js',
  'server/raster/linux-color-platform.js', 'server/raster/profile-registry.js',
  'server/raster/identity.js', 'server/raster/identities/linux-arm64-v1.js', 'server/raster/identities/linux-x64-v1.js',
  'server/raster/webp-identity.js', 'server/raster/webp-linux-arm64-identity.js', 'server/raster/webp-linux-x64-identity.js',
  'server/raster/linux-color-arm64-identity.js', 'server/raster/linux-color-x64-identity.js',
  'src/raster/core.js', 'src/raster/mapping.js', 'src/raster/mask.js',
  'server/storage/raster.js', 'server/storage/writer.js', 'server/storage/worker.js', 'server/storage/database.js',
  'server/storage/display.js', 'src/protocol/display.js',
];
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
export async function diagnosticIdentity() {
  return {
    platform: process.platform, arch: process.arch, osRelease: release(),
    scope: 'Exact critical compiled raster/worker/writer/display modules and all retained native identity modules; not a full repository or qualification-source seal.',
    codecIdentity: CODEC_ID, pipeline: PIPELINE, decoder: BOUNDED_WEBP, colorBridge: LINUX_COLOR ?? null, outputBridge: WEBP_OUTPUT,
    sources: Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile('dist/local/' + file))]))),
    diagnosticIdentitySource: hash(await readFile(new URL(import.meta.url))),
  };
}
