import type {Asset} from '../../src/protocol/assets.js';
import type {RasterLayer,RasterManifest} from '../../src/protocol/raster.js';
import {maskGrid,r16Mask} from '../../src/raster/mapping.js';
import {rasterManifest} from '../../src/protocol/validate.js';
import {canonical} from '../storage/canonical.js';
import {resolveRasterProfile} from '../raster/profile-registry.js';
import {invalid} from './zip.js';

/** Review imagery is an inert PNG export of an exact ordered graph. It never
 * grants candidate safety, native-text treatment or placement authority. */
export function validateComparisonClosure(owner:Asset,manifest:RasterManifest,asset:(id:string)=>Asset|undefined):string[]{
 rasterManifest(manifest);const plan=manifest.plan as {kind:string;sourceWidth:number;sourceHeight:number;layers:RasterLayer[]};
 if(plan.kind!=='candidate-lettering-comparison-v1'||!resolveRasterProfile(manifest.pipeline,plan)||owner.qualification!=='canonical-png'||owner.safety!=='safe'||owner.availability!=='available'||owner.blob.mediaType!=='image/png'||owner.measuredMediaType!=='image/png'||owner.raster?.role!=='export'||owner.raster.conversion!==null)invalid();
 const ids=[...new Set(plan.layers.flatMap(layer=>[layer.assetId,...(layer.mask?[layer.mask.assetId]:[])]))],sources=ids.map(asset);
 if(canonical(owner.raster!.sourceAssetIds)!==canonical(ids)||sources.some(source=>!source?.raster||source.qualification!=='canonical-raster'||source.safety!=='safe'||source.availability!=='available'))invalid();
 for(const layer of plan.layers){
  if(asset(layer.assetId)!.raster!.role==='mask')invalid();
  if(layer.mask){const info=asset(layer.mask.assetId)!.raster!,grid=maskGrid(layer.mask,plan.sourceWidth,plan.sourceHeight);if(info.width!==grid.width||info.height!==grid.height||(info.role==='mask')!==r16Mask(layer.mask))invalid();}
 }
 if(canonical(sources.map(source=>canonical(source!.raster!.manifest)).sort())!==canonical(manifest.dependencies.map(ref=>canonical(ref)).sort()))invalid();
 return ids;
}
