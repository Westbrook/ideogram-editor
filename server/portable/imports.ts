import type {Asset} from '../../src/protocol/assets.js';
import type {RasterManifest} from '../../src/protocol/raster.js';
import {decodedDerivedPlan,type DecodedDerivedPlan} from '../../src/protocol/raster-import.js';
import {canonical} from '../../src/protocol/json.js';

/** PF10 typed closure edge. Session inspections never become live authority. */
export function validateDerivedImportEdge(asset:Asset,manifest:RasterManifest,source:Asset):DecodedDerivedPlan{
 const plan=manifest.plan as DecodedDerivedPlan;decodedDerivedPlan(plan,manifest.width,manifest.height);
 const raster=asset.raster;
 if(!raster||raster.role!=='derived'||raster.conversion!==null||!['raster-preview','canonical-raster'].includes(asset.qualification)||asset.purpose!=='image'||asset.measuredMediaType!=='image/png'||asset.blob.mediaType!=='image/png'||
    raster.width!==manifest.width||raster.height!==manifest.height||raster.pipeline!==manifest.pipeline||canonical(raster.pixels)!==canonical(manifest.pixels)||canonical(raster.sourceAssetIds)!==canonical([plan.sourceAssetId]))throw Error('IMPORT_DERIVATION_BINDING');
 if(source.id!==plan.sourceAssetId||source.purpose!=='image'||source.qualification!=='pending-decoder'||source.raster!==undefined||source.measuredMediaType!==plan.original.mediaType||canonical(source.blob)!==canonical(plan.original))throw Error('IMPORT_ORIGINAL_BINDING');
 // Exact original is a leaf object dependency and an explicit source-asset
 // edge; neither an unrelated retained blob nor a source ID alone suffices.
 if(!manifest.dependencies.some(ref=>canonical(ref)===canonical(plan.original)))throw Error('IMPORT_ORIGINAL_DEPENDENCY');
 return plan;
}
/** Called only after replay through the ordinarily admitted raster worker. */
export function verifyDerivedImportReplay(asset:Asset,manifest:RasterManifest,replayed:{png:Asset['blob'];info:NonNullable<Asset['raster']>;manifest:RasterManifest}):void{
 const info=asset.raster!;
 if(canonical(replayed.png)!==canonical(asset.blob)||canonical(replayed.info.pixels)!==canonical(info.pixels)||replayed.info.pixelIdentity!==info.pixelIdentity||replayed.info.pipeline!==info.pipeline||replayed.info.width!==info.width||replayed.info.height!==info.height||canonical(replayed.manifest)!==canonical(manifest))throw Error('IMPORT_DERIVATION_REPLAY');
}
