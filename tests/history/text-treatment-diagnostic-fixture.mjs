// Preserve the exact request-edit observer; add only explicit failure snapshots.
import {setup as setupObserver} from '../request-edits/observer-fixture.mjs';
import {installFailureDiagnostics} from './returned-description-observer-fixture.mjs';
export async function setup(store){const closeObserver=await setupObserver(store),stopDiagnostics=installFailureDiagnostics(store);return async()=>{stopDiagnostics();await closeObserver();};}
