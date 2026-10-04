import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { runBrowserAction } from '../../tooling/qualification/campaigns/browser-driver.mjs';

// These are orchestration tests of the actual public action driver. The page,
// navigation timing and observer are doubles; none supplies native presentation,
// an owned collector proof, a browser measurement or qualification evidence.
function scenario(options = {}) {
  const workload = options.workload ?? 'W1', empty = workload === 'W0';
  const documentId = 'document-1', assetId = empty ? null : 'asset-1';
  const pixelIdentity = 'sha256:' + 'a'.repeat(64);
  const before = { id: documentId, revision: '7', width: 4, height: 3,
    orderedLayerIds: empty ? [] : ['layer-1'],
    image: assetId ? { compositeAssetId: assetId } : undefined };
  const current = { ...structuredClone(before), revision: '8' };
  const documents = [before, before, current, current].map(value => structuredClone(value));
  for (const [index, update] of options.documents ?? []) Object.assign(documents[index], update);
  const receipt = { status: 'accepted', commandId: 'command-1', documentRevision: '8',
    transactionId: 'transaction-1', ...options.receipt };
  const asset = { id: assetId, purpose: 'image', qualification: 'canonical-raster',
    safety: 'safe', availability: 'available', raster: { width: 4, height: 3, pixelIdentity } };
  Object.assign(asset, options.asset);
  const events = [], reads = [], shellWitnesses = [], canvasWitnesses = [];
  let opened = false, saved = false, documentReads = 0, canvasReads = 0, responseWaiter;
  const pageFailure = Error('retained public action failure');
  const hookFailure = Error('retained observer failure');
  const browserDocument = { visibilityState: options.visibility ?? 'visible' };
  const browserWindow = {};
  browserWindow.top = options.framed ? {} : browserWindow;
  const performance = { timeOrigin: 100, getEntriesByType(name) {
    assert.equal(name, 'navigation');
    return options.navigationEntries ?? [{ type: options.navigationType ?? 'navigate',
      startTime: options.navigationStartTime ?? 0, name: 'http://127.0.0.1:4380/#pairing=test-only' }];
  } };
  const canvas = {
    async waitFor(value) { assert.deepEqual(value, { state: 'visible' }); events.push('canvas-visible-wait'); },
    async getAttribute(name) {
      assert.equal(name, 'data-asset');
      const index = canvasReads++;
      return Object.hasOwn(options.canvasAssets ?? {}, index) ? options.canvasAssets[index] : assetId ?? '';
    },
    async boundingBox() { return Object.hasOwn(options, 'bounds') ? options.bounds : { x: 2, y: 4, width: 100, height: 75 }; },
    async isVisible() { return options.canvasVisible !== false; },
  };
  const controls = name => ({
    async waitFor(value) { assert.deepEqual(value, { state: 'visible' }); events.push('visible:' + name); },
    async isVisible() { return options.invisibleControl !== (opened ? 'toolbar:' : 'shell:') + name; },
    async isEnabled() { return options.disabledControl !== (opened ? 'toolbar:' : 'shell:') + name; },
    async click() {
      events.push('click:' + name);
      if (options.failClick === name) throw pageFailure;
      if (name === 'Open') return;
      assert.equal(name, 'Save checkpoint', 'The action must not open or generate another feature');
      saved = true;
      if (responseWaiter) {
        const response = {
          request: () => ({ method: () => 'POST', postDataJSON: () => ({
            command: { documentId: options.commandDocumentId ?? documentId, body: { type: 'SaveCheckpoint' } },
          }) }),
          url: () => 'http://127.0.0.1:4380/api/v1/commands',
          json: async () => ({ commandId: receipt.commandId, receipt: { ...receipt, ...options.initialReceipt } }),
        };
        assert.equal(responseWaiter.predicate(response), true);
        events.push('checkpoint-accepted-response');
        responseWaiter.resolve(response);
      }
    },
  });
  const page = {
    async goto(url) {
      assert.equal(url, 'http://127.0.0.1:4380/#pairing=test-only');
      events.push('goto');
      if (options.failGoto) throw pageFailure;
      performance.timeOrigin = options.sameRealm ? 100 : 200;
    },
    async evaluate(fn, argument) {
      // Run the exact page callback in a separate test realm, rather than
      // replacing its navigation/top-level/visibility checks with canned data.
      const fetch = async (path, init) => {
        assert.deepEqual(structuredClone(init), { headers: { 'X-App-Client': 'LP-1' }, credentials: 'same-origin' });
        reads.push(path); events.push('read:' + path);
        if (options.failRead === path) return { ok: false, status: 503 };
        let value;
        if (path === '/api/v1/documents/' + documentId) {
          const ordinal = documentReads++;
          assert(ordinal < documents.length, 'Unexpected repeated document read');
          value = { projection: { value: structuredClone(documents[ordinal]) } };
          if (ordinal === 3) {
            if (options.finalRealm === 'changed') performance.timeOrigin = 300;
            if (options.finalRealm === 'hidden') browserDocument.visibilityState = 'hidden';
          }
        } else if (path === '/api/v1/commands/' + receipt.commandId) value = { receipt: structuredClone({ ...receipt, ...options.publicReceipt }) };
        else if (path === '/api/v1/assets/' + assetId) value = { projection: { value: structuredClone(asset) } };
        else assert.fail('Unexpected public witness route: ' + path);
        return { ok: true, status: 200, json: async () => value };
      };
      const value = await runInNewContext('(' + fn.toString() + ')(__argument)', {
        __argument: argument, performance, window: browserWindow, document: browserDocument,
        URL, innerWidth: 1440, innerHeight: 900, devicePixelRatio: 1, fetch,
      });
      return structuredClone(value);
    },
    getByRole(role, locatorOptions) {
      if (role === 'dialog') {
        assert.deepEqual(locatorOptions, { name: 'Open document', exact: true });
        return {
          getByRole(innerRole, innerOptions) {
            assert.equal(innerRole, 'button'); assert(innerOptions.name instanceof RegExp);
            assert(innerOptions.name.test('Document · ' + documentId + ' · 4 × 3 · revision 7'));
            return { async click() { events.push('click:document-row'); if (options.failOpen) throw pageFailure; opened = true; } };
          },
          async waitFor(value) { assert.deepEqual(value, { state: 'hidden' }); events.push('open-dialog-hidden'); },
        };
      }
      assert.equal(role, 'button'); assert.equal(locatorOptions.exact, true);
      return controls(locatorOptions.name);
    },
    getByText(text, options) {
      assert.equal(options.exact, true);
      assert(['Local recovery complete. Accepted edits are saved locally.', 'SaveCheckpoint accepted and saved locally.'].includes(text));
      return { async waitFor(value) { assert.deepEqual(value, { state: 'visible' }); events.push(text.startsWith('SaveCheckpoint') ? 'checkpoint-status' : 'recovery-ready'); } };
    },
    locator(selector) {
      if (selector === 'canvas[aria-label="Document raster preview"]') return canvas;
      assert.equal(selector, '.document-name');
      return {
        async textContent() { return options.initialDocumentLabel ?? 'No document open'; },
        filter(value) {
          assert.equal(value.hasText, '4 × 3 · revision ' + (saved ? '8' : '7'));
          return { async waitFor(state) { assert.deepEqual(state, { state: 'visible' }); events.push('document-label'); } };
        },
      };
    },
    waitForResponse(predicate) {
      events.push('observe-checkpoint-response');
      return new Promise(resolve => { responseWaiter = { predicate, resolve }; });
    },
  };
  const native = {
    navigationNonce: 'test-owned-navigation',
    async navigationStart({ run }) {
      events.push('native-anchor');
      if (options.failHook === 'navigation') throw hookFailure;
      if (!options.skipOwnedNavigation) await run();
    },
    async shellReady(witness) {
      events.push('shell-ready');
      if (options.failHook === 'shell') throw hookFailure;
      shellWitnesses.push(structuredClone(witness));
    },
    async canvasReady(witness) {
      events.push('canvas-ready');
      if (options.failHook === 'canvas') throw hookFailure;
      canvasWitnesses.push(structuredClone(witness));
    },
  };
  const input = {
    page, cell: { id: 'H1-' + workload, operation: options.operation ?? 'navigation.ready', workload },
    fixture: { documentId: options.missingDocument ? null : documentId },
    pair: async () => { events.push('pair'); return 'http://127.0.0.1:4380/#pairing=test-only'; },
    services: options.unselected ? {} : { nativeNavigation: native },
  };
  return { input, events, reads, shellWitnesses, canvasWitnesses, pageFailure, hookFailure, pixelIdentity };
}

const actions = events => events.filter(value => value === 'goto' || value.startsWith('click:'));

test('selected W1 follows owned anchor, original public actions and immutable readiness witnesses', async () => {
  const s = scenario(), result = await runBrowserAction(s.input);
  assert.deepEqual(actions(s.events), ['goto', 'click:Open', 'click:document-row', 'click:Save checkpoint']);
  const milestones = ['native-anchor', 'goto', 'shell-ready', 'click:Open', 'click:document-row',
    'observe-checkpoint-response', 'click:Save checkpoint', 'checkpoint-accepted-response', 'checkpoint-status', 'canvas-ready'];
  assert.deepEqual(s.events.filter(value => milestones.includes(value)), milestones);
  assert.equal(s.shellWitnesses.length, 1); assert.equal(s.canvasWitnesses.length, 1);
  assert.equal(Object.hasOwn(s.shellWitnesses[0], 'documentId'), false);
  assert.deepEqual(s.shellWitnesses[0].controls.map(value => value.name), ['New', 'Open']);
  const ready = s.canvasWitnesses[0];
  assert.deepEqual(ready.canonical, { documentId: 'document-1', revision: '8', width: 4, height: 3,
    layerCount: 1, assetId: 'asset-1', assetHash: s.pixelIdentity });
  assert.deepEqual(ready.acceptedEdit, { commandId: 'command-1', documentId: 'document-1', status: 'accepted',
    documentRevision: '8', transactionId: 'transaction-1' });
  assert.deepEqual(ready.toolbar.map(value => value.name), ['New', 'Open', 'Import image', 'Close document', 'Export image']);
  assert(ready.toolbar.every(value => value.visible && value.enabled));
  assert.deepEqual(ready.navigation, s.shellWitnesses[0].navigation);
  assert.equal(ready.navigation.previousTimeOrigin, 100); assert.equal(ready.navigation.timeOrigin, 200);
  assert.equal(ready.navigation.entry.name, 'http://127.0.0.1:4380/');
  assert.equal(result.acceptedTestEdit, true); assert.equal(result.publicOpenCompleted, true);
  assert.equal(result.startupBoundary, 'document-ready-via-Open');
  assert.match(result.presentation, /not physical presentation/);
  assert.equal(result.status, undefined, 'A public driver result is not a native PASS authority');
  assert.deepEqual(s.reads, ['/api/v1/documents/document-1', '/api/v1/documents/document-1',
    '/api/v1/commands/command-1', '/api/v1/documents/document-1', '/api/v1/assets/asset-1', '/api/v1/documents/document-1']);
});

test('selected W0 proves the real empty document without inventing a raster asset', async () => {
  const s = scenario({ workload: 'W0' }), result = await runBrowserAction(s.input);
  assert.equal(result.viewportAsset, null);
  assert.equal(s.canvasWitnesses[0].canonical.layerCount, 0);
  assert.equal(s.canvasWitnesses[0].canonical.assetId, null); assert.equal(s.canvasWitnesses[0].canonical.assetHash, null);
  assert.equal(s.canvasWitnesses[0].viewport.asset, null, 'The real empty-string canvas attribute is normalized to no asset');
  assert(!s.reads.some(path => path.startsWith('/api/v1/assets/')));
  assert.deepEqual(actions(s.events), ['goto', 'click:Open', 'click:document-row', 'click:Save checkpoint']);
});

test('unselected navigation and portable reopen retain the original action path', async () => {
  for (const options of [{ unselected: true }, { operation: 'portable.reopen' }]) {
    const s = scenario(options), result = await runBrowserAction(s.input);
    assert.deepEqual(actions(s.events), ['goto', 'click:Open', 'click:document-row', 'click:Save checkpoint']);
    assert.equal(result.nativeReadiness, undefined); assert.equal(result.navigation, undefined);
    assert.equal(s.shellWitnesses.length, 0); assert.equal(s.canvasWitnesses.length, 0);
    assert(!s.events.includes('native-anchor')); assert(!s.events.includes('observe-checkpoint-response'));
  }
});

test('the selected native path requires its sealed W0/W1 document before navigation', async () => {
  for (const options of [{ missingDocument: true }, { workload: 'W2' }]) {
    const s = scenario(options);
    await assert.rejects(runBrowserAction(s.input), { code: 'CAMPAIGN_PREREQUISITE' });
    assert.deepEqual(s.events, []);
  }
});

test('the actual navigation callback rejects stale, hidden, framed or non-navigation realms', async () => {
  for (const options of [{ sameRealm: true }, { skipOwnedNavigation: true }, { visibility: 'hidden' }, { framed: true },
    { navigationType: 'reload' }, { navigationStartTime: 1 }, { navigationEntries: [] },
    { navigationEntries: [{ type: 'navigate', startTime: 0 }, { type: 'navigate', startTime: 0 }] }]) {
    const s = scenario(options);
    await assert.rejects(runBrowserAction(s.input), /Fresh visible navigation realm unavailable/);
    assert.equal(s.shellWitnesses.length, 0); assert.equal(s.canvasWitnesses.length, 0);
    assert(!actions(s.events).some(value => value.startsWith('click:')));
  }
});

test('automatic document recovery still follows the original public Open and checkpoint actions', async () => {
  const s = scenario({ initialDocumentLabel: 'Recovered fixture · 4 × 3 · revision 7' });
  const result = await runBrowserAction(s.input);
  assert.deepEqual(actions(s.events), ['goto', 'click:Open', 'click:document-row', 'click:Save checkpoint']);
  assert.equal(s.shellWitnesses.length, 1); assert.equal(s.canvasWitnesses.length, 1);
  assert.equal(Object.hasOwn(s.shellWitnesses[0], 'documentId'), false);
  assert.equal(s.canvasWitnesses[0].canonical.documentId, 'document-1');
  assert.equal(result.acceptedTestEdit, true); assert.equal(result.publicOpenCompleted, true);
});

test('unavailable shell controls cannot publish shell readiness', async () => {
  for (const options of [{ disabledControl: 'shell:New' }, { disabledControl: 'shell:Open' }, { invisibleControl: 'shell:Open' }]) {
    const s = scenario(options);
    await assert.rejects(runBrowserAction(s.input));
    assert.equal(s.shellWitnesses.length, 0); assert.equal(s.canvasWitnesses.length, 0);
    assert(!actions(s.events).includes('click:Open'));
  }
});

test('checkpoint rejection or a stale command/document/revision cannot publish canvas readiness', async () => {
  for (const options of [{ initialReceipt: { status: 'rejected' } }, { publicReceipt: { status: 'rejected' } },
    { publicReceipt: { commandId: 'other-command' } },
    { commandDocumentId: 'other-document' }, { receipt: { documentRevision: '9' } },
    { documents: [[1, { id: 'other-document' }]] }, { documents: [[2, { id: 'other-document' }]] },
    { documents: [[2, { image: { compositeAssetId: 'other-asset' } }]] },
    { documents: [[2, { orderedLayerIds: ['other-layer'] }]] }]) {
    const s = scenario(options);
    await assert.rejects(runBrowserAction(s.input));
    assert.equal(s.canvasWitnesses.length, 0);
  }
});

test('canonical raster metadata must bind current safe available pixels and dimensions', async () => {
  for (const asset of [{ id: 'other-asset' }, { purpose: 'font' }, { qualification: 'encoded' },
    { safety: 'unknown' }, { availability: 'unavailable' }, { raster: { width: 8, height: 3, pixelIdentity: 'sha256:' + 'a'.repeat(64) } },
    { raster: { width: 4, height: 8, pixelIdentity: 'sha256:' + 'a'.repeat(64) } },
    { raster: { width: 4, height: 3, pixelIdentity: 'unknown' } }]) {
    const s = scenario({ asset });
    await assert.rejects(runBrowserAction(s.input));
    assert.equal(s.canvasWitnesses.length, 0);
  }
  const s = scenario({ workload: 'W0', documents: [[1, { orderedLayerIds: ['layer-1'] }], [2, { orderedLayerIds: ['layer-1'] }]] });
  await assert.rejects(runBrowserAction(s.input), /Only the actual empty document/);
  assert.equal(s.canvasWitnesses.length, 0);
});

test('final stable projection must retain the same document, dimensions, revision and pixels', async () => {
  for (const update of [{ id: 'other-document' }, { width: 8 }, { height: 8 }, { revision: '9' },
    { image: { compositeAssetId: 'other-asset' } }, { orderedLayerIds: ['other-layer'] }]) {
    const s = scenario({ documents: [[3, update]] });
    await assert.rejects(runBrowserAction(s.input));
    assert.equal(s.canvasWitnesses.length, 0);
  }
});

test('late toolbar, canvas asset, geometry and visibility changes prevent canvas readiness', async () => {
  for (const options of [{ disabledControl: 'toolbar:Export image' }, { invisibleControl: 'toolbar:Close document' },
    { canvasAssets: ['wrong-asset'] }, { canvasAssets: ['asset-1', 'wrong-asset'] },
    { canvasAssets: ['asset-1', ''] }, { canvasAssets: ['asset-1', null] },
    { bounds: null }, { bounds: { x: 0, y: 0, width: 0, height: 1 } }, { canvasVisible: false }]) {
    const s = scenario(options);
    await assert.rejects(runBrowserAction(s.input));
    assert.equal(s.canvasWitnesses.length, 0);
  }
});

test('realm replacement or hiding during the final public metadata read prevents success', async () => {
  for (const finalRealm of ['changed', 'hidden']) {
    const s = scenario({ finalRealm });
    await assert.rejects(runBrowserAction(s.input));
    assert.equal(s.canvasWitnesses.length, 0);
  }
});

test('public action and read failures remain failures without extra recovery actions', async () => {
  for (const options of [{ failGoto: true }, { failClick: 'Open' }, { failOpen: true }, { failClick: 'Save checkpoint' }]) {
    const s = scenario(options);
    await assert.rejects(runBrowserAction(s.input), error => error === s.pageFailure);
    assert.equal(s.canvasWitnesses.length, 0);
    assert(actions(s.events).every(value => ['goto', 'click:Open', 'click:document-row', 'click:Save checkpoint'].includes(value)));
  }
  for (const path of ['/api/v1/documents/document-1', '/api/v1/commands/command-1', '/api/v1/assets/asset-1']) {
    const s = scenario({ failRead: path });
    await assert.rejects(runBrowserAction(s.input), /Public performance witness unavailable: 503/);
    assert.equal(s.canvasWitnesses.length, 0);
  }
});

test('observer failures propagate by identity and cannot publish successful readiness', async () => {
  for (const failHook of ['navigation', 'shell', 'canvas']) {
    const s = scenario({ failHook });
    await assert.rejects(runBrowserAction(s.input), error => error === s.hookFailure);
    assert.equal(s.canvasWitnesses.length, 0);
  }
});

test('an already aborted attempt performs no navigation or public action', async () => {
  const s = scenario(), controller = new AbortController(), reason = Error('attempt stopped');
  controller.abort(reason); s.input.signal = controller.signal;
  await assert.rejects(runBrowserAction(s.input), error => error === reason);
  assert.deepEqual(s.events, []);
});


// These exercise the actual public driver and its original four actions. The
// observers are orchestration doubles, not font/resource proof authorities.
test('portable reopen nests its original action and checkpoint inside font and composition observers',async()=>{
 const s=scenario({operation:'portable.reopen'}),boundaries=[];let fontResult,compositionResult,checkpoints=0;
 s.input.services={...s.input.services,
  compositionObservation:{async navigation(action){boundaries.push('composition-enter');compositionResult=await action();boundaries.push('composition-return');return compositionResult;}},
  reopenFonts:{async navigation(action){boundaries.push('font-enter');fontResult=await action();boundaries.push('font-return');return fontResult;}},
  reopenResources:{async checkpoint(){checkpoints++;assert.deepEqual(actions(s.events),['goto','click:Open','click:document-row','click:Save checkpoint']);assert(s.events.includes('checkpoint-status'));boundaries.push('checkpoint');}}};
 const result=await runBrowserAction(s.input);
 assert.deepEqual(boundaries,['composition-enter','font-enter','checkpoint','font-return','composition-return']);assert.equal(checkpoints,1);
 assert.strictEqual(result,fontResult);assert.strictEqual(result,compositionResult);assert.equal(result.publicOpenCompleted,true);assert.equal(result.acceptedTestEdit,true);assert.equal(result.startupBoundary,'document-ready-via-Open');
 assert.deepEqual(actions(s.events),['goto','click:Open','click:document-row','click:Save checkpoint']);assert.equal(s.shellWitnesses.length,0);assert.equal(s.canvasWitnesses.length,0);
});

test('ordinary navigation never borrows portable reopen observers or their checkpoint',async()=>{
 const s=scenario({unselected:true}),unexpected=()=>{assert.fail('unrelated operation acquired reopen authority');};
 s.input.services={reopenFonts:{navigation:unexpected},reopenResources:{checkpoint:unexpected}};
 const result=await runBrowserAction(s.input);
 assert.equal(result.publicOpenCompleted,true);assert.deepEqual(actions(s.events),['goto','click:Open','click:document-row','click:Save checkpoint']);
 assert.equal(result.nativeReadiness,undefined);assert.equal(s.shellWitnesses.length,0);assert.equal(s.canvasWitnesses.length,0);
});

test('portable reopen preserves original action failures through both observers without checkpointing',async()=>{
 for(const failure of [{failGoto:true},{failClick:'Open'},{failClick:'Save checkpoint'}]){
  const s=scenario({operation:'portable.reopen',...failure}),boundaries=[];let checkpoints=0;
  s.input.services={...s.input.services,
   compositionObservation:{async navigation(action){boundaries.push('composition-enter');try{return await action();}finally{boundaries.push('composition-exit');}}},
   reopenFonts:{async navigation(action){boundaries.push('font-enter');try{return await action();}finally{boundaries.push('font-exit');}}},
   reopenResources:{async checkpoint(){checkpoints++;}}};
  await assert.rejects(runBrowserAction(s.input),error=>error===s.pageFailure);
  assert.deepEqual(boundaries,['composition-enter','font-enter','font-exit','composition-exit']);assert.equal(checkpoints,0);
  const observed=actions(s.events);assert.equal(observed.filter(value=>value==='goto').length,1);assert.equal(new Set(observed).size,observed.length,'A failure cannot cause a second public action');
  assert.equal(s.shellWitnesses.length,0);assert.equal(s.canvasWitnesses.length,0);
 }
});

test('portable reopen observer or checkpoint failures retain identity without repeating successful actions',async()=>{
 for(const where of ['font-before','checkpoint','font-after']){
  const s=scenario({operation:'portable.reopen'}),original=Object.freeze(Error('original '+where+' failure'));let fontCalls=0,compositionCalls=0,checkpoints=0;
  s.input.services={...s.input.services,
   compositionObservation:{async navigation(action){compositionCalls++;return action();}},
   reopenFonts:{async navigation(action){fontCalls++;if(where==='font-before')throw original;const value=await action();if(where==='font-after')throw original;return value;}},
   reopenResources:{async checkpoint(){checkpoints++;if(where==='checkpoint')throw original;}}};
  await assert.rejects(runBrowserAction(s.input),error=>error===original);
  assert.equal(fontCalls,1);assert.equal(compositionCalls,1);assert.equal(checkpoints,where==='font-before'?0:1);
  assert.deepEqual(actions(s.events),where==='font-before'?[]:['goto','click:Open','click:document-row','click:Save checkpoint']);assert.equal(original.message,'original '+where+' failure');
 }
});
