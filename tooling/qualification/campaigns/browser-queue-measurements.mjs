// Only complete privacy-safe observations can supply this exact registry row.
const SHA = /^sha256:[a-f0-9]{64}$/;
const size = value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= 1048576n;
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export function rejectedDraftMeasurement({ cell, proof } = {}) {
  const unavailable = reason => ({ reason: 'R25 rejected draft proof: ' + reason });
  if (cell?.operation !== 'queue.fault' || cell.parameters?.scenario !== 'disk-full-admission') return unavailable('wrong specimen');
  const rows = (cell.requiredMeasurements ?? []).filter(row => row?.name === 'R25RejectedDraftLossCount');
  if (rows.length !== 1 || rows[0].budgetId !== 'R25' || rows[0].unit !== 'violations') return unavailable('exact unique registry name, budget and unit required');
  if (proof?.kind !== 'rejected-draft-preservation-1' || proof.receipt?.status !== 'rejected' || proof.receipt.code !== 'CAPACITY' || proof.receipt.reason !== 'QUEUE_METADATA_ADMISSION' || !id(proof.receipt.commandId) || proof.receipt.enqueueCommands !== 1) return unavailable('actual exact storage admission rejection required');
  if (Object.keys(proof).sort().join(',') !== 'after,before,comparison,kind,receipt' || Object.keys(proof.receipt).some(key => !['commandId', 'reviewId', 'status', 'code', 'reason', 'enqueueCommands', 'valid'].includes(key))) return unavailable('only bounded nonsecret rejection identity may be retained');
  if (canonical(proof.comparison) !== canonical({ completeSavedUI: true, actualDraftText: true, visiblePrompt: true, equal: true })) return unavailable('complete private before/after equality checks required');
  for (const record of [proof.before, proof.after]) {
    if (!record || !id(record.draftId) || !id(record.assetId) || !/^[1-9][0-9]*$/.test(record.generation ?? '') || !SHA.test(record.blob?.hash ?? '') || !size(record.blob?.byteLength) || typeof record.blob?.mediaType !== 'string' || record.rawHash !== record.blob.hash) return unavailable('both actual draft byte hashes must match their owned blob identities');
    const state = record.state, prompt = state?.visiblePrompt;
    if (state?.kind !== 'complete-saved-ui-sha256-1' || state.complete !== true || !SHA.test(state.hash ?? '') || !size(state.byteLength) || !SHA.test(prompt?.hash ?? '') || !size(prompt.byteLength) || !Number.isSafeInteger(prompt.characters) || prompt.characters < 0 || prompt.characters > Number(prompt.byteLength)) return unavailable('complete saved projection and visible prompt digest identities required');
    if (Object.keys(record).sort().join(',') !== 'assetId,blob,draftId,generation,rawHash,state' || Object.keys(record.blob).sort().join(',') !== 'byteLength,hash,mediaType' || Object.keys(state).sort().join(',') !== 'byteLength,complete,hash,kind,visiblePrompt' || Object.keys(prompt).sort().join(',') !== 'byteLength,characters,hash') return unavailable('raw authored content or unknown projection fields are forbidden');
  }
  if (canonical(proof.before) !== canonical(proof.after)) return unavailable('before/after identities differ');
  return { measurement: { name: 'R25RejectedDraftLossCount', value: 0, unit: 'violations',
    method: 'Actual rejected queue admission; complete saved UI projection, fetched authored draft text and visible prompt compared privately before/after; both fetched byte hashes match their owned blobs',
    evidence: [{ kind: 'rejected-draft-preservation-1', ...proof }] } };
}
