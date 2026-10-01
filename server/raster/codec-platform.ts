import { CODECS as MAC_CODECS, CODEC_ID as MAC_CODEC_ID } from './identity.js';
import { CODECS as LINUX_ARM64_CODECS, CODEC_ID as LINUX_ARM64_CODEC_ID } from './identities/linux-arm64-v1.js';
import { CODECS as LINUX_X64_CODECS, CODEC_ID as LINUX_X64_CODEC_ID } from './identities/linux-x64-v1.js';

// Preserve the original platform identity and every adopted platform identity.
// Retained/portable profile checks use this inventory independently of the host.
export const CODEC_PROFILES = [
  { codecs: MAC_CODECS, codecId: MAC_CODEC_ID },
  { codecs: LINUX_ARM64_CODECS, codecId: LINUX_ARM64_CODEC_ID },
  { codecs: LINUX_X64_CODECS, codecId: LINUX_X64_CODEC_ID },
] as const;

export function findCodecProfile(platform: string, arch: string) {
  return CODEC_PROFILES.find(profile => profile.codecs.platform === platform && profile.codecs.arch === arch);
}

const selected = findCodecProfile(process.platform, process.arch);
// Unsupported hosts retain a readable historical identity. Existing runtime
// qualification must compare platform/arch and refuse before native execution.
export const CODECS = selected?.codecs ?? MAC_CODECS;
export const CODEC_ID = selected?.codecId ?? MAC_CODEC_ID;
