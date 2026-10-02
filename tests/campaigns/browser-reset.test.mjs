import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { cancelCampaignMaskDraft, captureBrowserBaseline, documentResetIdentity, resetBrowserCell, undoCommandMatches, undoVerifiedChild, verifyUndoChild } from '../../tooling/qualification/campaigns/browser-reset.mjs';

const copy = value => structuredClone(value);
const fixture = { documentId: 'sealed_document' };
const cell = operation => ({ operation });
const sourceDocument = () => ({
  id: fixture.documentId, revision: '7', branchId: 'original_branch', width: 512, height: 384,
  color: 'sRGB', depth: 8, orderedLayerIds: ['image_layer', 'text_layer'], historyHead: 'sealed_head',
  checkpoint: 'checkpoint_before', redo: null, compositionVersion: 'composition_original',
  image: { state: { hash: 'sha256:' + 'a'.repeat(64), byteLength: '256', mediaType: 'application/json' }, semanticDigest: 'sha256:' + 'b'.repeat(64), compositeAssetId: 'composite_original' },
});
const view = () => ({
  values: { 'Zoom percentage': '100', 'View X (px)': '0', 'View Y (px)': '0', Appearance: 'dark', Density: 'compact' },
  separators: { 'Request panel width': 320, 'Canvas and inspector width': 720 },
  tool: 'Move', selected: [], scroll: { x: 0, y: 24 },
});
const baseline = (operation = 'raster.export') => ({ kind: 'browser-reset-baseline-1', operation, document: documentResetIdentity(sourceDocument()), observedRevision: '7', view: view(),
  ...(['interaction.brush', 'raster.stroke-finalize'].includes(operation) ? { ui: { sessionId: 'owned_ui', uiSeq: '3', noSavedMaskDrafts: true } } : {}) });
const childNode = (operation = 'ImportAsset') => ({ id: 'campaign_child', documentId: fixture.documentId, parent: 'sealed_head', kind: 'image-edit', operation, before: copy(sourceDocument().image) });
const prior = () => ({ observations: { receipt: { commandId: 'campaign_command' } } });
const priorQueue = () => ({ observations: { jobId: 'owned_job', attemptId: 'owned_attempt' } });
const queued = (id = 'owned_job', attemptId = 'owned_attempt', hold = false) => ({ id, attempts: [{ id: attemptId, state: hold ? 'acknowledged' : 'provider-terminal', hold }] });
const maskDraft = () => ({ id: 'campaign_mask', generation: '2', kind: 'mask', documentId: fixture.documentId,
  targetLayerId: 'image_layer', expectedDocumentRevision: '7', assetId: 'mask_draft_asset', composing: false, status: 'saved-unapplied' });
const uiCheckpoint = (drafts = []) => ({ sessionId: 'owned_ui', uiSeq: '3',
  preferences: { documentId: fixture.documentId, tool: 'mask', viewport: { x: 0, y: 0, zoom: 1 },
    panels: { left: 320, right: 720, active: 'layers' }, selectedLayerIds: [] },
  drafts: copy(drafts), reconciledLayerIds: [] });

// A strict public UI/protocol model, with real witness callbacks evaluated in
// an isolated context. There is no product, browser, network, or timing evidence
// in these tests; they verify orchestration and refusal before unsafe actions.
function publicPage(options = {}) {
  const state = {
    document: copy(options.document ?? sourceDocument()), view: view(), clicks: [], reads: [], controls: [], waits: [],
    drafts: new Set(options.drafts ?? []), editorDialog: false, historyPages: options.historyPages ?? [{ items: [childNode()], next: null }],
    queuePages: options.queuePages ?? [{ jobs: [queued()], nextCursor: null, counts: { active: 0, remaining: 3 } }],
    receipt: options.receipt ?? { kind: 'receipt', receipt: { status: 'accepted', commandId: 'campaign_command', documentRevision: '8' } },
    commandReplies: [], pendingResponse: null, routeHandler: null, routes: [], aborted: [], dispatchedCommands: [], fallthrough: [],
    ui: copy(options.ui ?? uiCheckpoint(options.drafts?.includes('Cancel mask draft') ? [maskDraft()] : [])),
    uiRequests: [], uiReplies: [], uiReads: 0, maskHidden: options.maskHidden === true, busy: false,
  };
  function uiResponse(type) {
    const requestId = 'ui_request_' + (state.uiRequests.length + 1);
    const request = { protocolVersion: 1, requestId, sessionId: state.ui.sessionId, expectedUISeq: state.ui.uiSeq,
      body: type === 'SetPreferences' ? { type, preferences: copy(state.ui.preferences) }
        : { type, draftId: state.ui.drafts.find(draft => draft.kind === 'mask')?.id ?? 'campaign_mask',
          generation: state.ui.drafts.find(draft => draft.kind === 'mask')?.generation ?? '2' } };
    options.changeUIRequest?.(type, request, state);
    state.uiRequests.push(copy(request));
    const receipt = { protocolVersion: 1, requestId: request.requestId, status: 'accepted', uiSeq: String(BigInt(state.ui.uiSeq) + 1n), reason: null };
    options.changeUIReceipt?.(type, receipt, state);
    if (receipt.status === 'accepted') {
      state.ui.uiSeq = receipt.uiSeq;
      if (type === 'ClearDraft' && !options.retainClearedDraft) state.ui.drafts = state.ui.drafts.filter(draft => draft.id !== request.body.draftId);
    }
    const response = { request: () => ({ method: () => 'POST', postDataJSON: () => copy(request) }),
      url: () => 'http://127.0.0.1/api/v1/ui/' + (options.uiResponseSessionId ?? state.ui.sessionId), status: () => 200, ok: () => true, json: async () => copy(receipt) };
    state.uiReplies.push(copy(receipt));
    if (state.pendingResponse) {
      const pending = state.pendingResponse; state.pendingResponse = null;
      if (pending.predicate(response)) pending.resolve(response);
      else pending.reject(Error('No matching fresh public UI response'));
    }
  }
  const window = {
    get scrollX() { return state.view.scroll.x; }, get scrollY() { return state.view.scroll.y; },
    scrollTo(value) { assert.equal(value.behavior, 'instant'); state.controls.push(['scroll', value.left, value.top]); state.view.scroll = { x: value.left, y: value.top }; },
  };
  function locator(kind, name, scope, roleOptions = {}) {
    const result = {
      async count() {
        if (kind === 'button' && name === 'Cancel mask draft') return state.maskHidden && roleOptions.includeHidden !== true ? 0 : 1;
        if (kind === 'button' && String(name).startsWith('Cancel ')) return state.drafts.has(name) ? 1 : 0;
        if (kind === 'selector' && name === '#editor-dialog') return state.editorDialog ? 1 : 0;
        return 1;
      },
      async isVisible() { if (name === 'Cancel mask draft') return !state.maskHidden; return kind === 'selector' && name === '#editor-dialog' ? state.editorDialog : true; },
      async isEnabled() { return name === 'Cancel mask draft' ? state.drafts.has(name) && !state.busy : true; },
      async inputValue() { assert(name in state.view.values); return state.view.values[name]; },
      async selectOption(value) { assert.equal(kind, 'combobox'); state.controls.push(['select', name, value]); state.view.values[name] = value; },
      async fill(value) { assert.equal(kind, 'spinbutton'); state.controls.push(['fill', name, value]); state.view.values[name] = value; },
      async focus() { assert.equal(kind, 'separator'); },
      async press(key) {
        if (kind === 'spinbutton') { assert.equal(key, 'Tab'); return; }
        assert.equal(kind, 'separator'); assert(['ArrowRight', 'ArrowLeft'].includes(key));
        state.controls.push(['press', name, key]);
        state.view.separators[name] += (key === 'ArrowRight' ? 1 : -1) * (options.splitterStep ?? 10);
      },
      async getAttribute(attribute) { assert.equal(kind, 'separator'); assert.equal(attribute, 'aria-valuenow'); return state.view.separators[name] === null ? null : String(state.view.separators[name]); },
      async innerText() { assert.equal(name, 'en-button.tool[aria-pressed="true"]'); return state.view.tool; },
      async evaluateAll(callback) {
        assert.equal(kind, 'treeitem'); assert.equal(scope, '#layer-tree');
        return callback(state.document.orderedLayerIds.map((_, index) => ({ getAttribute(attribute) { assert.equal(attribute, 'aria-selected'); return String(state.view.selected.includes(index)); } })));
      },
      getByRole(role, childOptions = {}) { return locator(role, childOptions.name, name, childOptions); },
      filter() { return result; },
      async waitFor(value) { state.waits.push([kind, String(name), value.state]); },
      async click() {
        state.clicks.push(name instanceof RegExp ? 'Select sealed document' : name);
        if (name instanceof RegExp) { assert.equal(scope, 'Open document'); assert(name.test('Untitled document · ' + fixture.documentId + ' · 512 × 384 · revision ' + state.document.revision));assert(!name.test('Contains ' + fixture.documentId + ' · foreign_document · 512 × 384 · revision ' + state.document.revision),'Authored title cannot impersonate the document identity'); state.view.selected = []; return; }
        if (name === 'Cancel mask draft') {
          assert(!state.maskHidden, 'A hidden mask panel must be revealed before cancellation');
          if (options.requireFreshMaskReceipt) assert(state.pendingResponse, 'Observe a new ClearDraft response before clicking Cancel');
          uiResponse('ClearDraft');
          if (!options.keepCancelEnabled) state.drafts.delete(name);
          state.busy = options.remainBusy === true; return;
        }
        if (String(name).startsWith('Cancel ')) { state.drafts.delete(name); return; }
        if (['Move', 'Select', 'Mask', 'Pan', 'Zoom', 'Sample'].includes(name)) {
          state.view.tool = name;
          if (name === 'Mask') { state.maskHidden = false; if (options.restoreMaskOnReveal) state.drafts.add('Cancel mask draft'); }
          return;
        }
        if (name === 'Apply view') { uiResponse('SetPreferences'); return; }
        if (name === 'Undo') {
          assert(state.pendingResponse, 'Register the durable command witness before the public Undo click');
          assert(state.routeHandler, 'Fence the original public command before the Undo click');
          for (const request of options.unrelatedRequests ?? []) {
            await state.routeHandler({ request: () => request, async fallback(...args) { assert.deepEqual(args, []); state.fallthrough.push(request.method()); }, async abort() { assert.fail('Unrelated requests must retain the existing route guards'); } });
          }
          const command = copy(options.undoCommand ?? { documentId: state.document.id, expectedDocumentRevision: state.document.revision, body: { type: 'Undo', historyHead: state.document.historyHead } });
          const request = { method: () => 'POST', postDataJSON: () => ({ command }) };
          let admitted = false;
          await state.routeHandler({ request: () => request, async fallback(...args) { assert.deepEqual(args, [], 'The original public command bytes cannot be rewritten'); admitted = true; }, async abort(reason) { state.aborted.push(reason); } });
          if (!admitted) return;
          state.dispatchedCommands.push(command);
          if (options.undoStatus !== 'rejected') state.document = { ...sourceDocument(), revision: '9', redo: 'campaign_child', checkpoint: 'checkpoint_retained' };
          const response = {
            request: () => request,
            url: () => 'http://127.0.0.1/api/v1/commands',
            json: async () => ({ commandId: 'undo_command', receipt: { commandId: 'undo_command', status: options.undoStatus ?? 'accepted' } }),
          };
          assert(state.pendingResponse.predicate(response)); state.commandReplies.push('Undo'); state.pendingResponse.resolve(response); state.pendingResponse = null; return;
        }
        assert(['Open', 'Apply view', 'History'].includes(name), 'Unexpected public action: ' + name);
      },
    };
    return result;
  }
  const page = {
    getByRole(role, roleOptions = {}) { return locator(role, roleOptions.name, undefined, roleOptions); },
    getByText(text) { return locator('text', text); },
    locator(selector) { return locator('selector', selector); },
    async route(pattern, handler) { assert.equal(pattern, '**/api/v1/commands'); assert.equal(state.routeHandler, null); state.routes.push('install'); state.routeHandler = handler; },
    async unroute(pattern, handler) { assert.equal(pattern, '**/api/v1/commands'); assert.equal(state.routeHandler, handler); state.routes.push('remove'); state.routeHandler = null; },
    waitForResponse(predicate) { return new Promise((resolve, reject) => { assert.equal(state.pendingResponse, null); state.pendingResponse = { predicate, resolve, reject }; }); },
    async evaluate(callback, arg) {
      const fetch = async (path, init) => {
        assert.deepEqual(copy(init), { headers: { 'X-App-Client': 'LP-1' }, credentials: 'same-origin' });
        state.reads.push(path);
        let value;
        if (path === '/api/v1/documents/' + fixture.documentId) value = options.projection ?? { projection: { kind: 'inline', value: state.document } };
        else if (path.startsWith('/api/v1/documents/' + fixture.documentId + '/history')) {
          const cursor = new URL(path, 'http://127.0.0.1').searchParams.get('after');
          value = state.historyPages[cursor ? Number(cursor) : 0];
        } else if (path.startsWith('/api/v1/queue')) {
          const cursor = new URL(path, 'http://127.0.0.1').searchParams.get('after');
          value = state.queuePages[cursor ? Number(cursor) : 0];
        } else if (path === '/api/v1/commands/campaign_command') value = state.receipt;
        else if (path === '/api/v1/ui/' + state.ui.sessionId) {
          state.uiReads++; value = copy(state.ui); options.changeUICheckpoint?.(value, state.uiReads, state);
        }
        else assert.fail('Unexpected public read: ' + path);
        assert(value, 'A public page witness must exist'); return { ok: true, json: async () => copy(value) };
      };
      return copy(await runInNewContext('(' + callback.toString() + ')', { window, fetch })(arg));
    },
    async waitForFunction(callback, argument) {
      if (options.settleBusyOnIdle) state.busy = false;
      let maskControlsRead = false;
      const document = {
        querySelector(selector) {
          if (selector === '.operation-status') return { getAttribute(attribute) { assert.equal(attribute, 'aria-busy'); return String(state.busy); } };
          assert.equal(selector, 'canvas[aria-label="Document raster preview"]');
          return { getAttribute(attribute) { assert.equal(attribute, 'data-asset'); return state.document.image?.compositeAssetId ?? ''; } };
        },
        querySelectorAll(selector) {
          maskControlsRead = true;
          if (selector === 'en-button') return [{ textContent: 'Cancel mask draft', disabled: !state.drafts.has('Cancel mask draft') || state.busy }];
          assert.equal(selector, 'en-badge');
          return state.drafts.has('Cancel mask draft') || options.keepMaskBadge ? [{ textContent: options.staleMaskBadge ? 'Stale mask draft' : 'Unapplied mask draft' }] : [];
        },
      };
      assert.equal(runInNewContext('(' + callback.toString() + ')', { document })(argument), true, 'The public DOM witness must settle before reset can succeed');
      state.waits.push(argument === null ? maskControlsRead ? ['mask-controls', state.drafts.has('Cancel mask draft') ? 'enabled' : 'disabled'] : ['operation-idle'] : ['canvas', argument]);
    },
  };
  return { page, state };
}

function queueControls(jobs = [queued()], effects = {}) {
  const calls = [];
  return { calls, async read() { calls.push(['read']); return { jobs: copy(jobs) }; }, async set(value) { calls.push(['set', copy(value)]); return { failures: [], heldMedia: 0, quiescent: true, pendingTick: false, counts: { submitted: 2, media: 2 }, ...effects }; } };
}
function noPage() { return new Proxy({}, { get(_target, key) { assert.fail('Reset touched the page before checking its prerequisites: ' + String(key)); } }); }
function inconclusive(result, pattern) { assert.equal(result.status, 'INCONCLUSIVE'); assert.equal(result.missing.length, 1); assert.match(result.missing[0], pattern); }

test('reset identity ignores only advancing revision, checkpoint and retained redo metadata', () => {
  const original = sourceDocument(), changed = { ...copy(original), revision: '999', checkpoint: 'later_checkpoint', redo: 'retained_child' };
  assert.deepEqual(documentResetIdentity(changed), documentResetIdentity(original));
  assert.deepEqual(documentResetIdentity(original).image, original.image);
  const normalized = documentResetIdentity({ ...original, image: undefined, compositionVersion: undefined });
  assert.equal(normalized.image, null); assert.equal(normalized.compositionVersion, null);
});

test('reset identity retains the full image source closure, pixel identity, layer order, composition and head', () => {
  const original = sourceDocument(), identity = documentResetIdentity(original);
  for (const mutate of [
    value => { value.id = 'foreign_document'; }, value => { value.historyHead = 'foreign_head'; },
    value => { value.width++; }, value => { value.height++; }, value => { value.color = 'changed'; }, value => { value.depth = 16; },
    value => { value.orderedLayerIds.reverse(); }, value => { value.compositionVersion = 'different_composition'; },
    value => { value.image.state.hash = 'sha256:' + 'c'.repeat(64); }, value => { value.image.state.byteLength = '257'; },
    value => { value.image.semanticDigest = 'different_pixels'; }, value => { value.image.compositeAssetId = 'different_asset'; },
  ]) { const changed = copy(original); mutate(changed); assert.notDeepEqual(documentResetIdentity(changed), identity); }
  original.orderedLayerIds.reverse(); original.image.state.hash = 'mutated_after_capture';
  assert.equal(identity.orderedLayerIds[0], 'image_layer'); assert.equal(identity.image.state.hash, 'sha256:' + 'a'.repeat(64));
});

test('incomplete public document identity cannot become a reset baseline', () => {
  for (const value of [null, {}, { ...sourceDocument(), id: 12 }, { ...sourceDocument(), historyHead: null }, { ...sourceDocument(), orderedLayerIds: null }]) {
    assert.throws(() => documentResetIdentity(value), { code: 'CAMPAIGN_PREREQUISITE' });
  }
});

test('Undo proof allows exactly each supported campaign edit on the sealed parent', () => {
  for (const [operation, edits] of [['raster.import', ['ImportAsset']], ['raster.resample', ['ResampleImage']], ['raster.adopt', ['AdoptCandidate', 'AdoptReviewedCandidate']], ['text.apply', ['CreateTextLayer', 'CommitTextEdit', 'ReplaceTextFont']]]) {
    for (const edit of edits) {
      const node = childNode(edit);
      assert.deepEqual(verifyUndoChild(operation, baseline().document, { ...sourceDocument(), historyHead: node.id }, node), { historyHead: node.id, parent: 'sealed_head', operation: edit });
    }
  }
});

test('Undo proof rejects foreign document, head, parent, node kind and operation', () => {
  const original = sourceDocument(), current = { ...original, historyHead: 'campaign_child' };
  for (const [operation, candidate, node] of [
    ['raster.export', current, childNode()], ['raster.import', { ...current, id: 'foreign_document' }, childNode()],
    ['raster.import', current, null], ['raster.import', current, { ...childNode(), id: 'other_head' }],
    ['raster.import', current, { ...childNode(), documentId: 'foreign_document' }],
    ['raster.import', current, { ...childNode(), parent: 'intermediate_edit' }],
    ['raster.import', current, { ...childNode(), kind: 'checkpoint' }], ['raster.import', current, childNode('ResampleImage')],
  ]) assert.throws(() => verifyUndoChild(operation, original, candidate, node), { code: 'CAMPAIGN_PREREQUISITE' });
});

test('Undo proof rejects a child whose before closure differs even with the same composite asset', () => {
  for (const field of ['state', 'semanticDigest', 'compositeAssetId']) {
    const node = childNode(); node.before[field] = field === 'state' ? { ...node.before.state, hash: 'foreign_source_root' } : 'foreign_value';
    assert.throws(() => verifyUndoChild('raster.import', sourceDocument(), { ...sourceDocument(), historyHead: node.id }, node), /exact original pixels and image state/);
  }
});

test('outgoing Undo matcher binds the public command type, document, revision and exact child', () => {
  const expected = { ...sourceDocument(), revision: '8', historyHead: 'campaign_child' };
  const command = { documentId: expected.id, expectedDocumentRevision: expected.revision, body: { type: 'Undo', historyHead: expected.historyHead } };
  assert.equal(undoCommandMatches(command, expected), true);
  for (const value of [null, {}, { ...command, documentId: 'foreign_document' }, { ...command, expectedDocumentRevision: '9' }, { ...command, expectedDocumentRevision: 8 }, { ...command, body: { ...command.body, historyHead: 'concurrent_child' } }, { ...command, body: { ...command.body, type: 'Redo' } }]) {
    assert.equal(undoCommandMatches(value, expected), false);
  }
});

test('a warm reset without its original baseline fails before accessing the page', async () => {
  for (const operation of ['raster.import', 'raster.export', 'queue.fault']) inconclusive(await resetBrowserCell({ page: noPage(), fixture, cell: cell(operation), sample: { cache: 'warm' }, previousResult: prior() }), /baseline/i);
});

test('a foreign, malformed or wrong-operation baseline fails before accessing the page', async () => {
  for (const value of [{}, { ...baseline(), kind: 'unsealed' }, { ...baseline(), operation: 'raster.import' }, { ...baseline(), document: { ...baseline().document, id: 'foreign_document' } }, { ...baseline(), view: null }]) {
    inconclusive(await resetBrowserCell({ page: noPage(), fixture, cell: cell('raster.export'), baseline: value, previousResult: {} }), /baseline.*cell.*sealed document/);
  }
});

test('readiness and fallback claims and reuse of a cold sample fail before page access', async () => {
  for (const parameters of [{ readiness: 'A' }, { decodedCache: 'warm' }, { mode: 'fallback' }]) {
    inconclusive(await resetBrowserCell({ page: noPage(), fixture, cell: { operation: 'raster.export', parameters }, baseline: baseline() }), /readiness/);
  }
  inconclusive(await resetBrowserCell({ page: noPage(), fixture, cell: cell('navigation.ready'), sample: { cache: 'cold' }, previousResult: {} }), /fresh browser and backend processes/);
});

test('navigation cells leave navigation inside the measured action and retain checkpoints', async () => {
  for (const operation of ['navigation.ready', 'portable.reopen', 'startup.failure']) {
    const result = await resetBrowserCell({ page: noPage(), cell: cell(operation), sample: { cache: 'cold' } });
    assert.deepEqual(result, { status: 'PASS', cache: 'cold', navigationInsideAction: true, checkpointsRetained: true, missing: [] });
  }
});

test('an aborted reset preserves the abort reason and performs no page access', async () => {
  const controller = new AbortController(), reason = Error('reset cancelled'); controller.abort(reason);
  await assert.rejects(resetBrowserCell({ page: noPage(), fixture, cell: cell('raster.export'), signal: controller.signal }), error => error === reason);
});

test('initial capture witnesses the exact document and canvas without changing public controls', async () => {
  const { page, state } = publicPage();
  const result = await resetBrowserCell({ page, fixture, cell: cell('raster.export'), sample: { cache: 'warm' } });
  assert.equal(result.status, 'PASS'); assert.deepEqual(result.baseline, baseline());
  assert.deepEqual(state.clicks, []); assert.deepEqual(state.controls, []); assert.deepEqual(result.actions, []);
  assert.deepEqual(state.waits, [['canvas', 'composite_original']]); assert.equal(result.pageReloaded, false);
});

test('baseline capture rejects drafts, selected layers, modal tools and missing splitter witnesses', async () => {
  for (const label of ['Cancel text edit', 'Cancel mask draft', 'Cancel review']) {
    const { page } = publicPage({ drafts: [label] });
    await assert.rejects(captureBrowserBaseline({ page, fixture, cell: cell('raster.export') }), /existing unapplied draft or review/);
  }
  for (const [mutate, pattern] of [[state => { state.view.selected = [1]; }, /before selecting layers/], [state => { state.view.tool = 'Text'; }, /nonmodal/], [state => { state.view.separators['Request panel width'] = null; }, /splitter value unavailable/]]) {
    const { page, state } = publicPage(); mutate(state);
    await assert.rejects(captureBrowserBaseline({ page, fixture, cell: cell('raster.export') }), pattern);
  }
});

test('missing or foreign inline projections never become baselines', async () => {
  for (const projection of [{}, { projection: { kind: 'blob', value: sourceDocument() } }, { projection: { kind: 'inline', value: { ...sourceDocument(), id: 'foreign_document' } } }]) {
    const { page, state } = publicPage({ projection });
    inconclusive(await resetBrowserCell({ page, fixture, cell: cell('raster.export') }), /inline public projection.*exact sealed document/);
    assert.deepEqual(state.clicks, []);
  }
});

test('baseline capture refuses invalid numeric, appearance, density and scroll witnesses', async () => {
  for (const mutate of [
    state => { state.view.values['Zoom percentage'] = ''; }, state => { state.view.values['View X (px)'] = 'Infinity'; },
    state => { state.view.values['View Y (px)'] = 'arbitrary text'; }, state => { state.view.values.Appearance = 'unknown'; },
    state => { state.view.values.Density = 'unknown'; }, state => { state.view.scroll.x = NaN; }, state => { state.view.scroll.y = Infinity; },
  ]) {
    const { page, state } = publicPage(); mutate(state);
    await assert.rejects(captureBrowserBaseline({ page, fixture, cell: cell('raster.export') }), { code: 'CAMPAIGN_PREREQUISITE' });
    assert.deepEqual(state.clicks, []);
  }
});

test('warm draft reset cancels drafts and restores selection, view, splitters, tool and scroll using public UI', async () => {
  const { page, state } = publicPage({ drafts: ['Cancel text edit', 'Cancel mask draft', 'Cancel review'] });
  state.view.values = { 'Zoom percentage': '125', 'View X (px)': '20', 'View Y (px)': '-10', Appearance: 'light', Density: 'comfortable' };
  state.view.separators = { 'Request panel width': 340, 'Canvas and inspector width': 700 };
  state.view.selected = [0]; state.view.tool = 'Mask'; state.view.scroll = { x: 8, y: 120 };
  state.document.revision = '10'; state.document.checkpoint = 'later_checkpoint'; state.document.redo = 'retained_child';
  const result = await resetBrowserCell({ page, fixture, cell: cell('interaction.brush'), baseline: baseline('interaction.brush'), previousResult: {} });
  assert.equal(result.status, 'PASS'); assert.deepEqual(state.view, view());
  assert.deepEqual(result.actions, ['Cancel text edit', 'Cancel review', 'Cancel mask draft', 'Restore public view without navigation']);
  assert.deepEqual(state.clicks, ['Cancel text edit', 'Cancel review', 'Apply view', 'Cancel mask draft', 'Open', 'Select sealed document', 'Apply view', 'Move', 'History']);
  assert.deepEqual(state.uiRequests.map(request => request.body.type), ['SetPreferences', 'ClearDraft', 'SetPreferences']);
  assert.equal(result.evidence.maskDraft.cancelled, true); assert.equal(result.evidence.maskDraft.settledPublicControls, true);
  assert.equal(state.controls.filter(value => value[0] === 'press').length, 4);
  assert.equal(state.document.revision, '10'); assert.equal(state.document.redo, 'retained_child'); assert.equal(state.document.checkpoint, 'later_checkpoint');
  assert.equal(result.observedRevision, '10'); assert.equal(result.historyRetained, true); assert.equal(result.pageReloaded, false);
});

test('mask baseline binds the current public UI owner through a fresh accepted preference receipt', async () => {
  for (const operation of ['interaction.brush', 'raster.stroke-finalize']) {
    const { page, state } = publicPage();
    const captured = await captureBrowserBaseline({ page, fixture, cell: cell(operation) });
    assert.deepEqual(captured, { ...baseline(operation), ui: { sessionId: 'owned_ui', uiSeq: '4', noSavedMaskDrafts: true } });
    assert.deepEqual(state.clicks, ['Apply view']);
    assert.deepEqual(state.uiRequests.map(request => request.body.type), ['SetPreferences']);
    assert(state.reads.includes('/api/v1/ui/owned_ui')); assert.equal(state.pendingResponse, null);
  }
  const { page } = publicPage({ changeUIRequest(type, _request, state) {
    if (type === 'SetPreferences') state.view.scroll = { x: 0, y: 96 };
  } });
  const afterBinding = await captureBrowserBaseline({ page, fixture, cell: cell('interaction.brush') });
  assert.deepEqual(afterBinding.view.scroll, { x: 0, y: 96 }, 'Baseline view must include public owner-binding scroll effects');
});

test('a hidden enabled mask draft prevents baseline capture before any public mutation', async () => {
  const { page, state } = publicPage({ drafts: ['Cancel mask draft'], maskHidden: true });
  await assert.rejects(captureBrowserBaseline({ page, fixture, cell: cell('interaction.brush') }), /existing unapplied draft/);
  assert.deepEqual(state.clicks, []); assert.deepEqual(state.uiRequests, []);
  const busy = publicPage({ ui: uiCheckpoint(), drafts: ['Cancel mask draft'], maskHidden: true, settleBusyOnIdle: true });
  busy.state.busy = true;
  await assert.rejects(captureBrowserBaseline({ page: busy.page, fixture, cell: cell('interaction.brush') }), /existing unapplied draft/);
  assert.deepEqual(busy.state.waits, [['operation-idle']]); assert.deepEqual(busy.state.clicks, []);
});

test('saved mask checkpoints prevent baseline capture even before their hidden controls restore', async () => {
  const { page, state } = publicPage({ ui: uiCheckpoint([maskDraft()]), maskHidden: true });
  await assert.rejects(captureBrowserBaseline({ page, fixture, cell: cell('interaction.brush') }), /saved unapplied mask draft/);
  assert.deepEqual(state.clicks, ['Apply view']); assert.equal(state.drafts.size, 0);
  assert.equal(state.ui.drafts.length, 1);
});

test('mask baseline requires a fresh typed accepted UI receipt with exact request and owner identity', async () => {
  for (const options of [
    { changeUIRequest: (_type, request) => { request.protocolVersion = 2; } },
    { changeUIRequest: (_type, request) => { request.requestId = '../foreign'; } },
    { changeUIRequest: (_type, request) => { request.sessionId = 'foreign_ui'; } },
    { changeUIRequest: (_type, request) => { request.expectedUISeq = 3; } },
    { changeUIReceipt: (_type, receipt) => { receipt.requestId = 'old_request'; } },
    { changeUIReceipt: (_type, receipt) => { receipt.protocolVersion = 2; } },
    { changeUIReceipt: (_type, receipt) => { receipt.status = 'rejected'; } },
    { changeUIReceipt: (_type, receipt) => { receipt.uiSeq = '3'; } },
  ]) {
    const { page, state } = publicPage(options);
    await assert.rejects(captureBrowserBaseline({ page, fixture, cell: cell('interaction.brush') }), /fresh accepted typed UI receipt/);
    assert.equal(state.reads.some(path => path.startsWith('/api/v1/ui/')), false);
  }
});

test('mask baseline rejects stale, foreign, malformed or duplicate checkpoint ownership', async () => {
  for (const change of [checkpoint => { checkpoint.sessionId = 'foreign_ui'; },
    checkpoint => { checkpoint.uiSeq = '3'; }, checkpoint => { checkpoint.preferences.documentId = 'foreign_document'; },
    checkpoint => { checkpoint.drafts = null; },
    checkpoint => { checkpoint.drafts = [{ ...maskDraft(), id: '../foreign' }]; },
    checkpoint => { checkpoint.drafts = [maskDraft(), maskDraft()]; }]) {
    const { page, state } = publicPage({ changeUICheckpoint: change });
    await assert.rejects(captureBrowserBaseline({ page, fixture, cell: cell('interaction.brush') }), { code: 'CAMPAIGN_PREREQUISITE' });
    assert.deepEqual(state.clicks, ['Apply view']);
  }
});

test('mask cancellation refuses an absent original empty-owner baseline before page access', async () => {
  for (const value of [undefined, {}, { ui: { sessionId: 'owned_ui', noSavedMaskDrafts: false } },
    { ui: { sessionId: '../foreign', noSavedMaskDrafts: true } }]) {
    await assert.rejects(cancelCampaignMaskDraft({ page: noPage(), fixture, baseline: value }), /original empty owned UI checkpoint/);
  }
});

test('hidden restored mask cancellation waits for fresh ClearDraft and settled public controls', async () => {
  const { page, state } = publicPage({ ui: uiCheckpoint([maskDraft()]), maskHidden: true,
    restoreMaskOnReveal: true, requireFreshMaskReceipt: true });
  const before = copy(state.document), previousResult = { actions: [{ productCompletion: { draftId: 'campaign_mask' } }] };
  const result = await cancelCampaignMaskDraft({ page, fixture, baseline: baseline('interaction.brush'), previousResult });
  assert.deepEqual(result, { actions: ['Cancel mask draft'], evidence: { sessionId: 'owned_ui', requestId: 'ui_request_2',
    draftId: 'campaign_mask', generation: '2', uiSeq: '5', noSavedMaskDrafts: true, cancelled: true, settledPublicControls: true } });
  assert.deepEqual(state.clicks, ['Apply view', 'Mask', 'Cancel mask draft']);
  assert.deepEqual(state.uiRequests.map(request => request.body.type), ['SetPreferences', 'ClearDraft']);
  assert.deepEqual(state.waits, [['operation-idle'], ['mask-controls', 'enabled'], ['mask-controls', 'disabled']]);
  assert.equal(state.uiReads, 2); assert.deepEqual(state.ui.drafts, []); assert.deepEqual(state.document, before);
  assert(!state.clicks.includes('Clear mask')); assert(!state.clicks.includes('Start fresh mask'));
});

test('warm interaction reset restores the original tool and empty layer selection after hidden draft deletion', async () => {
  const { page, state } = publicPage({ ui: uiCheckpoint([maskDraft()]), maskHidden: true, restoreMaskOnReveal: true });
  state.view.tool = 'Pan'; state.view.selected = [1];
  const result = await resetBrowserCell({ page, fixture, cell: cell('interaction.brush'), sample: { cache: 'warm' },
    baseline: baseline('interaction.brush'), previousResult: { observations: { productCompletion: { draftId: 'campaign_mask' } } } });
  assert.equal(result.status, 'PASS'); assert.deepEqual(state.view, view());
  assert.deepEqual(result.actions, ['Cancel mask draft', 'Restore public view without navigation']);
  assert.equal(result.evidence.maskDraft.noSavedMaskDrafts, true);
  assert.equal(state.ui.drafts.length, 0); assert(state.clicks.indexOf('Cancel mask draft') < state.clicks.indexOf('Open'));
});

test('an already empty mask checkpoint is an observed no-op rather than a cancellation claim', async () => {
  const { page, state } = publicPage();
  const result = await cancelCampaignMaskDraft({ page, fixture, baseline: baseline('interaction.brush'), previousResult: {} });
  assert.deepEqual(result, { actions: [], evidence: { sessionId: 'owned_ui', uiSeq: '4', noSavedMaskDrafts: true, cancelled: false } });
  assert.deepEqual(state.clicks, ['Apply view']); assert.equal(state.uiReads, 1);
});

test('campaign mask ownership rejects changed owners, multiple drafts and mismatched or missing prior identities', async () => {
  for (const [options, previousResult] of [
    [{ ui: { ...uiCheckpoint(), sessionId: 'foreign_ui' } }, {}],
    [{ ui: uiCheckpoint([maskDraft(), { ...maskDraft(), id: 'other_mask' }]) }, {}],
    [{ ui: uiCheckpoint([maskDraft()]) }, { productCompletion: { draftId: 'other_mask' } }],
    [{}, { productCompletion: { draftId: 'campaign_mask' } }],
    [{}, { actions: [{ productCompletion: { draftId: 'campaign_mask' } }, { productCompletion: { draftId: 'other_mask' } }] }],
    [{}, { productCompletion: { draftId: '../foreign' } }],
    [{}, { actions: {} }], [{}, { actions: 'unverified' }],
  ]) {
    const { page, state } = publicPage(options);
    await assert.rejects(cancelCampaignMaskDraft({ page, fixture, baseline: baseline('interaction.brush'), previousResult }), { code: 'CAMPAIGN_PREREQUISITE' });
    assert.deepEqual(state.clicks, ['Apply view']); assert.equal(state.uiRequests.length, 1);
  }
});

test('legacy raster reset may cancel only its sole draft under the original empty owned baseline', async () => {
  const { page, state } = publicPage({ drafts: ['Cancel mask draft'] });
  const result = await cancelCampaignMaskDraft({ page, fixture, baseline: baseline('raster.stroke-finalize'), previousResult: { specimenId: 'stroke-000' } });
  assert.equal(result.evidence.draftId, 'campaign_mask'); assert.equal(result.evidence.cancelled, true);
  assert.deepEqual(state.clicks, ['Apply view', 'Cancel mask draft']);
});

test('busy unsaved raster drafts must settle before cancellation can be mistaken for an empty checkpoint', async () => {
  const { page, state } = publicPage({ ui: uiCheckpoint(), drafts: ['Cancel mask draft'], settleBusyOnIdle: true,
    requireFreshMaskReceipt: true, changeUIReceipt(type, _receipt, state) { if (type === 'SetPreferences') state.busy = true; } });
  const result = await cancelCampaignMaskDraft({ page, fixture, baseline: baseline('raster.stroke-finalize'), previousResult: { specimenId: 'stroke-000' } });
  assert.equal(result.evidence.cancelled, true); assert.equal(result.evidence.draftId, 'campaign_mask');
  assert.deepEqual(state.clicks, ['Apply view', 'Cancel mask draft']);
  assert.deepEqual(state.waits, [['operation-idle'], ['mask-controls', 'enabled'], ['mask-controls', 'disabled']]);
  assert.equal(state.uiRequests[1].body.type, 'ClearDraft'); assert.equal(state.uiReads, 2);
});

test('ClearDraft must acknowledge the exact request owner, draft and a nonolder saved generation', async () => {
  for (const options of [
    { changeUIRequest: (type, request) => { if (type === 'ClearDraft') request.body.draftId = 'foreign_mask'; } },
    { changeUIRequest: (type, request) => { if (type === 'ClearDraft') request.body.generation = '1'; } },
    { changeUIRequest: (type, request) => { if (type === 'ClearDraft') request.body.generation = 2; } },
    { changeUIRequest: (type, request) => { if (type === 'ClearDraft') request.sessionId = 'foreign_ui'; } },
    { changeUIReceipt: (type, receipt) => { if (type === 'ClearDraft') receipt.requestId = 'old_request'; } },
    { changeUIReceipt: (type, receipt) => { if (type === 'ClearDraft') receipt.status = 'rejected'; } },
  ]) {
    const { page, state } = publicPage({ ...options, drafts: ['Cancel mask draft'], requireFreshMaskReceipt: true });
    await assert.rejects(cancelCampaignMaskDraft({ page, fixture, baseline: baseline('interaction.brush'),
      previousResult: { productCompletion: { draftId: 'campaign_mask' } } }), { code: 'CAMPAIGN_PREREQUISITE' });
    assert.deepEqual(state.uiRequests.map(request => request.body.type), ['SetPreferences', 'ClearDraft']);
    assert.equal(state.uiReads, 1, 'An invalid cancellation cannot become a settled checkpoint claim');
  }
});

test('a public cancellation may flush a newer draft generation before clearing the same owned draft', async () => {
  const { page } = publicPage({ drafts: ['Cancel mask draft'], changeUIRequest(type, request) {
    if (type === 'ClearDraft') request.body.generation = '3';
  } });
  const result = await cancelCampaignMaskDraft({ page, fixture, baseline: baseline('interaction.brush'),
    previousResult: { productCompletion: { draftId: 'campaign_mask' } } });
  assert.equal(result.evidence.generation, '3'); assert.equal(result.evidence.cancelled, true);
});

test('a fresh ClearDraft receipt is insufficient while the draft or busy DOM remains', async () => {
  for (const options of [{ keepCancelEnabled: true }, { keepMaskBadge: true }, { keepMaskBadge: true, staleMaskBadge: true }, { remainBusy: true }]) {
    const { page, state } = publicPage({ ...options, drafts: ['Cancel mask draft'] });
    await assert.rejects(cancelCampaignMaskDraft({ page, fixture, baseline: baseline('interaction.brush'), previousResult: {} }), /public DOM witness must settle/);
    assert.equal(state.uiReads, 1, 'Reset must not advance past unsettled public controls');
  }
});

test('settled mask controls cannot hide a retained, replaced or stale final checkpoint', async () => {
  for (const options of [{ retainClearedDraft: true },
    { changeUICheckpoint(checkpoint, read) { if (read === 2) checkpoint.drafts.push({ ...maskDraft(), status: 'applied' }); } },
    { changeUICheckpoint(checkpoint, read) { if (read === 2) checkpoint.drafts.push({ ...maskDraft(), id: 'replacement_mask' }); } },
    { changeUICheckpoint(checkpoint, read) { if (read === 2) checkpoint.uiSeq = '4'; } },
  ]) {
    const { page, state } = publicPage({ ...options, drafts: ['Cancel mask draft'] });
    await assert.rejects(cancelCampaignMaskDraft({ page, fixture, baseline: baseline('interaction.brush'), previousResult: {} }), { code: 'CAMPAIGN_PREREQUISITE' });
    assert.equal(state.uiReads, 2);
  }
});

test('mask cancellation propagates an abort before any public receipt or control action', async () => {
  const controller = new AbortController(), reason = Error('mask reset cancelled'); controller.abort(reason);
  await assert.rejects(cancelCampaignMaskDraft({ page: noPage(), fixture, baseline: baseline('interaction.brush'), signal: controller.signal }), error => error === reason);
});

test('an unreachable exact splitter baseline fails closed instead of rounding it', async () => {
  const { page, state } = publicPage(); state.view.separators['Request panel width'] = 325;
  inconclusive(await resetBrowserCell({ page, fixture, cell: cell('raster.export'), baseline: baseline(), previousResult: {} }), /cannot reach the exact baseline/);
  assert.equal(state.clicks.includes('Undo'), false);
});

test('unimplemented warm operations do not cancel drafts or select a document', async () => {
  const { page, state } = publicPage({ drafts: ['Cancel text edit'] });
  inconclusive(await resetBrowserCell({ page, fixture, cell: cell('capture.source'), baseline: baseline('capture.source'), previousResult: {} }), /No verified public warm reset/);
  assert.deepEqual(state.clicks, []);
});

test('Undo requires the sample receipt and exact revision ownership before reading history or clicking Undo', async () => {
  for (const [previousResult, receipt] of [
    [{}, undefined], [{ receipt: { commandId: '../foreign' } }, undefined],
    [prior(), { kind: 'pending', receipt: null }],
    [prior(), { kind: 'receipt', receipt: { status: 'rejected', commandId: 'campaign_command', documentRevision: '8' } }],
    [prior(), { kind: 'receipt', receipt: { status: 'accepted', commandId: 'other_command', documentRevision: '8' } }],
    [prior(), { kind: 'receipt', receipt: { status: 'accepted', commandId: 'campaign_command', documentRevision: '9' } }],
  ]) {
    const { page, state } = publicPage({ document: { ...sourceDocument(), historyHead: 'campaign_child', revision: '8' }, receipt });
    const result = await resetBrowserCell({ page, fixture, cell: cell('raster.import'), baseline: baseline('raster.import'), previousResult });
    inconclusive(result, /receipt/); assert.deepEqual(state.clicks, []); assert.equal(state.reads.some(path => path.includes('/history')), false);
  }
});

test('an owned single edit is undone through public UI and retains its redo branch and advanced revision', async () => {
  const { page, state } = publicPage({ document: { ...sourceDocument(), historyHead: 'campaign_child', revision: '8', image: { ...sourceDocument().image, compositeAssetId: 'edited_composite' } }, historyPages: [{ items: [], next: '1' }, { items: [childNode()], next: null }] });
  const result = await resetBrowserCell({ page, fixture, cell: cell('raster.import'), baseline: baseline('raster.import'), previousResult: prior() });
  assert.equal(result.status, 'PASS'); assert.deepEqual(state.commandReplies, ['Undo']);
  assert.deepEqual(result.actions, ['Undo exact campaign child', 'Restore public view without navigation']);
  assert.deepEqual(documentResetIdentity(state.document), baseline().document); assert.equal(state.document.redo, 'campaign_child'); assert.equal(state.document.revision, '9');
  assert.equal(result.evidence.undo.receipt.commandId, 'undo_command'); assert.equal(result.evidence.undo.receipt.status, 'accepted');
  assert.equal(result.cacheInvalidated, true); assert.match(result.missing[0], /Playwright routing.*invalidates browser resource cache/);
  assert.deepEqual(state.routes, ['install', 'remove']); assert.deepEqual(state.aborted, []);
  assert.deepEqual(state.dispatchedCommands, [{ documentId: fixture.documentId, expectedDocumentRevision: '8', body: { type: 'Undo', historyHead: 'campaign_child' } }]);
  assert(state.reads.includes('/api/v1/documents/sealed_document/history?after=1'));
  assert(state.reads.indexOf('/api/v1/commands/campaign_command') < state.reads.indexOf('/api/v1/documents/sealed_document/history'));
});

test('the public Undo proxy fence avoids all Playwright routing while retaining the original target proof', async () => {
  const expected = { id: 'owned_document', revision: '8', historyHead: 'owned_child' }, calls = [];
  let responseReady, predicate;
  const page = {
    waitForResponse(check) { predicate = check; return new Promise(resolve => { responseReady = resolve; }); },
    getByRole(role, options) {
      assert.equal(role, 'button'); assert.deepEqual(options, { name: 'Undo', exact: true });
      return { async click() {
        calls.push('public-click');
        const response = { request: () => ({ method: () => 'POST', postDataJSON: () => ({ command: { body: { type: 'Undo' } } }) }), url: () => 'http://127.0.0.1:4319/api/v1/commands', json: async () => ({ commandId: 'owned_undo', receipt: { commandId: 'owned_undo', status: 'accepted' } }) };
        assert.equal(predicate(response), true); responseReady(response);
      } };
    },
    route() { assert.fail('A proxy-fenced Undo must not disable the resource cache through routing'); },
  };
  const networkGuard = { async withUndoFence(actual, action) { assert.deepEqual(actual, expected); calls.push('proxy-fence'); const result = await action(); calls.push('proxy-proof'); return result; } };
  const receipt = await undoVerifiedChild(page, expected, undefined, networkGuard);
  assert.equal(receipt.commandId, 'owned_undo'); assert.equal(receipt.status, 'accepted');
  assert.deepEqual(calls, ['proxy-fence', 'public-click', 'proxy-proof']);
});

test('a public Undo command changed after verification is aborted before any mutation and its fence is removed', async () => {
  for (const changed of [{ documentId: 'foreign_document' }, { expectedDocumentRevision: '9' }, { body: { type: 'Undo', historyHead: 'concurrent_child' } }]) {
    const document = { ...sourceDocument(), historyHead: 'campaign_child', revision: '8' };
    const undoCommand = { documentId: fixture.documentId, expectedDocumentRevision: '8', body: { type: 'Undo', historyHead: 'campaign_child' }, ...changed };
    const { page, state } = publicPage({ document, undoCommand });
    inconclusive(await resetBrowserCell({ page, fixture, cell: cell('raster.import'), baseline: baseline('raster.import'), previousResult: prior() }), /changed target or revision before dispatch/);
    assert.deepEqual(state.document, document); assert.deepEqual(state.dispatchedCommands, []); assert.deepEqual(state.commandReplies, []);
    assert.deepEqual(state.aborted, ['blockedbyclient']); assert.deepEqual(state.routes, ['install', 'remove']);
    assert.equal(state.clicks.includes('Apply view'), false);
  }
});

test('unrelated requests fall through existing route guards without counting as an admitted Undo', async () => {
  const unrelatedRequests = [
    { method: () => 'GET', postDataJSON: () => ({ command: { body: { type: 'Undo' } } }) },
    { method: () => 'POST', postDataJSON: () => ({ command: { body: { type: 'SaveCheckpoint' } } }) },
    { method: () => 'GET', postDataJSON() { throw Error('GET has no JSON body'); } },
  ];
  const { page, state } = publicPage({ document: { ...sourceDocument(), historyHead: 'campaign_child', revision: '8' }, unrelatedRequests });
  const result = await resetBrowserCell({ page, fixture, cell: cell('raster.import'), baseline: baseline('raster.import'), previousResult: prior() });
  assert.equal(result.status, 'PASS'); assert.deepEqual(state.fallthrough, ['GET', 'POST', 'GET']);
  assert.deepEqual(state.commandReplies, ['Undo']); assert.deepEqual(state.routes, ['install', 'remove']); assert.deepEqual(state.aborted, []);
});

test('cyclic history pagination fails closed without undoing an unrelated child', async () => {
  const { page, state } = publicPage({ document: { ...sourceDocument(), historyHead: 'campaign_child', revision: '8' }, historyPages: [{ items: [], next: '1' }, { items: [], next: '1' }] });
  inconclusive(await resetBrowserCell({ page, fixture, cell: cell('raster.import'), baseline: baseline('raster.import'), previousResult: prior() }), /bounded public pagination/);
  assert.deepEqual(state.clicks, []); assert.equal(state.reads.filter(path => path.includes('/history')).length, 2);
});

test('a rejected Undo command is a reset failure, never a successful baseline claim', async () => {
  const { page } = publicPage({ document: { ...sourceDocument(), historyHead: 'campaign_child', revision: '8' }, undoStatus: 'rejected' });
  await assert.rejects(resetBrowserCell({ page, fixture, cell: cell('raster.import'), baseline: baseline('raster.import'), previousResult: prior() }), /Product command was not accepted/);
});

test('pixel or source closure divergence is a hard failure even when the history head matches', async () => {
  const document = sourceDocument(); document.image.state.hash = 'foreign_source_root';
  const { page } = publicPage({ document });
  await assert.rejects(resetBrowserCell({ page, fixture, cell: cell('raster.export'), baseline: baseline() }), /accepted source closure or pixels/);
});

test('queue reset requires the prior exact job and attempt owned by this emulator before changing controls', async () => {
  for (const [previousResult, owner] of [[{}, [queued()]], [priorQueue(), []], [priorQueue(), [queued('owned_job', 'earlier_attempt')]]]) {
    const controls = queueControls(owner), { page, state } = publicPage();
    inconclusive(await resetBrowserCell({ page, fixture, cell: cell('queue.fault'), baseline: baseline('queue.fault'), previousResult, controls }), /exact prior owned|not owned/);
    assert.equal(controls.calls.some(call => call[0] === 'set'), false); assert.deepEqual(state.clicks, []);
  }
});

test('queue reset retains paginated immutable jobs and returns the new effect baseline without resetting history', async () => {
  const controls = queueControls(), { page, state } = publicPage({ queuePages: [{ jobs: [queued('older_job', 'older_attempt')], nextCursor: '1', counts: { active: 0, remaining: 2 } }, { jobs: [queued()], nextCursor: null }] });
  const result = await resetBrowserCell({ page, fixture, cell: cell('queue.fault'), baseline: baseline('queue.fault'), previousResult: priorQueue(), controls });
  assert.equal(result.status, 'PASS');
  assert.deepEqual(result.evidence.queue, { priorJobId: 'owned_job', priorAttemptId: 'owned_attempt', retainedJobIds: ['older_job', 'owned_job'], effectsBaseline: { submitted: 2, media: 2 }, historyRetained: true, freshJobRequired: true });
  assert.deepEqual(controls.calls, [['read'], ['set', { paused: false, holdMedia: false, offline: false, status: 'COMPLETED', mediaStatus: 200, dropAcknowledgement: false }], ['set', { paused: true, holdMedia: false }]]);
  assert.equal(state.reads.filter(path => path === '/api/v1/queue?after=1').length, 2);
  assert.equal(state.queuePages.flatMap(value => value.jobs).length, 2); assert.equal(state.clicks.includes('Undo'), false);
});

test('queue reset rejects disappearing attempts, unrelated holds, exhausted capacity and cyclic pagination', async () => {
  for (const [queuePages, pattern] of [
    [[{ jobs: [queued('owned_job', 'different_attempt')], nextCursor: null }], /attempt disappeared/],
    [[{ jobs: [queued(), queued('other_job', 'other_attempt', true)], nextCursor: null }], /Another retained queue hold/],
    [[{ jobs: [queued()], nextCursor: null, counts: { active: 0, remaining: 0 } }], /capacity/],
    [[{ jobs: [queued()], nextCursor: '1' }, { jobs: [], nextCursor: '1' }], /bounded public pagination/],
  ]) {
    const controls = queueControls(), { page, state } = publicPage({ queuePages });
    inconclusive(await resetBrowserCell({ page, fixture, cell: cell('queue.fault'), baseline: baseline('queue.fault'), previousResult: priorQueue(), controls }), pattern);
    assert.deepEqual(state.clicks, []);
  }
});

test('queue reset refuses emulator transfer failures and held media before view restoration', async () => {
  for (const effects of [{ failures: ['failed transfer'] }, { heldMedia: 1 }]) {
    const controls = queueControls([queued()], effects), { page, state } = publicPage();
    inconclusive(await resetBrowserCell({ page, fixture, cell: cell('queue.fault'), baseline: baseline('queue.fault'), previousResult: priorQueue(), controls }), /failed or held transfer/);
    assert.deepEqual(state.clicks, []);
  }
});

test('queue reset requires an acknowledged observer and transfer drain, not only zero held media', async () => {
  for (const effects of [{ quiescent: undefined, pendingTick: undefined }, { quiescent: false }, { pendingTick: true }]) {
    const controls = queueControls([queued()], effects), { page, state } = publicPage();
    inconclusive(await resetBrowserCell({ page, fixture, cell: cell('queue.fault'), baseline: baseline('queue.fault'), previousResult: priorQueue(), controls }), /acknowledged drain/);
    assert.deepEqual(state.clicks, []);
  }
});

test('an initial queue sample requires paused and drained controls with a public available slot', async () => {
  const controls = queueControls(), { page, state } = publicPage();
  const result = await resetBrowserCell({ page, fixture, cell: cell('queue.fault'), controls });
  assert.equal(result.status, 'PASS');
  assert(controls.calls.some(([kind, value]) => kind === 'set' && value.paused === true));
  assert(state.reads.includes('/api/v1/queue')); assert.deepEqual(state.clicks, []);
});

test('the first queue sample fails closed for occupied, missing or malformed capacity witnesses', async () => {
  for (const counts of [undefined, { active: 1, remaining: 3 }, { active: 0 }, { active: 0, remaining: 0 }, { active: 0, remaining: 0.5 }, { active: 0, remaining: '3' }]) {
    const controls = queueControls(), { page, state } = publicPage({ queuePages: [{ jobs: [], nextCursor: null, counts }] });
    const result = await resetBrowserCell({ page, fixture, cell: cell('queue.fault'), controls });
    assert.equal(result.status, 'INCONCLUSIVE'); assert.equal(result.missing.length, 1); assert.deepEqual(state.clicks, []);
  }
});

test('an exact Fast rejection with zero submission effects can repeat without a job or unused request cap', async () => {
  const controls = queueControls([]), { page, state } = publicPage({ queuePages: [{ jobs: [], nextCursor: null, counts: { active: 0, remaining: 0 } }] });
  const previousResult = { observations: { caseId: 'WF11', scenario: 'reject-large', rejection: { valid: true }, document: { unchanged: true }, effects: { queuedJobsAdded: 0, attemptsAdded: 0, enqueueCommands: 0, submissions: 0 } } };
  const result = await resetBrowserCell({ page, fixture, cell: { operation: 'fast.workflow', parameters: { caseId: 'WF11' } }, baseline: baseline('fast.workflow'), previousResult, controls });
  assert.equal(result.status, 'PASS');
  assert.deepEqual(result.evidence.queue, { rejectionCase: 'WF11', expectedNoSubmission: true, retainedJobIds: [], effectsBaseline: { submitted: 2, media: 2 }, historyRetained: true, freshJobRequired: false });
  assert.deepEqual(controls.calls, [['set', { paused: true, holdMedia: false }]]);
  assert.equal(state.clicks.includes('Undo'), false); assert.equal(state.document.revision, '7');
});

test('Fast rejection reset rejects a wrong case, unverified rejection or any missing or nonzero submission effect', async () => {
  const evidence = { caseId: 'WF11', scenario: 'reject-large', rejection: { valid: true }, document: { unchanged: true }, effects: { queuedJobsAdded: 0, attemptsAdded: 0, enqueueCommands: 0, submissions: 0 } };
  for (const mutate of [
    value => { value.caseId = 'WF12'; }, value => { value.scenario = 'reject-invalid-size'; },
    value => { value.rejection.valid = false; }, value => { value.document.unchanged = false; },
    ...['queuedJobsAdded', 'attemptsAdded', 'enqueueCommands', 'submissions'].flatMap(key => [value => { value.effects[key] = 1; }, value => { delete value.effects[key]; }]),
  ]) {
    const previousResult = copy(evidence); mutate(previousResult);
    const controls = queueControls([]), { page, state } = publicPage();
    inconclusive(await resetBrowserCell({ page, fixture, cell: { operation: 'fast.workflow', parameters: { caseId: 'WF11' } }, baseline: baseline('fast.workflow'), previousResult, controls }), /exact prior rejection.*zero-job.*zero-attempt.*zero-submission/);
    assert.deepEqual(controls.calls, []); assert.deepEqual(state.clicks, []);
  }
});
