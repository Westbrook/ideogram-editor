import {readFileSync} from 'node:fs';
import {loadPinnedCanonical} from './pinned-canonical-source.mjs';
// Execute only the exact pinned implementation from the current trusted
// checkout. Captured capsule source remains data, including historical inputs.
const implementation=await loadPinnedCanonical(readFileSync(new URL('../../../src/protocol/json.ts',import.meta.url)));
export const {canonical,JSONError,parseControlJSON,CONTROL_BYTES}=implementation;
