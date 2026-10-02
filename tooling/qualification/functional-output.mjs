import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
/** Explicit output may be on a separate allocated volume; the shared lock stays
 * in its established repository location and needs its own parent setup. */
export function prepareFunctionalOutput(root, id, selectedOutput) {
  const directory = resolve(selectedOutput ?? resolve(root, 'artifacts/qualification', id));
  const lock = resolve(root, 'artifacts/qualification/active.lock');
  mkdirSync(dirname(directory), { recursive: true, mode: 0o700 });
  mkdirSync(directory, { recursive: false, mode: 0o700 });
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  return { directory, lock };
}
