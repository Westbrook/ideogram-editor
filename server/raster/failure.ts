export type RasterFailure = {code:string;resourceFailure?:{outputPeak:number;outputRemaining:number}};
/** Filesystem writeback exhaustion is retryable resource failure, never corrupt pixels. */
export function rasterFailure(error:unknown):RasterFailure{
  const value=error as {code?:unknown;rasterResourceFailure?:{outputPeak?:unknown;outputRemaining?:unknown}}|null;
  const retained=value?.rasterResourceFailure;
  if(retained&&Number.isSafeInteger(retained.outputPeak)&&Number.isSafeInteger(retained.outputRemaining)){
    const outputPeak=retained.outputPeak as number,outputRemaining=retained.outputRemaining as number;
    if(outputPeak>=0&&outputPeak<=100065536&&outputRemaining>0&&outputRemaining<=outputPeak)return{code:'RASTER_RESOURCES',resourceFailure:{outputPeak,outputRemaining}};
  }
  if(value?.code==='ENOSPC'||value?.code==='EDQUOT'||value?.code==='EIO')return{code:'RASTER_RESOURCES'};
  const message=error instanceof Error?error.message:'';
  // Preserve this reviewed versioned reason without admitting arbitrary numeric codes.
  return{code:message==='RASTER_V45_EDIT_MASK_HOMOGENEOUS'||/^RASTER_[A-Z_]+$/.test(message)?message:'RASTER_DECODE'};
}
