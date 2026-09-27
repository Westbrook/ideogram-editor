import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { ProtocolError } from './errors.js';
export const PAIRING_MS = 5 * 60 * 1000;
export const ABSOLUTE_MS = 12 * 60 * 60 * 1000;
export const IDLE_MS = 30 * 60 * 1000;
export const COOKIE_NAME = 'ie_session';
const secret = () => randomBytes(32).toString('base64url');
export const cookieDigest = (value) => createHash('sha256').update(value).digest('hex');
export class Sessions {
    #now;
    #sessions = new Map();
    #pairing;
    constructor(now) { this.#now = now; }
    issuePairing() {
        const token = secret();
        this.#pairing = { hash: cookieDigest(token), expires: this.#now() + PAIRING_MS };
        return token;
    }
    bootstrap(token, oldCookie, restoredClientId) {
        const pairing = this.#pairing;
        if (!pairing || this.#now() >= pairing.expires || !timingSafeEqual(Buffer.from(pairing.hash), Buffer.from(cookieDigest(token)))) {
            throw new ProtocolError('PAIRING_INVALID');
        }
        // No await between comparison, consumption, and credential creation.
        this.#pairing = undefined;
        if (oldCookie)
            this.#sessions.delete(cookieDigest(oldCookie));
        return this.#create(restoredClientId ?? randomUUID(), this.#now() + ABSOLUTE_MS);
    }
    authenticate(cookie, csrf) {
        this.#prune();
        const session = cookie && this.#sessions.get(cookieDigest(cookie));
        if (!session)
            throw new ProtocolError('SESSION_REQUIRED');
        if (csrf !== undefined && (!/^[A-Za-z0-9_-]{43}$/.test(csrf) ||
            !timingSafeEqual(Buffer.from(csrf), Buffer.from(session.csrf))))
            throw new ProtocolError('CSRF_DENIED');
        return session;
    }
    view(session) {
        session.idle = Math.min(this.#now() + IDLE_MS, session.expires);
        return { protocolVersion: 1, csrfToken: session.csrf, clientId: session.clientId,
            sessionExpiresAt: new Date(session.expires).toISOString(), idleExpiresAt: new Date(session.idle).toISOString() };
    }
    renew(session) {
        this.#sessions.delete(session.cookieHash);
        return this.#create(session.clientId, session.expires);
    }
    revoke(session) { this.#sessions.delete(session.cookieHash); }
    invalidate() { this.#sessions.clear(); this.#pairing = undefined; }
    #create(clientId, expires) {
        this.#prune();
        const cookie = secret();
        const session = { cookieHash: cookieDigest(cookie), csrf: secret(), clientId, expires, idle: 0 };
        this.#sessions.set(session.cookieHash, session);
        return { cookie, view: this.view(session) };
    }
    #prune() {
        const now = this.#now();
        for (const [key, session] of this.#sessions)
            if (now >= session.expires || now >= session.idle)
                this.#sessions.delete(key);
    }
}
export function readCookie(header) {
    const values = (header ?? '').split(';').map(value => value.trim()).filter(value => value.split('=')[0] === COOKIE_NAME);
    if (!values.length)
        return undefined;
    if (values.length !== 1 || !new RegExp(`^${COOKIE_NAME}=[A-Za-z0-9_-]{43}$`).test(values[0]))
        throw new ProtocolError('SESSION_REQUIRED');
    return values[0].slice(COOKIE_NAME.length + 1);
}
export const sessionCookie = (value) => `${COOKIE_NAME}=${value}; HttpOnly; SameSite=Strict; Path=/`;
export const expiredCookie = `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
