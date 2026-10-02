import { PrerequisiteError, fileIdentity } from './common.mjs';
import { dirname, isAbsolute, join } from 'node:path';
import { projectEncodedDiagnosticRecords } from './diagnostic-evidence.mjs';

export const encodedInterpretationMissing = 'Encoded-capability rebuilding preserves canonical authoritative history bytes; literal encoded-only durable C is not established';
const opaque = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const hash = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const ref = value => !!value && hash(value.hash) && typeof value.byteLength === 'string' && /^[1-9][0-9]*$/.test(value.byteLength) && Number.isSafeInteger(Number(value.byteLength)) && typeof value.mediaType === 'string';
const sameRef = (a, b) => ref(a) && ref(b) && a.hash === b.hash && a.byteLength === b.byteLength && a.mediaType === b.mediaType;
const grid = value => Number.isSafeInteger(value?.width) && value.width > 0 && Number.isSafeInteger(value?.height) && value.height > 0 && value.width * value.height <= 25000000;
const fail = message => { throw new PrerequisiteError(message); };

/** Public metadata is a frozen identity witness, not a cache or decode witness. */
export function verifyEncodedReview(review, document, candidate, placement) {
  const input = review?.inputs, encoded = input?.encodedRebuild;
  if (!opaque(document?.id) || typeof document.revision !== 'string' || !opaque(candidate?.id) || !opaque(candidate.preparedAssetId) || !opaque(candidate.encodedAssetId)) fail('Exact document and retained candidate identities are required');
  if (review?.kind !== 'candidate-placement-review-1' || !opaque(review.reviewId) || !hash(review.reviewHash) || review.preparation !== 'deferred' || review.documentId !== document?.id || review.documentRevision !== document?.revision || review.placement?.placement !== placement || review.placement?.mode !== 'safe-region' || input?.mode !== 'safe-region' || input.identity?.candidateId !== candidate?.id || input.identity.preparedAssetId !== candidate.preparedAssetId || encoded?.kind !== 'encoded-adoption-inputs-1') fail('The public encoded review does not bind the exact safe-region candidate and accepted document');
  if (!['current-document', 'new-document'].includes(placement) || placement === 'current-document' && input.sourceCapture?.scope !== 'visible-document') fail('Encoded placement needs a new document or the frozen whole visible document');
  if (placement === 'new-document' && !opaque(review.placement.newDocumentId)) fail('The public encoded review lacks its exact new document identity');
  for (const image of [encoded.source, encoded.candidate]) {
    if (!opaque(image?.assetId) || !opaque(image.encodedAssetId) || !hash(image.assetHash) || typeof image.assetVersion !== 'string' || !grid(image.info) || !ref(image.info.pixels) || Number(image.info.pixels.byteLength) !== image.info.width * image.info.height * 4 || !ref(image.encoded)) fail('A frozen encoded raster identity is incomplete');
  }
  if (encoded.source.encoding !== 'canonical-png' || encoded.source.encodedAssetId !== encoded.source.assetId || encoded.source.encoded.mediaType !== 'image/png' || encoded.candidate.encoding !== 'candidate-original' || encoded.candidate.assetId !== candidate.preparedAssetId || encoded.candidate.encodedAssetId !== candidate.encodedAssetId || !['image/png', 'image/jpeg', 'image/webp'].includes(encoded.candidate.encoded.mediaType)) fail('Encoded source or original candidate identity differs from the reviewed input');
  if (!opaque(encoded.mask?.assetId) || !hash(encoded.mask.assetHash) || !grid(encoded.mask.info)) fail('The frozen mask identity is incomplete');
  for (const value of [encoded.mask.authored, encoded.mask.effective, encoded.mask.approved]) {
    if (value?.codec !== 'r16le-deflate-v1' || !ref(value.encoded) || value.encoded.mediaType !== 'application/x-ideogram-r16le-deflate' || !ref(value.pixels) || value.pixels.mediaType !== 'application/x-ideogram-r16le' || !grid(value) || value.width !== encoded.mask.info.width || value.height !== encoded.mask.info.height || Number(value.pixels.byteLength) !== value.width * value.height * 2) fail('The review must retain lossless exact R16 encoded inputs');
  }
  if (!sameRef(encoded.source.info.pixels, input.plan?.sourcePixels) || !sameRef(encoded.mask.authored.pixels, input.plan?.authoredMask) || !sameRef(encoded.mask.effective.pixels, input.plan?.effectiveMask) || !sameRef(encoded.mask.approved.pixels, input.outputMapping?.effectiveMask ?? input.plan?.effectiveMask)) fail('Encoded inputs differ from the exact frozen preservation plan');
  return { kind: 'public-encoded-review-identity-1', reviewId: review.reviewId, reviewHash: review.reviewHash, documentId: document.id, revision: document.revision, candidateId: candidate.id, placement, targetDocumentId: placement === 'new-document' ? review.placement.newDocumentId : document.id, encoded, readiness: 'encoded-rebuild-capability', requestedReadiness: 'C', literalEncodedOnlyDurable: false, presentationClaim: false };
}

/** These records come from the owned writer's completed actual worker jobs.
 * No DOM state or phase label can stand in for the input hashes and decode count. */
export function verifyEncodedExecution(records, prepared, commandId, compositeAssetId) {
  if (!Array.isArray(records) || !prepared?.encoded || !opaque(commandId) || !opaque(compositeAssetId)) fail('Owned acceptance execution identities are unavailable');
  records = projectEncodedDiagnosticRecords(records);
  const observed = records.filter(record => record?.phase === 'encoded-input-rebuild' && record.slot === 'history:' + commandId);
  if (observed.length !== 2 || observed[0].operation !== 'encoded-preserve' || observed[1].operation !== 'encoded-compose' || observed[1].outputAssetId !== compositeAssetId) fail('The exact acceptance has no complete preservation and final composition decode evidence');
  const encoded = prepared.encoded;
  const expected = [
    [encoded.source.encoded, encoded.source.info.pixels, 'rgba8'],
    [encoded.candidate.encoded, encoded.candidate.info.pixels, 'rgba8'],
    ...[encoded.mask.authored, encoded.mask.effective, encoded.mask.approved].map(mask => [mask.encoded, mask.pixels, 'r16le']),
  ];
  for (const [index, record] of observed.entries()) {
    const proof = record.evidence, count = index === 0 ? 5 : 1;
    if (proof?.kind !== 'encoded-input-rebuild-1' || proof.canonicalInputPaths !== 0 || proof.reusedPreparedProducts !== 0 || proof.scratchRemoved !== true || proof.decodeCount !== count || proof.inputs?.length !== count || record.metrics?.encodedInputCount !== count || record.metrics.encodedScratchRemoved !== 1 || !Number.isFinite(record.metrics.decodeMs) || record.metrics.decodeMs < 0) fail('Encoded acceptance decode/cleanup evidence is incomplete');
    for (const [at, input] of proof.inputs.entries()) {
      if (!ref(input.encoded) || !sameRef(input.actual, input.expected) || !['rgba8', 'r16le'].includes(input.kind)) fail('Fresh decoded bytes do not match the frozen canonical hash');
      if (index === 0 && (!sameRef(input.encoded, expected[at][0]) || !sameRef(input.expected, expected[at][1]) || input.kind !== expected[at][2])) fail('The actual decoder used inputs other than the reviewed encoded capabilities');
      if (index === 1 && input.kind !== 'rgba8') fail('Final composition did not decode its actual image input');
    }
  }
  const preserved = observed[0].output, finalInput = observed[1].evidence.inputs[0];
  if (!sameRef(preserved?.encoded, finalInput.encoded) || !sameRef(preserved?.pixels, finalInput.expected) || !ref(observed[1].output?.encoded) || !ref(observed[1].output?.pixels)) fail('Final composition does not decode the exact fresh preservation output');
  return { kind: 'actual-encoded-acceptance-execution-1', commandId, records: observed, decodeCount: 6, canonicalInputPaths: 0, reusedPreparedProducts: 0, scratchRemoved: true, literalEncodedOnlyDurable: false, missing: [encodedInterpretationMissing] };
}

/** Actual IPC carries only the finite projection. The complete original raw
 * artifact is retained and streamed for identity validation, never parsed into
 * another unowned diagnostic graph in this process. */
export async function verifyRetainedEncodedExecution(value, prepared, commandId, compositeAssetId, output) {
  const artifact = value?.raw?.artifact;
  if (value?.kind !== 'retained-encoded-diagnostic-1' || value.raw?.kind !== 'retained-diagnostic-artifact-1' || !isAbsolute(output ?? '') || typeof artifact?.path !== 'string' || artifact.path.length > 4096 || dirname(artifact.path) !== join(output, 'diagnostic-evidence') || !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0 || !hash(artifact.sha256)) fail('Retained encoded diagnostic artifact is unavailable or outside the campaign output');
  const actual = await fileIdentity(artifact.path);
  if (actual.bytes !== artifact.bytes || actual.sha256 !== artifact.sha256) fail('Retained encoded diagnostic artifact identity changed');
  const result = verifyEncodedExecution(value.records, prepared, commandId, compositeAssetId);
  return { ...result, diagnosticArtifact: { path: artifact.path, bytes: artifact.bytes, sha256: artifact.sha256 }, evidenceRepresentation: 'bounded-enumerated-primitive-projection-with-complete-raw-artifact' };
}
