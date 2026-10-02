import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

export const nativeImeHash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
export const nativeImeJSON = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
export const NATIVE_IME_LIMITS = Object.freeze({json: 65536, raw: 8 * 1024 * 1024, evidence: 1024 * 1024, evidenceCount: 4, armMs: 30000, reviewMs: 120000});
const text = value => typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= 1024;
const identity = value => typeof value === 'string' ? value.trim().normalize('NFKC').toLocaleLowerCase('en-US') : null;
const pin = value => value && /^[a-f0-9]{32}$/.test(value.nonce ?? '') && /^sha256:[a-f0-9]{64}$/.test(value.sha256 ?? '') && Number.isSafeInteger(value.bytes) && value.bytes > 0;
const evidence = rows => Array.isArray(rows) && rows.length > 0 && rows.length <= NATIVE_IME_LIMITS.evidenceCount && rows.every(row => text(row?.path) && ['os-input-settings', 'native-session-observation'].includes(row.role) && /^sha256:[a-f0-9]{64}$/.test(row.sha256 ?? '') && Number.isSafeInteger(row.bytes) && row.bytes > 0 && row.bytes <= NATIVE_IME_LIMITS.evidence);
const selectionKeys = ['kind', 'operatorPaths', 'armTimeoutMs', 'reviewTimeoutMs'];
export function nativeImeSelection(value, workload) {
  if (!value || typeof value !== 'object' || Object.keys(value).some(key => !selectionKeys.includes(key)) || value.kind !== 'native-ime-selection-1' || !['WXn', 'WXs'].includes(workload) || !text(value.operatorPaths?.[workload]) || Object.keys(value.operatorPaths).some(key => !['WXn', 'WXs'].includes(key))) throw Error('Explicit native IME operator selection required');
  const armTimeoutMs = value.armTimeoutMs ?? NATIVE_IME_LIMITS.armMs, reviewTimeoutMs = value.reviewTimeoutMs ?? NATIVE_IME_LIMITS.reviewMs;
  if (!Number.isSafeInteger(armTimeoutMs) || armTimeoutMs < 1 || armTimeoutMs > NATIVE_IME_LIMITS.armMs || !Number.isSafeInteger(reviewTimeoutMs) || reviewTimeoutMs < 1 || reviewTimeoutMs > NATIVE_IME_LIMITS.reviewMs) throw Error('Native IME setup/review wait exceeds its bound');
  return {kind: value.kind, operatorPath: value.operatorPaths[workload], armTimeoutMs, reviewTimeoutMs};
}

/** External manual authority is explicitly distinct from collector observations.
 * A valid shape does not establish a native session without independently
 * retained review and a fresh raw attempt binding. */
export function inspectNativeImeOperator(operator, plan) {
  const missing = [];
  if (operator?.kind !== 'native-ime-operator-1' || operator.actualNative !== true || !['human', 'os-automation'].includes(operator.method?.kind) || !text(operator.operatorId) || !text(operator.method?.description)) missing.push('Actual external operator or OS automation method evidence');
  if (operator?.inputSource?.language !== plan.inputSource || !text(operator?.inputSource?.id) || !text(operator?.inputSource?.build) || !text(operator?.dictionary) || !text(operator?.settings)) missing.push('Exact native input source, build, dictionary and settings evidence');
  if (!text(operator?.os?.name) || !text(operator?.os?.version) || !text(operator?.os?.build) || (!evidence(operator?.evidence) || !operator.evidence.some(row => row.role === 'os-input-settings'))) missing.push('Original OS/input-source settings evidence files');
  return {status: missing.length ? 'INCONCLUSIVE' : 'PASS', missing, qualification: false};
}

export function inspectNativeImeReview(review, {operator, plan, nonce, binding, raw, planArtifact, sealedAt, receivedAt, reviewTimeoutMs}) {
  const missing = [];
  if (review?.kind !== 'native-ime-review-1' || review.complete !== true || review.actualNative !== true || review.synthetic !== false || review.collectorGenerated !== false) missing.push('Complete independent actual-native review');
  if (!text(review?.reviewerId) || identity(review.reviewerId) === identity(operator.operatorId) || !text(review?.method) || !text(review?.observations) || (!evidence(review?.evidence) || !review.evidence.some(row => row.role === 'native-session-observation'))) missing.push('Independent reviewer identity, method, observations and original evidence');
  if (review?.nonce !== nonce || !isDeepStrictEqual(review?.binding, binding) || !isDeepStrictEqual(review?.raw, raw) || !isDeepStrictEqual(review?.plan, planArtifact) || review?.inputSource !== plan.inputSource) missing.push('Independent review exact fresh attempt/plan/raw binding');
  const reviewedAt = Date.parse(review?.reviewedAt ?? '');
  if (![sealedAt, receivedAt, reviewedAt].every(Number.isFinite) || reviewedAt < sealedAt || reviewedAt > receivedAt || receivedAt - sealedAt > reviewTimeoutMs || receivedAt < sealedAt) missing.push('Independent review arrived within this live attempt after raw seal');
  if (![binding, raw, planArtifact].every(item => pin({...item, nonce}))) missing.push('Bounded retained native evidence identities');
  return {status: missing.length ? 'INCONCLUSIVE' : 'PASS', missing, qualification: false, authority: 'external-independent-operator-review', physicalPresentation: false, scanout: false};
}
