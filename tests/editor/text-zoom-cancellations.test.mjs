import test from 'node:test';
import assert from 'node:assert/strict';
import {expectedResponseCancellation as accepted} from './text-zoom-cancellations.mjs';
const origin='http://127.0.0.1:54321',path='/api/v1/assets/12345678-1234-1234-1234-123456789abc/content';
const event=(method,url,type)=>({channel:'requestfailed',requestId:7,url:origin+url,method,resourceType:'fetch',failure:{errorText:'net::ERR_ABORTED'},response:{requestId:7,url:origin+url,method,status:200,contentType:type,etag:'"sha256:'+'a'.repeat(64)+'"'}});
test('bodyless font HEAD cancellation requires the same successful request and exact response identity',()=>{
 const e=event('HEAD',path,'application/octet-stream');assert.equal(accepted(e,origin),true);
 for(const edit of [x=>x.failure.errorText='net::ERR_FAILED',x=>x.resourceType='image',x=>x.response.requestId++,x=>x.response.url+='x',x=>x.response.method='GET',x=>x.response.status=503,x=>x.response.contentType='application/json',x=>x.response.etag='',x=>x.url='http://127.0.0.1:54322'+path]){const bad=structuredClone(e);edit(bad);assert.equal(accepted(bad,origin),false,JSON.stringify(bad));}
 assert.equal(accepted(e,'http://127.0.0.1:54322'),false);
});
test('streamed static font cancellation additionally requires exact owned-path full-byte HTTP proof',()=>{
 const e=event('GET','/assets/pinned-font.ttf','font/ttf');e.response.contentLength='1024';
 const proof={path:'/assets/pinned-font.ttf',bytes:1024,sha256:'a'.repeat(64),method:'Independent APIRequestContext GET of exact owned static font path; browser streamed body unavailable to DevTools'};
 assert.equal(accepted(e,origin,[proof]),true);assert.equal(accepted(e,origin),false);
 for(const patch of [{path:'/assets/other-font.ttf'},{bytes:1023},{sha256:''},{method:'Unverified browser response'}])assert.equal(accepted(e,origin,[{...proof,...patch}]),false);
 for(const edit of [x=>x.response.status=500,x=>x.response.contentType='application/octet-stream',x=>x.response.requestId++,x=>x.failure.errorText='net::ERR_FAILED']){const bad=structuredClone(e);edit(bad);assert.equal(accepted(bad,origin,[proof]),false);}
});
