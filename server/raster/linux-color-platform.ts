import { LINUX_COLOR_ARM64 } from './linux-color-arm64-identity.js';
import { LINUX_COLOR_X64 } from './linux-color-x64-identity.js';

export const LINUX_COLOR_PROFILES = [LINUX_COLOR_ARM64, LINUX_COLOR_X64] as const;
export function findLinuxColorProfile(arch: string) {
  return LINUX_COLOR_PROFILES.find(profile => profile.arch === arch);
}
// macOS retains its original sealed public-LCMS route and pipeline identity.
export const LINUX_COLOR = process.platform === 'linux' ? findLinuxColorProfile(process.arch) : undefined;
