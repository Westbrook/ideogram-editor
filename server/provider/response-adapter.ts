/** Staged proposal only. No production import, network access, decoding, or safety override. */
export type ResponseProfile = 'ideogram-v4-result-1' | 'ideogram-v45-result-1';
export type ResponseDescriptor = Readonly<{ profile: ResponseProfile; endpoint: string }>;
/** Structural output of the existing bounded scanEnvelope, after source-body verification. */
export type EnvelopeScan = Readonly<{
  foundPrompt: boolean;
  seed: string | null;
  timings: Readonly<Record<string, number>>;
  images: readonly Readonly<Record<string, unknown>>[];
  safety: readonly unknown[];
  imagesArray: boolean;
  safetyArray: boolean;
  timingsObject: boolean;
  timingsValid: boolean;
}>;
export type AdaptationInput = Readonly<{
  requestedCount: number;
  sourceComplete: boolean;
  envelope: EnvelopeScan | null;
}>;
type Availability = 'present' | 'missing-required' | 'invalid' | 'unavailable-by-contract';
type Safety = 'safe' | 'unknown' | 'withheld';
export type OutputDecision = Readonly<{
  index: number;
  present: boolean;
  safety: Safety;
  safetyReason: 'provider-false-observation' | 'provider-true-observation' | 'mapping-unavailable' | 'metadata-unavailable-by-contract';
  state: 'missing' | 'received' | 'withheld';
  media: 'none' | 'retain-protected-encoded' | 'fetch-validate-prepare';
  /** This gate precedes decoding; permission is conditional on transport/byte/resource validation. */
  decodeAllowed: boolean;
  /** These are always false until a later, independently fenced successful preparation. */
  displayAllowed: false;
  adoptionAllowed: false;
  exportAllowed: false;
  publicationAfterValidatedPreparation: boolean;
  declared: Readonly<{ contentType: string | null; byteLength: number | null; width: number | null; height: number | null }>;
}>;
export type AdaptedResponse = Readonly<{
  schemaVersion: 1;
  profile: ResponseProfile;
  endpoint: string;
  envelope: Readonly<{ schemaValid: boolean; candidateBasisValid: boolean; issues: readonly string[] }>;
  observationPhase: 'completed' | 'quarantined';
  actualCount: number | null;
  returnedSeed: string | null;
  metadata: Readonly<{
    schemaVersion: 2;
    returnedPrompt: Readonly<{ status: Availability; deriveDecodedPrompt: boolean }>;
    timings: Readonly<{ status: Availability; values: Readonly<Record<string, number>> | null; units: 'unknown' | null }>;
    safety: Readonly<{ status: 'aligned' | 'mapping-unavailable' | 'unavailable-by-contract'; authority: 'v4-correspondence-1' | null }>;
    dimensions: Readonly<{ status: 'optional-provider-metadata' | 'unavailable-by-contract'; measured: 'not-yet-validated' }>;
    /** No legacy TP-1.complete=true may be manufactured from this status. */
    provenance: Readonly<{ status: 'requires-prompt-derivation' | 'partial'; reason: 'returned-prompt-unavailable-by-contract' | 'returned-prompt-missing-required' | 'source-incomplete-or-unparseable' | null }>;
  }>;
  outputs: readonly OutputDecision[];
}>;

const v4Endpoints = new Set([
  'ideogram/v4', 'ideogram/v4/instant', 'ideogram/v4/fast', 'ideogram/v4/image-to-image',
  'ideogram/v4/inpaint', 'ideogram/v4/lora', 'ideogram/v4/image-to-image/lora', 'ideogram/v4/inpaint/lora',
]);
const v45Endpoints = new Set(['ideogram/v4.5', 'ideogram/v4.5/edit']);
const exactInteger = (value: unknown): value is string => typeof value === 'string' && /^-?(0|[1-9][0-9]*)$/.test(value);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const optionalNumber = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
function validateFile(image: Readonly<Record<string, unknown>>, dimensions: boolean): boolean {
  if (!record(image) || typeof image.url !== 'string') return false;
  if (image.content_type != null && typeof image.content_type !== 'string') return false;
  if (image.file_name != null && typeof image.file_name !== 'string') return false;
  if (image.file_size != null && optionalNumber(image.file_size) === null) return false;
  if (dimensions && ['width', 'height'].some(key => image[key] != null && optionalNumber(image[key]) === null)) return false;
  return true;
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Select by immutable reviewed profile + endpoint, never by fields observed in a response. */
export function adaptResponse(descriptor: ResponseDescriptor, input: AdaptationInput): AdaptedResponse {
  const legacy = descriptor.profile === 'ideogram-v4-result-1';
  if ((!legacy && descriptor.profile !== 'ideogram-v45-result-1') || !(legacy ? v4Endpoints : v45Endpoints).has(descriptor.endpoint)) {
    throw new Error('RESPONSE_PROFILE_ENDPOINT_MISMATCH');
  }
  if (!Number.isSafeInteger(input.requestedCount) || input.requestedCount < 1 || input.requestedCount > 4) throw new Error('REQUESTED_COUNT');
  // A partial or unparseable protected body never contributes guessed ownership.
  const e = input.sourceComplete ? input.envelope : null;
  const issues: string[] = [];
  if (!input.sourceComplete) issues.push('SOURCE_INCOMPLETE');
  else if (!e) issues.push('ENVELOPE_UNPARSEABLE');
  const imagesPresent = !!e?.imagesArray;
  const seed = exactInteger(e?.seed) ? e!.seed : null;
  const imageFilesValid = imagesPresent && e!.images.every(image => validateFile(image, legacy));
  if (!imagesPresent) issues.push('IMAGES_REQUIRED');
  else if (!imageFilesValid) issues.push('IMAGE_FILE_INVALID');
  if (seed === null) issues.push('SEED_REQUIRED_EXACT_INTEGER');
  const timingsPresent = !!e?.timingsObject;
  const timingsValid = timingsPresent && !!e?.timingsValid;
  const promptPresent = !!e?.foundPrompt;
  const safetyTyped = !!e?.safetyArray && e!.safety.every(value => typeof value === 'boolean');

  // Preserve current V4's independent-slot behavior exactly: prompt absence and
  // malformed File metadata do not erase safe slots; timings remain required.
  const candidateBasisValid = legacy
    ? imagesPresent && seed !== null && timingsValid
    : imagesPresent && seed !== null && imageFilesValid;
  const aligned = legacy && candidateBasisValid && safetyTyped && e!.safety.length === e!.images.length;
  if (legacy) {
    if (!promptPresent) issues.push('PROMPT_REQUIRED');
    if (!timingsPresent) issues.push('TIMINGS_REQUIRED');
    else if (!timingsValid) issues.push('TIMINGS_INVALID');
    if (!safetyTyped) issues.push('SAFETY_ARRAY_REQUIRED');
    else if (e!.safety.length !== e!.images.length) issues.push('SAFETY_MAPPING_UNAVAILABLE');
  }
  const schemaValid = imagesPresent && seed !== null && imageFilesValid && (!legacy || promptPresent && timingsValid && safetyTyped);
  const actualCount = imagesPresent ? e!.images.length : null;
  const outputs: OutputDecision[] = [];
  for (let index = 0; index < Math.max(input.requestedCount, actualCount ?? 0); index++) {
    const image = e?.images[index];
    const present = !!image && typeof image.url === 'string';
    const safety: Safety = aligned ? e!.safety[index] === false ? 'safe' : e!.safety[index] === true ? 'withheld' : 'unknown' : 'unknown';
    const usable = present && safety === 'safe';
    outputs.push({
      index, present, safety,
      safetyReason: !legacy ? 'metadata-unavailable-by-contract' : safety === 'safe' ? 'provider-false-observation' : safety === 'withheld' ? 'provider-true-observation' : 'mapping-unavailable',
      state: !present ? 'missing' : usable ? 'received' : 'withheld',
      media: !present ? 'none' : usable ? 'fetch-validate-prepare' : 'retain-protected-encoded',
      decodeAllowed: usable,
      displayAllowed: false, adoptionAllowed: false, exportAllowed: false,
      publicationAfterValidatedPreparation: usable,
      declared: {
        contentType: typeof image?.content_type === 'string' ? image.content_type : null,
        byteLength: optionalNumber(image?.file_size),
        width: legacy ? optionalNumber(image?.width) : null,
        height: legacy ? optionalNumber(image?.height) : null,
      },
    });
  }
  const promptStatus: Availability = !legacy ? 'unavailable-by-contract' : promptPresent ? 'present' : 'missing-required';
  const provenanceReason = !e ? 'source-incomplete-or-unparseable' : !legacy ? 'returned-prompt-unavailable-by-contract' : !promptPresent ? 'returned-prompt-missing-required' : null;
  return deepFreeze({
    schemaVersion: 1, profile: descriptor.profile, endpoint: descriptor.endpoint,
    envelope: { schemaValid, candidateBasisValid, issues },
    observationPhase: candidateBasisValid ? 'completed' : 'quarantined',
    actualCount, returnedSeed: seed,
    metadata: {
      schemaVersion: 2,
      returnedPrompt: { status: promptStatus, deriveDecodedPrompt: legacy && promptPresent },
      timings: { status: !legacy ? 'unavailable-by-contract' : !timingsPresent ? 'missing-required' : timingsValid ? 'present' : 'invalid', values: legacy ? { ...(e?.timings ?? {}) } : null, units: legacy ? 'unknown' : null },
      safety: { status: !legacy ? 'unavailable-by-contract' : aligned ? 'aligned' : 'mapping-unavailable', authority: legacy && aligned ? 'v4-correspondence-1' : null },
      dimensions: { status: legacy ? 'optional-provider-metadata' : 'unavailable-by-contract', measured: 'not-yet-validated' },
      provenance: { status: provenanceReason === null ? 'requires-prompt-derivation' : 'partial', reason: provenanceReason },
    },
    outputs,
  });
}
