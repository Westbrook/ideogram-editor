import { maskDraftValue, maskImports } from '../../src/raster/mask.js';
import { textDraft, draftRefs } from '../../src/protocol/text.js';
import { AssetRejection } from './assets.js';
import { canonical, hashBytes, isId, isSeq } from './canonical.js';
import { keys as validKeys } from '../../src/protocol/validate.js';
const keys = (v, fields) => { try {
    validKeys(v, fields);
}
catch {
    throw new StoreError('MALFORMED_REQUEST');
} };
import { StoreError } from './errors.js';
import { parseControlJSON } from '../control-json.js';
const initial = (sessionId) => ({ sessionId, uiSeq: '0', preferences: { documentId: null, tool: 'select', viewport: { x: 0, y: 0, zoom: 1 }, panels: { left: 280, right: 280, active: 'layers' }, selectedLayerIds: [] }, drafts: [], reconciledLayerIds: [] });
function preferences(p) {
    keys(p, ['documentId', 'tool', 'viewport', 'panels', 'selectedLayerIds']);
    keys(p.viewport, ['x', 'y', 'zoom']);
    keys(p.panels, ['left', 'right', 'active']);
    if (!(p.documentId === null || isId(p.documentId)) || !['select', 'transform', 'crop', 'mask', 'text'].includes(p.tool) ||
        ![p.viewport.x, p.viewport.y, p.viewport.zoom, p.panels.left, p.panels.right].every(Number.isFinite) || p.viewport.zoom <= 0 || p.panels.left < 0 || p.panels.right < 0 ||
        !['layers', 'history', 'assets'].includes(p.panels.active) || !Array.isArray(p.selectedLayerIds) || p.selectedLayerIds.length > 100 || !p.selectedLayerIds.every(isId) || new Set(p.selectedLayerIds).size !== p.selectedLayerIds.length)
        throw new StoreError('MALFORMED_REQUEST');
}
export class UIStore {
    db;
    objects;
    assets;
    check;
    barrier;
    readState;
    register;
    constructor(db, objects, assets, check, barrier, readState, register) {
        this.db = db;
        this.objects = objects;
        this.assets = assets;
        this.check = check;
        this.barrier = barrier;
        this.readState = readState;
        this.register = register;
    }
    read(sessionId, auth) {
        this.check();
        if (!isId(sessionId))
            throw new StoreError('MALFORMED_REQUEST');
        const row = this.db.prepare('SELECT json FROM ui_checkpoints WHERE client_id=? AND session_id=?').get(auth.clientId, sessionId);
        return row ? JSON.parse(String(row.json)) : initial(sessionId);
    }
    fence(clientId, fence, documentId, revision, layerId) {
        if (!fence)
            return;
        const row = this.db.prepare('SELECT json FROM ui_checkpoints WHERE client_id=? AND session_id=?').get(clientId, fence.sessionId);
        const draft = row ? JSON.parse(String(row.json)).drafts.find(d => d.id === fence.draftId) : undefined;
        if (!draft || draft.generation !== fence.generation || draft.documentId !== documentId || draft.expectedDocumentRevision !== revision || draft.targetLayerId !== layerId || draft.composing || draft.status !== 'saved-unapplied')
            throw new AssetRejection('STALE_REVISION', 'DRAFT_GENERATION_CHANGED');
    }
    // Called inside the document transaction; this advances only the UI stream.
    applied(clientId, fence, now) {
        if (!fence)
            return;
        const row = this.db.prepare('SELECT json FROM ui_checkpoints WHERE client_id=? AND session_id=?').get(clientId, fence.sessionId);
        const state = JSON.parse(String(row.json));
        const draft = state.drafts.find(d => d.id === fence.draftId);
        draft.status = 'applied';
        this.save(clientId, state, { type: 'DraftApplied', draftId: draft.id, generation: draft.generation }, now);
    }
    save(clientId, state, body, now) {
        state.uiSeq = String(BigInt(state.uiSeq) + 1n);
        if (Buffer.byteLength(canonical(state)) > 65536)
            throw new StoreError('PAYLOAD_TOO_LARGE');
        this.db.prepare('INSERT INTO ui_checkpoints VALUES (?,?,?) ON CONFLICT(client_id,session_id) DO UPDATE SET json=excluded.json').run(clientId, state.sessionId, canonical(state));
        this.db.prepare('INSERT INTO ui_events VALUES (?,?,?,?,?)').run(clientId, state.sessionId, state.uiSeq, now, canonical(body));
        this.db.prepare('DELETE FROM ui_events WHERE client_id=? AND session_id=? AND (recorded_at<? OR seq IN (SELECT seq FROM ui_events WHERE client_id=? AND session_id=? ORDER BY length(seq) DESC,seq DESC LIMIT -1 OFFSET 1000))').run(clientId, state.sessionId, new Date(Date.parse(now) - 7 * 86400000).toISOString(), clientId, state.sessionId);
    }
    reconcile(documentId, state, now) {
        const valid = new Set(state.layers.map(l => l.id));
        for (const row of this.db.prepare('SELECT client_id,json FROM ui_checkpoints').iterate()) {
            const ui = JSON.parse(String(row.json));
            if (ui.preferences.documentId !== documentId)
                continue;
            const removed = ui.preferences.selectedLayerIds.filter(id => !valid.has(id));
            if (!removed.length)
                continue;
            ui.preferences.selectedLayerIds = ui.preferences.selectedLayerIds.filter(id => valid.has(id));
            ui.reconciledLayerIds = removed;
            this.save(String(row.client_id), ui, { type: 'SelectionReconciled', documentId, removed }, now);
        }
    }
    async persist(bytes, auth) {
        this.check();
        const v = parseControlJSON(bytes);
        keys(v, ['protocolVersion', 'requestId', 'sessionId', 'expectedUISeq', 'body']);
        if (v.protocolVersion !== 1 || !isId(v.requestId) || !isId(v.sessionId) || !isSeq(v.expectedUISeq))
            throw new StoreError('MALFORMED_REQUEST');
        const b = v.body;
        if (b?.type === 'SetPreferences') {
            keys(b, ['type', 'preferences']);
            preferences(b.preferences);
        }
        else if (b?.type === 'SaveDraft') {
            keys(b, ['type', 'draft']);
            const d = b.draft;
            keys(d, ['id', 'generation', 'kind', 'documentId', 'targetLayerId', 'expectedDocumentRevision', 'assetId', 'composing']);
            if (![d.id, d.documentId, d.assetId].every(isId) || !isSeq(d.generation) || !isSeq(d.expectedDocumentRevision) || !(d.targetLayerId === null || isId(d.targetLayerId)) || !['prompt', 'inspector', 'text', 'mask'].includes(d.kind) || typeof d.composing !== 'boolean')
                throw new StoreError('MALFORMED_REQUEST');
        }
        else if (b?.type === 'ClearDraft') {
            keys(b, ['type', 'draftId', 'generation']);
            if (!isId(b.draftId) || !isSeq(b.generation))
                throw new StoreError('MALFORMED_REQUEST');
        }
        else if (b?.type === 'FocusRequested') {
            keys(b, ['type', 'target', 'generation']);
            if (!['canvas', 'inspector', 'history'].includes(b.target) || !isSeq(b.generation))
                throw new StoreError('MALFORMED_REQUEST');
        }
        else
            throw new StoreError('MALFORMED_REQUEST');
        const request = v, hash = hashBytes(canonical(request));
        const previous = () => this.db.prepare('SELECT hash,json FROM ui_receipts WHERE client_id=? AND id=?').get(auth.clientId, request.requestId);
        let old = previous();
        if (old) {
            if (old.hash !== hash)
                throw new StoreError('COMMAND_ID_REUSE');
            return JSON.parse(String(old.json));
        }
        let bindings;
        let proof, ref;
        const extra = [];
        const slot = 'ui:' + auth.clientId + ':' + request.requestId;
        this.objects.acquire(slot);
        try {
            if (b.type === 'SaveDraft') {
                const a = this.assets.asset(b.draft.assetId);
                if (!a || a.qualification !== 'opaque-text' || a.safety !== 'safe' || a.availability !== 'available')
                    throw new StoreError('MISSING_OBJECT');
                ref = a.blob;
                proof = await this.objects.prove(ref, () => this.check());
                if (b.draft.kind === 'mask') {
                    const value = parseControlJSON(this.objects.verify(ref, true));
                    maskDraftValue(value);
                    bindings = {};
                    for (const id of maskImports(value.plan)) {
                        const source = this.assets.asset(id);
                        if (!source?.raster || source.raster.role !== 'native' || source.qualification !== 'canonical-raster' || source.safety !== 'safe' || source.availability !== 'available')
                            throw new StoreError('MISSING_OBJECT');
                        bindings[id] = id;
                        for (const dep of [source.blob, ...source.dependencies])
                            extra.push({ ref: dep, proof: await this.objects.prove(dep, () => this.check()) });
                    }
                }
                if (b.draft.kind === 'text') {
                    const v = parseControlJSON(this.objects.verify(ref, true));
                    textDraft(v);
                    for (const dep of draftRefs(v)) {
                        try {
                            extra.push({ ref: dep, proof: await this.objects.prove(dep, () => this.check()) });
                        }
                        catch (e) {
                            if (dep === v.textUtf8 || !(e instanceof StoreError) || !['MISSING_OBJECT', 'CORRUPT_OBJECT'].includes(e.code))
                                throw e;
                        }
                    }
                }
            }
            this.db.exec('BEGIN IMMEDIATE');
            try {
                this.check();
                old = previous();
                if (old) {
                    if (old.hash !== hash)
                        throw new StoreError('COMMAND_ID_REUSE');
                    this.db.exec('ROLLBACK');
                    return JSON.parse(String(old.json));
                }
                const state = this.read(request.sessionId, auth);
                let reason = state.uiSeq !== request.expectedUISeq ? 'STALE_UI_SEQUENCE' : null;
                if (!reason && b.type === 'SaveDraft') {
                    const prior = state.drafts.find(d => d.id === b.draft.id);
                    if (prior && BigInt(b.draft.generation) <= BigInt(prior.generation))
                        reason = 'STALE_DRAFT_GENERATION';
                    else if (!prior && state.drafts.length >= 64)
                        reason = 'DRAFT_CHECKPOINT_CAPACITY';
                    else {
                        const seen = new Set();
                        for (const p of extra) {
                            if (seen.has(p.ref.hash))
                                continue;
                            seen.add(p.ref.hash);
                            this.objects.proven(p.ref, p.proof);
                            this.register('ui:' + auth.clientId + ':' + request.sessionId + ':' + b.draft.id + ':' + b.draft.generation, p.ref, p.proof);
                        }
                        if (ref && proof) {
                            this.objects.proven(ref, proof);
                            this.register('ui:' + auth.clientId + ':' + request.sessionId + ':' + b.draft.id + ':' + b.draft.generation, ref, proof);
                        }
                        state.drafts = state.drafts.filter(d => d.id !== b.draft.id);
                        state.drafts.push({ ...b.draft, ...(bindings ? { maskBindings: bindings } : {}), status: 'saved-unapplied' });
                    }
                }
                else if (!reason && b.type === 'ClearDraft') {
                    const prior = state.drafts.find(d => d.id === b.draftId);
                    if (!prior || prior.generation !== b.generation)
                        reason = 'STALE_DRAFT_GENERATION';
                    else
                        state.drafts = state.drafts.filter(d => d.id !== b.draftId);
                }
                else if (!reason && b.type === 'SetPreferences') {
                    const selected = b.preferences.selectedLayerIds;
                    let valid = new Set();
                    if (b.preferences.documentId) {
                        try {
                            valid = new Set(this.readState(b.preferences.documentId).layers.map(l => l.id));
                        }
                        catch {
                            reason = 'DOCUMENT_UNAVAILABLE';
                        }
                    }
                    if (!reason) {
                        state.preferences = b.preferences;
                        state.reconciledLayerIds = selected.filter((id) => !valid.has(id));
                        state.preferences.selectedLayerIds = selected.filter((id) => valid.has(id));
                    }
                }
                if (!reason)
                    this.save(auth.clientId, state, b, new Date(auth.now).toISOString());
                const receipt = { protocolVersion: 1, requestId: request.requestId, status: reason ? 'rejected' : 'accepted', uiSeq: state.uiSeq, reason };
                this.db.prepare('INSERT INTO ui_receipts VALUES (?,?,?,?)').run(auth.clientId, request.requestId, hash, canonical(receipt));
                this.barrier('ui-before-commit');
                this.db.exec('COMMIT');
                this.barrier('ui-after-commit');
                return receipt;
            }
            catch (e) {
                if (this.db.isTransaction)
                    this.db.exec('ROLLBACK');
                throw e;
            }
        }
        finally {
            for (const p of extra)
                this.objects.releaseProof(p.proof);
            if (proof)
                this.objects.releaseProof(proof);
            this.objects.release(slot);
        }
    }
}
