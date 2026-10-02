import assert from 'node:assert/strict';
const HASH=/^sha256:[a-f0-9]{64}$/;
const positive = n => Number.isSafeInteger(n) && n > 0;
const pick = (value,keys) => Object.fromEntries(keys.map(key => [key,value[key]]));

// Extends the frozen native gate with the actual retained child detail checked
// by the common capsule reader. Parent summaries alone are insufficient.
export function validateAlphaNativeChildren(receipt,receiptHash,receiptPath,proof) {
  return receipt.loadOrders.map(order => {
    const read = proof.readJSON(receiptHash,{path:order.receipt,hash:order.receiptHash},{parentPath:receiptPath});
    assert.equal(read.hash,order.receiptHash); const child = read.value;
    const summary = {...pick(child,['kind','schemaVersion','status','phase','order','candidateHash','artifactHash','oracleHash','haloRule','fixtureManifestHash','counts']),
      cases:child.cases.map(row => pick(row,['path','encodedHash','dimensions','status','plannedRegionCount','completedDecodeCount','completedPixelComparisonCount','comparedPixelCount']))};
    assert.deepEqual(summary,order.summary);
    for (const row of child.cases) {
      assert(Array.isArray(row.regions) && row.regions.length === row.plannedRegionCount); let pixels = 0;
      for (const region of row.regions) {
        assert.equal(region.status,0); assert.equal(region.completedDecode,true); assert.equal(region.completedPixelComparison,true);
        const {core,roi,metrics} = region;
        assert(Array.isArray(core) && core.length === 4 && Array.isArray(roi) && roi.length === 4);
        assert([...core,...roi].every(n => Number.isSafeInteger(n) && n >= 0));
        assert(positive(core[2]) && positive(core[3]) && positive(roi[2]) && positive(roi[3]));
        const rule = child.haloRule;
        const left = rule ? Math.floor(Math.max(0,core[0]-rule.left)/rule.originAlignment)*rule.originAlignment : core[0];
        const top = rule ? Math.floor(Math.max(0,core[1]-rule.top)/rule.originAlignment)*rule.originAlignment : core[1];
        const right = rule ? Math.min(row.dimensions[0],core[0]+core[2]+rule.right) : core[0]+core[2];
        const bottom = rule ? Math.min(row.dimensions[1],core[1]+core[3]+rule.bottom) : core[1]+core[3];
        assert.deepEqual(roi,[left,top,right-left,bottom-top],'Actual ROI differs from the claimed halo rule');
        assert(core[0]+core[2] <= row.dimensions[0] && core[1]+core[3] <= row.dimensions[1]);
        assert(roi[0] <= core[0] && roi[1] <= core[1] && core[0]+core[2] <= roi[0]+roi[2] && core[1]+core[3] <= roi[1]+roi[3]);
        assert(roi[0]+roi[2] <= row.dimensions[0] && roi[1]+roi[3] <= row.dimensions[1]);
        assert(roi[2] <= 8192 && roi[3] <= 8192 && roi[2]*roi[3] <= 25000000);
        assert.equal(region.comparedPixelCount,core[2]*core[3]); assert.match(region.actualCoreHash,HASH); assert.equal(region.actualCoreHash,region.expectedCoreHash);
        for (const key of ['native_remaining','output_remaining','allocation_denied']) assert.equal(metrics[key],0);
        assert(Number.isSafeInteger(metrics.native_peak) && metrics.native_peak >= 0 && metrics.native_peak <= 128*1048576);
        assert(positive(metrics.output_peak) && metrics.output_peak <= Math.ceil(roi[2]*roi[3]*4/16384)*16384);
        assert.equal(metrics.output_bytes_written,roi[2]*roi[3]*4); pixels += region.comparedPixelCount;
      }
      assert.equal(row.comparedPixelCount,pixels);
      if (child.phase === 'smoke') {
        assert.equal(row.regions.length,1); assert.deepEqual(row.regions[0].core,[0,0,...row.dimensions]);
        assert.deepEqual(row.refusals.map(item => item.kind),['tiny-budget','pre-cancel']);
        row.refusals.forEach((refusal,index) => { assert.equal(refusal.status,[1,6][index]); assert.equal(refusal.metrics.native_remaining,0); assert.equal(refusal.metrics.output_remaining,0); });
      }
    }
    return child;
  });
}
