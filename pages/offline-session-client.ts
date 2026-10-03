import { createValueModel } from '@en-reve/primitives/state/value.js';
import type { createSessionClient as createLocalSessionClient, SessionState } from '../src/state/session-client.js';
export type { Connection, SessionState } from '../src/state/session-client.js';

type SessionClient = ReturnType<typeof createLocalSessionClient>;
const message = 'Offline public preview. Run the local editor to open documents, save work or use a provider.';

// Pages replaces only the production session module. No token, cookie, storage,
// transport or reconnect task is consulted or created by this implementation.
export function createSessionClient(): SessionClient {
  const snapshot = (): SessionState => ({ connection: 'offline', busy: false, message, capabilities: null, expiresAt: null });
  const state = createValueModel<SessionState>(snapshot());
  const remainOffline = async () => { state.set(snapshot()); };
  return {
    state,
    identity: () => null,
    csrf: () => '',
    transport: async (_path: string, _init?: RequestInit): Promise<Response> => { throw Error('PAGES_OFFLINE'); },
    start: async (_token?: string) => { await remainOffline(); },
    resume: remainOffline, renew: remainOffline, revoke: remainOffline,
    renderCapabilities(value) { if (value) throw Error('SESSION_CAPABILITIES_UNOWNED'); return []; },
    get ownership() { return { controlReads: 0, controlCleanupFailures: 0, sessionModels: 0 }; },
    release: async () => {},
    dispose: remainOffline,
  };
}
