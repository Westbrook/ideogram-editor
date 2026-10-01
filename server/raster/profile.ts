import { resolveRasterProfile } from './profile-registry.js';

// Structural manifest validation accepts retained version hashes. Editable
// portable imports additionally require a profile whose producer is known here.
export function supportsRasterProfile(pipeline: string, value: unknown): boolean {
  return resolveRasterProfile(pipeline, value) !== undefined;
}
