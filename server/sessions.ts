import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { SessionView } from '../src/protocol/session.js';
import { ProtocolError } from './errors.js';

export const PAIRING_MS = 5 * 60 * 1000;
export const ABSOLUTE_MS = 12 * 60 * 60 * 1000;
export const IDLE_MS = 30 * 60 * 1000;
export const COOKIE_NAME = 'ie_session';
const secret = () => randomBytes(32).toString('base64url');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
type Session = { cookieHash: string; csrf: string; clientId: string; expires: number; idle: number };

export class Sessions {
  readonly #now: () => number;
  readonly #sessions = new Map<string, Session>();
  #pairing: { hash: string; expires: number } | undefined;
  constructor(now: () => number) { this.#now = now; }
  issuePairing(): string {
    const token = secret();
    this.#pairing = { hash: digest(token), expires: this.#now() + PAIRING_MS };
    return token;
  }
  bootstrap(token: string, oldCookie: string | undefined): { cookie: string; view: SessionView } {
    const pairing = this.#pairing;
    if (!pairing || this.#now() >= pairing.expires || !timingSafeEqual(Buffer.from(pairing.hash), Buffer.from(digest(token)))) {
      throw new ProtocolError('PAIRING_INVALID');
    }
    // No await between comparison, consumption, and credential creation.
    this.#pairing = undefined;
    if (oldCookie) this.#sessions.delete(digest(oldCookie));
    return this.#create(randomUUID(), this.#now() + ABSOLUTE_MS);
  }
  authenticate(cookie: string | undefined, csrf?: string): Session {
    this.#prune();
    const session = cookie && this.#sessions.get(digest(cookie));
    if (!session) throw new ProtocolError('SESSION_REQUIRED');
    if (csrf !== undefined && (!/^[A-Za-z0-9_-]{43}$/.test(csrf) ||
        !timingSafeEqual(Buffer.from(csrf), Buffer.from(session.csrf)))) throw new ProtocolError('CSRF_DENIED');
    return session;
  }
  view(session: Session): SessionView {
    session.idle = Math.min(this.#now() + IDLE_MS, session.expires);
    return { protocolVersion: 1, csrfToken: session.csrf, clientId: session.clientId,
      sessionExpiresAt: new Date(session.expires).toISOString(), idleExpiresAt: new Date(session.idle).toISOString() };
  }
  renew(session: Session): { cookie: string; view: SessionView } {
    this.#sessions.delete(session.cookieHash);
    return this.#create(session.clientId, session.expires);
  }
  revoke(session: Session): void { this.#sessions.delete(session.cookieHash); }
  invalidate(): void { this.#sessions.clear(); this.#pairing = undefined; }
  #create(clientId: string, expires: number): { cookie: string; view: SessionView } {
    this.#prune();
    const cookie = secret();
    const session = { cookieHash: digest(cookie), csrf: secret(), clientId, expires, idle: 0 };
    this.#sessions.set(session.cookieHash, session);
    return { cookie, view: this.view(session) };
  }
  #prune(): void {
    const now = this.#now();
    for (const [key, session] of this.#sessions) if (now >= session.expires || now >= session.idle) this.#sessions.delete(key);
  }
}

export function readCookie(header: string | undefined): string | undefined {
  const values = (header ?? '').split(';').map(value => value.trim()).filter(value => value.split('=')[0] === COOKIE_NAME);
  if (!values.length) return undefined;
  if (values.length !== 1 || !new RegExp(`^${COOKIE_NAME}=[A-Za-z0-9_-]{43}$`).test(values[0])) throw new ProtocolError('SESSION_REQUIRED');
  return values[0].slice(COOKIE_NAME.length + 1);
}
export const sessionCookie = (value: string): string => `${COOKIE_NAME}=${value}; HttpOnly; SameSite=Strict; Path=/`;
export const expiredCookie = `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
