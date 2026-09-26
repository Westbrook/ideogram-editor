import test from 'node:test';
import assert from 'node:assert/strict';
import {expectedShutdownConsole} from './shutdown-console.ts';
const sample={browser:'webkit',text:'Failed to load resource: The network connection was lost.',url:'http://127.0.0.1:54321/api/v1/events/stream',disrupting:true,retiredOrigins:new Set(['http://127.0.0.1:54321'])};
test('intentional shutdown classification is bounded to the retired origin, event path, engine, message and outage',()=>{
 assert.equal(expectedShutdownConsole(sample),true);
 assert.equal(expectedShutdownConsole({...sample,text:'Failed to load resource: Could not connect to the server.',url:'http://127.0.0.1:54321/api/v1/events?after=1'}),true);
 assert.equal(expectedShutdownConsole({...sample,browser:'chromium',text:'Failed to load resource: net::ERR_CONNECTION_REFUSED'}),true);
 for(const change of [{disrupting:false},{retiredOrigins:new Set()},{url:'http://127.0.0.1:54322/api/v1/events'},{url:'https://example.com/api/v1/events'},{url:'http://127.0.0.1:54321/api/v1/commands'},{url:''},{text:'Unexpected application error'},{text:'Refused to load the script because it violates Content Security Policy'},{text:'TypeError: application failed'},{text:sample.text+' Additional error'},{browser:'firefox'},{browser:'chromium'}])assert.equal(expectedShutdownConsole({...sample,...change}),false,JSON.stringify(change));
});
