import type {Asset} from './assets.js';
import {asset as validateAsset,keys,seq,requireValue as ok} from './validate.js';

// Asset-only HTTP projections have a separate version from LP1 snapshots.
// Version 3 introduces derived rasters; legacy asset semantics stay at 2.
export type AssetProjection = {
  protocolVersion:1; entityVersion:string; projectionSchema:2|3; highWater:string;
  projection:{kind:'inline';value:Asset};
};

export function assetProjectionSchema(value:Asset):2|3 {
  validateAsset(value);
  return value.raster?.role==='derived'?3:2;
}

export function validateAssetProjection(value:unknown):Asset {
  keys(value,['protocolVersion','entityVersion','projectionSchema','highWater','projection']);
  const response=value as AssetProjection;
  ok(response.protocolVersion===1&&seq(response.entityVersion)&&seq(response.highWater)&&
    (response.projectionSchema===2||response.projectionSchema===3),'Unsupported asset projection');
  keys(response.projection,['kind','value']);
  ok(response.projection.kind==='inline','Unsupported asset projection');
  const projected=response.projection.value;
  const schema=assetProjectionSchema(projected);
  ok(response.entityVersion===projected.version&&response.projectionSchema===schema,'Asset projection identity changed');
  return projected;
}
