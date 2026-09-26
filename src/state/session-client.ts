import { createValueModel } from '@en-reve/primitives/state/value.js';
import type { SessionView, CapabilitiesView, LocalError } from '../protocol/session.js';

export type Connection = 'checking' | 'paired' | 'unpaired' | 'offline' | 'error';
export type SessionState = {
  connection: Connection; busy: boolean; message: string;
  capabilities: CapabilitiesView | null; expiresAt: string | null;
};
class RequestError extends Error {
  constructor(readonly code: string) { super(code); }
}
export function createSessionClient() {
  // Neither cookie nor CSRF is projected into a view, DOM, URL or storage.
  let session: SessionView | null = null;
  let active: AbortController | undefined;
  let generation = 0;
  const state = createValueModel<SessionState>({ connection: 'checking', busy: false, message: 'Checking local connection…', capabilities: null, expiresAt: null });
  const set = (patch: Partial<SessionState>) => state.set({ ...state.value.get(), ...patch });
  async function request<T>(path: string, body?: object): Promise<T> {
    const headers: Record<string, string> = body ? { 'Content-Type': 'application/json' } : { 'X-App-Client': 'LP-1' };
    if (body && path !== 'session/bootstrap' && session) headers['X-App-CSRF'] = session.csrfToken;
    const response = await fetch(`/api/v1/${path}`, {
      method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {}),
      credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: active ? AbortSignal.any([active.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const error = await response.json() as LocalError;
      throw new RequestError(error?.error?.code ?? 'INVALID_RESPONSE');
    }
    return response.status === 204 ? undefined as T : await response.json() as T;
  }
  async function run(action: 'resume' | 'bootstrap' | 'renew' | 'revoke', token?: string) {
    if (state.value.get().busy) return;
    const own = ++generation;
    active = new AbortController();
    set({ busy: true, message: action === 'renew' ? 'Renewing local connection…' : action === 'revoke' ? 'Disconnecting…' : 'Checking local connection…' });
    try {
      const result = action === 'resume' ? await request<SessionView>('session') : await request<SessionView>(`session/${action}`, action === 'bootstrap' ? { protocolVersion: 1, pairingToken: token } : { protocolVersion: 1 });
      token = undefined;
      if (own !== generation) return;
      if (action === 'revoke') {
        session = null;
        set({ connection: 'unpaired', capabilities: null, expiresAt: null, message: 'Disconnected. Type pair in the launcher terminal to open a fresh connection.' });
      } else {
        session = result;
        const capabilities = await request<CapabilitiesView>('capabilities');
        if (own !== generation) return;
        set({ connection: 'paired', capabilities, expiresAt: result.sessionExpiresAt, message: 'Connected to your local workspace.' });
      }
    } catch (error) {
      if (own !== generation) return;
      session = null;
      const code = error instanceof RequestError ? error.code : 'NETWORK';
      const unpaired = ['SESSION_REQUIRED', 'PAIRING_INVALID', 'CSRF_DENIED'].includes(code);
      set({ connection: unpaired ? 'unpaired' : code === 'NETWORK' ? 'offline' : 'error', capabilities: null, expiresAt: null,
        message: unpaired ? 'Connection expired or unavailable. Type pair in the launcher terminal for a fresh link.' : code === 'NETWORK' ? 'The local server is unreachable. Start the launcher, then check the connection. Your draft is still in this tab.' : 'The local server could not complete this request. Check the connection or restart the launcher.' });
      // A lost mutation response is never retried. An explicit check reads the
      // current cookie/session before any later renew or revoke is offered.
    } finally {
      token = undefined;
      if (own === generation) set({ busy: false });
    }
  }
  return {
    state,
    start: (token?: string) => run(token ? 'bootstrap' : 'resume', token),
    resume: () => run('resume'), renew: () => run('renew'), revoke: () => run('revoke'),
    dispose() { generation++; active?.abort(); session = null; },
  };
}
