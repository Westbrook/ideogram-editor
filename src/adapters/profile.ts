import type { SafetensorsStructure } from './structure.js';

export type AdapterProfileInput = Readonly<{ structure: SafetensorsStructure; weightsHash: string;
  declaredFamily: string; declaredFormat: string; configHash: string | null; origin: 'import' | 'training' }>;
export type RetainedAdapterProfileInput = Omit<AdapterProfileInput, 'structure'> & Readonly<{ tensorSignature: string }>;
export type AdapterCompatibility = Readonly<{ status: 'structurally-valid' | 'incompatible'; locallyEligible: boolean;
  profileId: string | null; runtimeVerified: false; reason: string }>;
/** Exact known-artifact evidence only. Generalized tensor interoperability needs
 * separate qualification; importing a JSON document cannot add trusted profiles. */
export type SealedAdapterProfile = Readonly<{ kind: 'ideogram-v4-artifact-profile-1'; id: string;
  family: 'ideogram-v4'; format: 'fal'; weightsHash: string; configHash: string | null;
  tensorSignature: string; evidenceHash: string }>;
const digest = (value: unknown): value is string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);

// Exact public artifact from Fal's own examples page, captured 2026-09-30. Its
// complete bytes and tensor ranges were verified. This is local applicability
// evidence only: the published example has json_output:null, and no current app
// inference was performed. The separate header/evidence fixture records scope.
// Other weights, even with identical tensor shapes, require new qualification.
const supportedProfiles: readonly SealedAdapterProfile[] = Object.freeze([Object.freeze({
  kind: 'ideogram-v4-artifact-profile-1', id: 'v4-fal-public-example-1', family: 'ideogram-v4', format: 'fal',
  weightsHash: 'sha256:bd0b96a2fcc3141400ebeffd8585b2d3c4c0d475b10e1468ba5c40acad748bc5', configHash: null,
  tensorSignature: 'sha256:7df49bdf7165de3986b1360a4f9510340fa7b96927405d339d751c83f937d9c6',
  evidenceHash: 'sha256:82f0300bf1d374171a250237a8c18017288f28f80dad5b916557c8e241bb9dbd',
})]);
export const adapterProfileAvailability = Object.freeze({ kind: 'adapter-profile-availability-1',
  supportedProfiles: supportedProfiles.length,
  reason: 'One exact provider-published V4 adapter has a supported local profile. Other weights require qualification; runtime verification remains separate.' });
export function isSupportedAdapterProfile(id: unknown): boolean {
  return typeof id === 'string' && supportedProfiles.some(profile => profile.id === id);
}

/** Pure comparison used while reviewing an app-distributed evidence profile.
 * Passing this comparison does not install the profile or grant eligibility. */
export function matchesSealedAdapterProfile(input: AdapterProfileInput, profile: SealedAdapterProfile): boolean {
  return input.structure.kind === 'safetensors-inspection-1' && matchesRetainedProfile({ ...input,
    tensorSignature: input.structure.tensorSignature }, profile);
}
function matchesRetainedProfile(input: RetainedAdapterProfileInput, profile: SealedAdapterProfile): boolean {
  return profile.kind === 'ideogram-v4-artifact-profile-1' && /^[a-z0-9][a-z0-9._-]{0,127}$/.test(profile.id) &&
    profile.family === 'ideogram-v4' && profile.format === 'fal' && digest(profile.weightsHash) &&
    digest(profile.tensorSignature) && digest(profile.evidenceHash) &&
    (profile.configHash === null || digest(profile.configHash)) &&
    input.declaredFamily === profile.family && input.declaredFormat === profile.format &&
    input.weightsHash === profile.weightsHash && input.configHash === profile.configHash &&
    input.tensorSignature === profile.tensorSignature &&
    (input.origin === 'import' || (input.origin === 'training' && input.configHash !== null));
}

export function inspectAdapterProfile(input: AdapterProfileInput): AdapterCompatibility {
  return retainedAdapterProfile({ weightsHash: input.weightsHash, declaredFamily: input.declaredFamily,
    declaredFormat: input.declaredFormat, configHash: input.configHash, origin: input.origin,
    tensorSignature: input.structure.kind === 'safetensors-inspection-1' ? input.structure.tensorSignature : '' });
}

/** Re-derive eligibility only from shipped evidence and retained immutable
 * identities. Imported profile IDs or local-eligibility flags grant no authority.
 * The caller proves original bytes and obtains the signature from inspection. */
export function retainedAdapterProfile(input: RetainedAdapterProfileInput): AdapterCompatibility {
  const result = (status: AdapterCompatibility['status'], reason: string, profileId: string | null = null): AdapterCompatibility =>
    Object.freeze({ status, locallyEligible: profileId !== null, profileId, runtimeVerified: false, reason });
  if (!digest(input.weightsHash) || !digest(input.tensorSignature) || (input.configHash !== null && !digest(input.configHash)))
    return result('incompatible', 'Artifact identity is invalid. Restore the original verified bytes.');
  if (input.declaredFamily !== 'ideogram-v4')
    return result('incompatible', 'This declared family is not Ideogram V4. Replace the file or correct its provenance.');
  if (input.declaredFormat !== 'fal')
    return result('incompatible', 'This format has no supported Ideogram V4 inference profile. No conversion was performed.');
  if (input.origin === 'training' && input.configHash === null)
    return result('structurally-valid', 'Weights retained; training configuration is still required.');
  const match = supportedProfiles.find(profile => matchesRetainedProfile(input, profile));
  if (match) return result('structurally-valid', 'Locally eligible; not runtime verified. Explicit request acknowledgement is required.', match.id);
  return result('structurally-valid', input.configHash === null
    ? 'Config not supplied; V4 compatibility not runtime verified. No supported local profile matches these retained weights.'
    : 'Stored — compatibility unverified. No supported local V4 profile matches these retained weights and configuration.');
}
