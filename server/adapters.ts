import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Session } from './sessions.js';
import type { Writer } from './storage/writer.js';
import type { AdapterLibraryFilters } from '../src/protocol/adapters.js';
import { isId } from './storage/canonical.js';
import { ProtocolError } from './errors.js';
import { sendJSON } from './protocol.js';
export type AdapterRoute = { allow: string[]; kind: string; id?: string; query: string[] };
export class AdapterRoutes {
  constructor(private writer: Writer, private now:()=>number=Date.now) {}
  match(path: string): AdapterRoute | null {
    if (path === '/api/v1/adapters') return { allow: ['GET'], kind: 'adapter-list', query: ['after', 'search', 'family', 'format', 'origin', 'status'] };
    const review = /^\/api\/v1\/adapters\/deletion-reviews\/([^/]+)$/.exec(path);
    if(review){if(!isId(review[1]))throw new ProtocolError('MALFORMED_REQUEST');return {allow:['GET'],kind:'adapter-deletion-review',id:review[1],query:[]};}
    const updates = /^\/api\/v1\/adapters\/([^/]+)\/updates$/.exec(path);
    if(updates){if(!isId(updates[1]))throw new ProtocolError('MALFORMED_REQUEST');return {allow:['GET'],kind:'adapter-updates',id:updates[1],query:[]};}
    const match = /^\/api\/v1\/adapters\/([^/]+)$/.exec(path);
    if (!match) return null;
    if (!isId(match[1])) throw new ProtocolError('MALFORMED_REQUEST');
    return { allow: ['GET'], kind: 'adapter-view', id: match[1], query: [] };
  }
  async handle(_req: IncomingMessage, res: ServerResponse, route: AdapterRoute, params: URLSearchParams, authenticate: () => Session, _assertRoot: () => Promise<void>) {
    authenticate(); let result;
    if (route.kind === 'adapter-list') {
      const filters: AdapterLibraryFilters = {};
      for (const key of ['family', 'format', 'origin', 'status'] as const) { const value = params.get(key); if (value !== null) filters[key] = value; }
      result = await this.writer.adapterList(params.get('after') ?? '', params.get('search') ?? '', filters);
    } else if(route.kind==='adapter-deletion-review'){const session=authenticate();result=await this.writer.adapterDeletionReview(route.id!,{clientId:session.clientId,sessionHash:session.cookieHash,expires:Math.min(session.expires,session.idle),now:this.now()});}
    else if(route.kind==='adapter-updates')result=await this.writer.adapterUpdates(route.id!);
    else result = await this.writer.adapterView(route.id!);
    authenticate(); sendJSON(res, 200, result);
  }
}
