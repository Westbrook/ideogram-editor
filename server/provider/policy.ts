import { isIP } from 'node:net';
import { refuse } from './contracts.js';
import type { AppliedPrivacyPolicy, QueueAction, QueueIdentity } from './contracts.js';

export const ENDPOINTS = Object.freeze(['ideogram/v4', 'ideogram/v4/instant', 'ideogram/v4/fast',
  'ideogram/v4/image-to-image', 'ideogram/v4/inpaint', 'ideogram/v4/lora',
  'ideogram/v4/image-to-image/lora', 'ideogram/v4/inpaint/lora']);
export const QUEUE_ORIGIN = 'https://queue.fal.run';
// Q09 has not qualified any production media or authenticated upload endpoint.
export const PRODUCTION_MEDIA_HOSTS: readonly string[] = Object.freeze([]);
export const PRODUCTION_UPLOAD_ORIGINS: readonly string[] = Object.freeze([]);
export type PrivacyProfile = Readonly<{
  id: string; version: number; evidenceDigest: string; endpoint: string;
  mode: 'production' | 'fixture'; enforcement: 'documented' | 'observed' | 'unknown';
  lifecycleSeconds: number; minimumCompatibleSeconds: number; acl: string;
  supportedLifetimes: readonly number[]; supportedACLs: readonly string[];
  mostPrivateACL: string; deferredFetch: 'bounded' | 'renewable' | 'unknown';
  requiredLifetimeSeconds: number | null; renewalQualified: boolean;
  fallback?: Readonly<{ id: string; disclosureDigest: string; lifecycleSeconds: number; acl: string }>;
}>;
export type PolicyAcknowledgement = Readonly<{
  id: string; attemptId: string; profileId: string; profileVersion: number;
  evidenceDigest: string; fallbackId: string; disclosureDigest: string;
}>;
export function resolvePrivacy(profile: PrivacyProfile, endpoint: string, attemptId: string,
  acknowledgement?: PolicyAcknowledgement): { applied: AppliedPrivacyPolicy; headers: Readonly<Record<string, string>> } {
  if (!ENDPOINTS.includes(endpoint) || profile.endpoint !== endpoint || !/^[a-zA-Z0-9_-]{1,128}$/.test(profile.id) ||
      !Number.isSafeInteger(profile.version) || profile.version < 1 || !/^[a-f0-9]{64}$/.test(profile.evidenceDigest) ||
      !['production','fixture'].includes(profile.mode) || !['documented','observed','unknown'].includes(profile.enforcement)) refuse('POLICY');
  const finite = (n: number) => Number.isSafeInteger(n) && n > 0;
  const acl = (s: string) => /^[a-zA-Z0-9_-]{1,80}$/.test(s);
  if (!finite(profile.lifecycleSeconds) || !finite(profile.minimumCompatibleSeconds) ||
      !profile.supportedLifetimes.length || profile.supportedLifetimes.some(n => !finite(n)) ||
      !profile.supportedACLs.length || profile.supportedACLs.some(s => !acl(s)) ||
      !profile.supportedACLs.includes(profile.mostPrivateACL)) refuse('POLICY');
  const minimum = Math.min(...profile.supportedLifetimes.filter(n => n >= profile.minimumCompatibleSeconds));
  let seconds = profile.lifecycleSeconds, access = profile.acl, ack: string | null = null;
  const compatible = profile.enforcement !== 'unknown' && seconds === minimum && access === profile.mostPrivateACL &&
    ((profile.deferredFetch === 'bounded' && profile.requiredLifetimeSeconds !== null && finite(profile.requiredLifetimeSeconds) && seconds >= profile.requiredLifetimeSeconds) ||
      (profile.deferredFetch === 'renewable' && profile.renewalQualified));
  if (!compatible) {
    const f = profile.fallback, a = acknowledgement;
    if (!f || !a || !a.id || a.attemptId !== attemptId || a.profileId !== profile.id || a.profileVersion !== profile.version ||
        a.evidenceDigest !== profile.evidenceDigest || a.fallbackId !== f.id || a.disclosureDigest !== f.disclosureDigest ||
        !/^[a-f0-9]{64}$/.test(f.disclosureDigest)) refuse('POLICY');
    seconds = f.lifecycleSeconds; access = f.acl; ack = a.id;
  }
  if (!profile.supportedLifetimes.includes(seconds) || !profile.supportedACLs.includes(access)) refuse('POLICY');
  const applied: AppliedPrivacyPolicy = Object.freeze({ profileId: profile.id, profileVersion: profile.version,
    evidenceDigest: profile.evidenceDigest, requestedStoreIO: '0', requestedAccess: 'most-private-compatible',
    appliedLifecycleSeconds: seconds, appliedACL: access, enforcement: profile.enforcement, fallbackAcknowledgementId: ack });
  return { applied, headers: Object.freeze({ 'X-Fal-Store-IO': '0',
    'X-Fal-Object-Lifecycle-Preference': JSON.stringify({ expiration_duration_seconds: seconds, initial_acl: access }) }) };
}
export function queuePath(identity: QueueIdentity, action: QueueAction): string {
  if (!ENDPOINTS.includes(identity.endpoint)) refuse('IDENTITY');
  if (action === 'submit') { if (identity.requestId !== undefined) refuse('IDENTITY'); return '/' + identity.endpoint; }
  if (!['status','result','cancel'].includes(action) || !identity.requestId || !/^[a-zA-Z0-9_-]{1,128}$/.test(identity.requestId)) refuse('IDENTITY');
  return '/' + identity.endpoint + '/requests/' + identity.requestId + (action === 'result' ? '' : '/' + action);
}
export function exactURL(raw: string): URL {
  if (typeof raw !== 'string' || raw.length > 16384 || /[\s\\\u0000-\u001f\u007f]/.test(raw)) refuse('IDENTITY');
  let u: URL; try { u = new URL(raw); } catch { return refuse('IDENTITY'); }
  if (u.username || u.password || u.hash || !['https:','http:'].includes(u.protocol) || u.href !== raw) refuse('IDENTITY');
  return u;
}
export function validateQueueURL(raw: string, identity: QueueIdentity, action: QueueAction, origin = QUEUE_ORIGIN): URL {
  const u = exactURL(raw);
  if (u.origin !== origin || u.pathname !== queuePath(identity, action) || u.search) refuse('IDENTITY');
  return u;
}
export function validateProductionMedia(raw: string): URL {
  const u = exactURL(raw);
  if (u.protocol !== 'https:' || u.port || !PRODUCTION_MEDIA_HOSTS.includes(u.hostname)) refuse('POLICY');
  return u;
}
function ipv4Number(ip: string): number { return ip.split('.').reduce((n, p) => n * 256 + Number(p), 0); }
function in4(n: number, base: string, bits: number): boolean { return Math.floor(n / 2 ** (32 - bits)) === Math.floor(ipv4Number(base) / 2 ** (32 - bits)); }
function ipv6Number(ip: string): bigint {
  const [left, right] = ip.toLowerCase().split('::');
  const a = left ? left.split(':') : [], b = right ? right.split(':') : [];
  const words = right !== undefined ? [...a, ...Array(8-a.length-b.length).fill('0'), ...b] : a;
  return words.reduce((n, w) => (n << 16n) | BigInt('0x'+w), 0n);
}
/** Fail-closed global unicast classification; mapped/transition forms never accepted. */
export function isPublicAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const n = ipv4Number(ip);
    return ![['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],
      ['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],
      ['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]
      .some(([base,bits]) => in4(n, base as string, bits as number));
  }
  if (isIP(ip) !== 6 || ip.includes('.') || ip.includes('%')) return false;
  const n = ipv6Number(ip);
  if ((n >> 125n) !== 1n) return false; // only 2000::/3; rejects mapped, NAT64, ULA, link local
  return ![['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]]
    .some(([base,bits]) => (n >> BigInt(128-Number(bits))) === (ipv6Number(String(base)) >> BigInt(128-Number(bits))));
}
export function validateAnswers(answers: readonly {address: string; family: number}[]): void {
  if (!answers.length || answers.some(a => !isPublicAddress(a.address) || isIP(a.address) !== a.family)) refuse('ADDRESS');
}
export function sameAddress(a: string, b: string): boolean {
  if (isIP(a) === 4 && isIP(b) === 4) return a === b;
  return isIP(a) === 6 && isIP(b) === 6 && !a.includes('.') && !b.includes('.') && ipv6Number(a) === ipv6Number(b);
}
