import { verifyFixtureManifest } from './fixtures.mjs';
import { PrerequisiteError } from './common.mjs';

/** A mixed job (for example C9 WJ + WF) resolves exact sealed fixtures by cell,
 * then workload+closure size, then workload. A smaller fixture is never a silent
 * fallback for an absent maximum-size closure. */
export function selectFixtureDescriptor(catalog, cell) {
  if (!catalog) return null;
  if (catalog.kind !== 'perf-fixture-catalog-1') return catalog;
  if (!catalog.fixtures || typeof catalog.fixtures !== 'object' || Array.isArray(catalog.fixtures)) throw Error('Invalid fixture catalog');
  const exact = catalog.cells?.[cell.id];
  if (exact) {
    const selected = typeof exact === 'string' ? catalog.fixtures[exact] : exact;
    if (!selected) throw new PrerequisiteError(`Cell fixture reference ${exact} is absent`);
    return selected;
  }
  const size = cell.parameters?.closureBytes;
  const key = size === undefined ? cell.workload : `${cell.workload}:${size}`;
  const descriptor = catalog.fixtures[key];
  if (!descriptor) throw new PrerequisiteError(`No sealed fixture selected for ${cell.id} (${key})`);
  return descriptor;
}

export async function selectFixture(catalog, cell) {
  const descriptor = selectFixtureDescriptor(catalog, cell);
  if (!descriptor) {
    if (cell.requirements?.sealedFixture && cell.handler !== 'developer') throw new PrerequisiteError(`A sealed ${cell.workload} fixture is required for ${cell.id}`);
    return null;
  }
  const fixture = await verifyFixtureManifest(descriptor);
  const closureBytes = cell.parameters?.closureBytes;
  const expectedWorkload = cell.workload === 'WC' ? closureBytes === 536870912 ? 'WC512' : closureBytes === 4294967296 ? 'WC4G' : null : cell.workload;
  if (fixture.workload !== expectedWorkload) throw new PrerequisiteError(`Fixture ${fixture.workload} does not match ${cell.workload}`);
  if (closureBytes !== undefined && Number(fixture.observed?.closureBytes ?? fixture.observed?.ownedBytes ?? fixture.observed?.totalOwnedBytes ?? fixture.definition?.ownedBytes ?? fixture.definition?.closureBytes) !== closureBytes) throw new PrerequisiteError('Portable fixture closure size does not match this cell');
  return fixture;
}
