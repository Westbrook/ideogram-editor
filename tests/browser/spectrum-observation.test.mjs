import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sanitizedLocation,sanitizedText} from './spectrum-observation.ts';
test('correlation retains controlled path while discarding credentials, query and fragment',()=>{
 assert.deepEqual(sanitizedLocation('http://user:secret@127.0.0.1:1234/api/v1/ui/id?token=secret#pairing=secret'),{origin:'http://127.0.0.1:1234',path:'/api/v1/ui/id'});
 assert.equal(sanitizedText('Fetch http://user:secret@127.0.0.1:1234/api/v1/ui/id?token=secret#pairing=secret failed'),'Fetch http://127.0.0.1:1234/api/v1/ui/id failed');
});
test('malformed locations fail closed without copying input',()=>assert.deepEqual(sanitizedLocation('secret'),{origin:'unavailable',path:'unavailable'}));
