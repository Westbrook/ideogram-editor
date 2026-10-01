import type { BlobRef } from '../../src/protocol/store.js';
import type { ContributionStack, RasterInfo, RasterLayer, RasterManifest } from '../../src/protocol/raster.js';
import { blob, contributionStack, rasterManifest, requireValue } from '../../src/protocol/validate.js';
import { footprint } from '../../src/raster/core.js';
import { maskGrid, r16Mask } from '../../src/raster/mapping.js';
import { canonical, hashBytes } from '../storage/canonical.js';
import { invalid } from './zip.js';

type ReadJSON = (ref: BlobRef) => Promise<any>;
type Contribution = ContributionStack['contributions'][number];
type RasterLookup = (id: string) => RasterInfo | undefined;
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const planOf = (manifest: RasterManifest): any => manifest.plan;

function stackShape(value: any, parent: RasterManifest): asserts value is ContributionStack {
  contributionStack(value);
  requireValue(value.pipeline === parent.pipeline && value.width === parent.width && value.height === parent.height &&
    value.contributions.length > 0 &&
    value.contributions.length === planOf(parent).layers.length);
}

/** The stack and each K are separate bounded objects, never independent assets. */
async function visitContributions(parent: RasterManifest, read: ReadJSON, needed: (ref: BlobRef) => void, asset?: RasterLookup) {
  const plan = planOf(parent);
  if (plan.contributions === undefined) return;
  rasterManifest(parent);
  const ref: BlobRef = plan.contributions; blob(ref);
  if (ref.mediaType !== 'application/json' || BigInt(ref.byteLength) > 65536n ||
      !parent.dependencies.some(r => same(r, ref))) invalid();
  needed(ref);
  const stack = await read(ref); stackShape(stack, parent);
  for (let index = 0; index < stack.contributions.length; index++) {
    const entry = stack.contributions[index], layer: RasterLayer = plan.layers[index];
    needed(entry.manifest); needed(entry.pixels);
    const child: RasterManifest = await read(entry.manifest); rasterManifest(child);
    const childPlan = planOf(child), expectedFootprint = footprint({ x: 0, y: 0, width: parent.width, height: parent.height }, layer.transform);
    if (childPlan.kind !== 'cp1-layer-contribution-v1' || child.pipeline !== parent.pipeline ||
        child.width !== parent.width || child.height !== parent.height || !same(childPlan.layer, layer) ||
        !same(child.pixels, entry.pixels) || !same(childPlan.footprint, expectedFootprint) ||
        !same(plan.footprints[index], expectedFootprint) ||
        hashBytes(canonical({ pipeline: child.pipeline, width: child.width, height: child.height, tiles: child.tiles })) !== entry.pixelIdentity ||
        !same(child.dependencies, [childPlan.source, ...(childPlan.mask ? [childPlan.mask] : [])])) invalid();
    for (const dependency of child.dependencies) needed(dependency);
    if (asset) {
      const source = asset(layer.assetId), mask = layer.mask ? asset(layer.mask.assetId) : undefined;
      if (!source || source.role === 'mask' || !same(source.manifest, childPlan.source) ||
          (layer.mask === null) !== (childPlan.mask === null)) invalid();
      if (layer.mask) {
        const grid = maskGrid(layer.mask, parent.width, parent.height);
        if (!mask || !same(mask.manifest, childPlan.mask) || mask.width !== grid.width || mask.height !== grid.height ||
            (mask.role === 'mask') !== r16Mask(layer.mask)) invalid();
      }
    }
  }
}

/** Export must explicitly follow JSON stack/K objects as well as their BlobRefs. */
export async function contributionReferences(parent: RasterManifest, read: ReadJSON): Promise<readonly BlobRef[]> {
  const refs = new Map<string, BlobRef>();
  await visitContributions(parent, read, ref => {
    const prior = refs.get(ref.hash); if (prior && !same(prior, ref)) invalid(); refs.set(ref.hash, ref);
  });
  return [...refs.values()];
}

/** Native source identities bind each ordered K before recomputing its bytes. */
export async function validateContributionClosure(parent: RasterManifest, read: ReadJSON, asset: RasterLookup, needed: (ref: BlobRef) => void): Promise<void> {
  await visitContributions(parent, read, needed, asset);
}

/** A fresh capture recomputes every K in one streamed worker pass. */
export function assertContributionRecomputation(original: RasterManifest, computed: RasterManifest): void {
  const retained = planOf(original).contributions;
  if (retained !== undefined && !same(retained, planOf(computed).contributions)) invalid();
}

export type ContributionMapping = {
  read: ReadJSON;
  write: (manifest: unknown) => BlobRef;
  mapAsset: (id: string) => string;
  mapRef: (ref: BlobRef) => BlobRef;
  remember: (original: BlobRef, mapped: BlobRef) => void;
};

/** Rewrite typed metadata only; raw K bytes, tile hashes and identities survive. */
export async function remapContributionClosure(parent: RasterManifest, mapping: ContributionMapping): Promise<RasterManifest> {
  const plan = planOf(parent);
  if (plan.contributions === undefined) return parent;
  const stackRef: BlobRef = plan.contributions, stack = await mapping.read(stackRef); stackShape(stack, parent);
  const entries: Contribution[] = [], translated = new Map<string, BlobRef>();
  for (const entry of stack.contributions) {
    let ref = translated.get(entry.manifest.hash);
    if (!ref) {
      const child: RasterManifest = await mapping.read(entry.manifest); rasterManifest(child);
      const childPlan = planOf(child), layer: RasterLayer = childPlan.layer;
      if (childPlan.kind !== 'cp1-layer-contribution-v1' || !same(child.pixels, entry.pixels)) invalid();
      const mapped: RasterManifest = { ...child, dependencies: child.dependencies.map(mapping.mapRef), plan: {
        ...childPlan, layer: { ...layer, assetId: mapping.mapAsset(layer.assetId),
          mask: layer.mask ? { ...layer.mask, assetId: mapping.mapAsset(layer.mask.assetId) } : null },
        source: mapping.mapRef(childPlan.source), mask: childPlan.mask ? mapping.mapRef(childPlan.mask) : null,
      } };
      rasterManifest(mapped); ref = mapping.write(mapped);
      mapping.remember(entry.manifest, ref); translated.set(entry.manifest.hash, ref);
    }
    entries.push({ ...entry, manifest: ref });
  }
  const mappedStack = mapping.write({ ...stack, contributions: entries }); mapping.remember(stackRef, mappedStack);
  return { ...parent, dependencies: parent.dependencies.map(ref => same(ref, stackRef) ? mappedStack : ref),
    plan: { ...plan, contributions: mappedStack } };
}
