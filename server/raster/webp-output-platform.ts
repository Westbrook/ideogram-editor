import { WEBP_OUTPUT_DARWIN_ARM64 } from './webp-output-darwin-arm64-identity.js';
import { WEBP_OUTPUT_LINUX_ARM64 } from './webp-output-linux-arm64-identity.js';
import { WEBP_OUTPUT_LINUX_X64 } from './webp-output-linux-x64-identity.js';

export const WEBP_OUTPUT_PROFILES = [WEBP_OUTPUT_DARWIN_ARM64, WEBP_OUTPUT_LINUX_ARM64, WEBP_OUTPUT_LINUX_X64] as const;
export function findWebPOutputProfile(platform: string, arch: string) {
  return WEBP_OUTPUT_PROFILES.find(profile => profile.platform === platform && profile.arch === arch);
}

// Codec qualification and the bridge loader independently reject unsupported
// hosts before acquiring native support; this fallback is only a readable seal.
export const WEBP_OUTPUT = findWebPOutputProfile(process.platform, process.arch) ?? WEBP_OUTPUT_DARWIN_ARM64;
