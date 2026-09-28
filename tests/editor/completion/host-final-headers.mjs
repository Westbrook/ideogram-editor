import assert from 'node:assert/strict';

export function normalizedHeaders(value) {
 assert(value&&typeof value==='object'&&!Array.isArray(value));const out={};
 for(const [name,value2]of Object.entries(value)){const key=name.toLowerCase();assert(!(key in out),'Ambiguous header name');assert(typeof value2==='string'||typeof value2==='number'||Array.isArray(value2)&&value2.every(v=>typeof v==='string'),'Original header value');out[key]=Array.isArray(value2)?value2.join('\n'):String(value2);}
 return out;
}

// The pinned private receiver uses exactly one direct writeHead, with no
// progressive header API. Node keeps those arguments separate from getHeaders.
// Other call shapes are refused, not guessed from a later drain snapshot.
export function privateDeclaredHeaders({request,rows,status}) {
 const own=rows.filter(r=>r.id===request.id||r.url===request.url||r.path===request.path),allowed=new Set(['request','header-call','header-return','response','response-close']);
 let previous=-1;for(const row of own){assert(allowed.has(row.kind),'Unexplained private response operation');assert(Number.isSafeInteger(row.sequence)&&row.sequence>previous,'Original private operation order');previous=row.sequence;
  for(const key of ['id','pid','serverId','method','url','path'])assert.equal(row[key],request[key],'Original header operation owner '+key);
  assert(row.requestObject&&row.responseObject&&row.responseRequestSame,'Original header request/response objects');
 }
 assert.equal(own.length,5,'Complete fixed private response operation sequence');assert.deepEqual(own.map(r=>r.kind),['request','header-call','header-return','response','response-close']);
 const [,call,returned,response,closed]=own;assert.equal(call.name,'writeHead');assert.equal(returned.name,call.name);assert(call.sameResponseObject&&returned.sameResponseObject);assert.equal(call.statusBefore,200);assert.equal(returned.returnIsResponse,true);assert.equal(returned.returnType,'object');assert.equal(returned.headersSent,true);
 assert(Array.isArray(call.args)&&call.args.length>=1&&call.args.length<=2);assert.equal(call.args[0],status);const declared=call.args.length===1?{}:normalizedHeaders(call.args[1]);privateFraming(declared,status);
 // No kOutHeaders map exists on this receiver path: direct arguments do not
// populate it. Keep the actual empty snapshots rather than replacing them.
 for(const row of [returned,response,closed]){assert.equal(row.status,status);assert.deepEqual(row.headers,{},'Direct writeHead getHeaders snapshot');}
 assert(response.headersSent&&response.writableFinished&&response.originalObjects);assert(closed.writableFinished&&closed.originalObjects);
 return {declared,call:structuredClone(call),returned:structuredClone(returned),drains:structuredClone([response,closed]),getHeaders:structuredClone(returned.headers),semantics:'Pinned private receiver direct writeHead; no progressive header operations'};
}

export function privateFraming(headers,status) {
 assert([200,204].includes(status),'Pinned private response status');
 if('content-length' in headers)assert(/^(?:0|[1-9][0-9]*)$/.test(headers['content-length']));
 if('transfer-encoding' in headers){assert.equal(headers['transfer-encoding'],'chunked');assert(!('content-length' in headers),'Contradictory private transfer framing');}
 if(status===204){assert(!('transfer-encoding' in headers),'Bodyless204 transfer framing');assert(!('content-length' in headers),'Bodyless204 content length');}
 if('keep-alive' in headers&&'connection' in headers)assert.equal(headers.connection,'keep-alive','Private connection framing');
 return headers;
}
