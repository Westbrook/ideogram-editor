import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

/** Caller keeps its native diagnostic read live until this write completes.
 * The retained file, not an unowned graph clone, crosses that lifetime. */
export async function retainDiagnosticEvidence(output, label, value) {
  if (!isAbsolute(output) || !/^[a-z0-9-]{1,64}$/.test(label)) throw Error('DIAGNOSTIC_EVIDENCE_DESTINATION');
  const directory = join(output, 'diagnostic-evidence');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, label + '-' + randomUUID() + '.json');
  const serialized = JSON.stringify(value) + '\n';
  const bytes = Buffer.byteLength(serialized), sha256 = 'sha256:' + createHash('sha256').update(serialized).digest('hex');
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(serialized); await file.sync(); }
  finally { await file.close(); }
  return { kind: 'retained-diagnostic-artifact-1', artifact: { path, bytes, sha256 } };
}

const contextKeys = new Set(['commandId', 'documentId', 'layerId', 'sessionId', 'generation', 'snapshotId', 'workspaceSeq', 'revision', 'resultingRevision', 'transactionId', 'correlationId', 'jobId', 'attemptId', 'providerRequestId', 'assetId', 'outputAssetId', 'assetHash', 'candidateId', 'previewId', 'datasetVersion', 'adapterVersion', 'requestId', 'bytes', 'width', 'height', 'sourceWidth', 'sourceHeight', 'requestWidth', 'requestHeight', 'count', 'replay', 'readiness', 'boundary', 'evidenceHash', 'observationSource', 'timingConfidence', 'inputSource', 'composing']);
const scalar = value => value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) || typeof value === 'string' && value.length <= 512 ? value : undefined;
/** A fixed thin result of primitive observations. Never retain a native
 * diagnostic context object, getter, nested value, or an arbitrary field. */
export function diagnosticContext(value) {
  const result = {};
  if (!value || typeof value !== 'object') return result;
  for (const key of contextKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) continue;
    const scalar = descriptor.value;
    if (typeof scalar === 'string' && scalar.length <= 128 || typeof scalar === 'number' && Number.isFinite(scalar) || typeof scalar === 'boolean') result[key] = scalar;
  }
  return result;
}

export function diagnosticPhase(value) {
  if (!value) return null;
  return { ...Object.fromEntries(['sequence', 'phase', 'startedMs', 'endedMs', 'durationMs', 'outcome'].map(key => [key, scalar(value[key])])), context: diagnosticContext(value.context) };
}

export function detachedRasterPhase(value) {
  const result = { ...Object.fromEntries(['name', 'startMs', 'endMs', 'durationMs', 'outcome', 'clock', 'boundary'].map(key => [key, scalar(value[key])])), context: diagnosticContext(value.context) };
  if (value.aggregation !== undefined) result.aggregation = scalar(value.aggregation);
  if (value.clockOriginUnixMs !== undefined) result.clockOriginUnixMs = scalar(value.clockOriginUnixMs);
  if (value.evidence) {
    const e = value.evidence;
    result.evidence = { ...Object.fromEntries(['kind', 'sha256', 'intervalCount', 'retainedIntervals', 'omittedIntervals', 'timing'].map(key => [key, scalar(e[key])])),
      operations: Object.fromEntries(['accumulator', 'contribution', 'fold', 'finish', 'preserve', 'resample', 'matte', 'coverage-scan'].map(key => [key, scalar(e.operations?.[key])])),
      envelope: { startMs: scalar(e.envelope?.startMs), endMs: scalar(e.envelope?.endMs) } };
  }
  return result;
}

// Finite transport schema for encoded rebuild diagnostics. These are newly
// constructed primitive records, never a raw native diagnostic object graph.
export const ENCODED_DIAGNOSTIC_RECORD_LIMIT = 32;
export const ENCODED_DIAGNOSTIC_INPUT_LIMIT = 5;
const own = (value, key) => {
  if (!value || typeof value !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
};
const encodedScalar = value => typeof value === 'string' && value.length <= 256 || typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean' || value === null ? value : undefined;
const fields = (value, keys) => Object.fromEntries(keys.map(key => [key, encodedScalar(own(value, key))]));
const encodedRef = value => fields(value, ['hash', 'byteLength', 'mediaType']);
export function projectEncodedDiagnosticRecords(records) {
  if (!Array.isArray(records) || records.length > ENCODED_DIAGNOSTIC_RECORD_LIMIT) throw Error('ENCODED_DIAGNOSTIC_RECORD_BOUND');
  const result = records.map(record => {
    const evidence = own(record, 'evidence'), inputs = own(evidence, 'inputs');
    if (!Array.isArray(inputs) || inputs.length > ENCODED_DIAGNOSTIC_INPUT_LIMIT) throw Error('ENCODED_DIAGNOSTIC_INPUT_BOUND');
    const output = own(record, 'output');
    return {
      ...fields(record, ['phase', 'operation', 'slot', 'documentId', 'outputAssetId']),
      output: { encoded: encodedRef(own(output, 'encoded')), pixels: encodedRef(own(output, 'pixels')) },
      evidence: {
        ...fields(evidence, ['kind', 'canonicalInputPaths', 'reusedPreparedProducts', 'scratchRemoved', 'decodeCount']),
        inputs: inputs.map(input => ({ kind: encodedScalar(own(input, 'kind')), encoded: encodedRef(own(input, 'encoded')), actual: encodedRef(own(input, 'actual')), expected: encodedRef(own(input, 'expected')) })),
      },
      metrics: fields(own(record, 'metrics'), ['encodedInputCount', 'encodedScratchRemoved', 'decodeMs']),
    };
  });
  if (Buffer.byteLength(JSON.stringify(result)) > 512 * 1024) throw Error('ENCODED_DIAGNOSTIC_TRANSPORT_BOUND');
  return result;
}
export async function retainEncodedDiagnosticEvidence(output, value) {
  // Refuse overflow before writing or certifying a truncated observation.
  const records = projectEncodedDiagnosticRecords(value);
  const raw = await retainDiagnosticEvidence(output, 'encoded-execution', value);
  return { kind: 'retained-encoded-diagnostic-1', raw, records };
}
