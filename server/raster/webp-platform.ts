import { BOUNDED_WEBP as MAC_BOUNDED_WEBP } from './webp-identity.js';
import { BOUNDED_WEBP_LINUX_ARM64 } from './webp-linux-arm64-identity.js';
import { BOUNDED_WEBP_LINUX_X64 } from './webp-linux-x64-identity.js';

export const BOUNDED_WEBP_PROFILES = [MAC_BOUNDED_WEBP, BOUNDED_WEBP_LINUX_ARM64, BOUNDED_WEBP_LINUX_X64] as const;
export function findBoundedWebPProfile(platform: string, arch: string) {
  return BOUNDED_WEBP_PROFILES.find(profile => profile.platform === platform && profile.arch === arch);
}
// A missing platform cannot acquire native support by falling through: the
// library locator and codec verification compare the selected platform/arch.
export const BOUNDED_WEBP = findBoundedWebPProfile(process.platform, process.arch) ?? MAC_BOUNDED_WEBP;
