import test from 'node:test';
import assert from 'node:assert/strict';
import {historyBody} from '../../dist/local/src/protocol/history-validation.js';

const placement=()=>({
  type:'ReviewCandidatePlacement',candidateId:'candidate_1',mode:'safe-region',
  placement:'current-document',newDocumentId:null,actualOutput:null,
  newLayerId:'encoded_output',name:'Encoded rebuild',
});

test('candidate placement review accepts an explicit encoded rebuild preparation without changing the command',()=>{
  const command={...placement(),preparation:'encoded-rebuild'},before=structuredClone(command);
  assert.doesNotThrow(()=>historyBody(command));
  assert.deepEqual(command,before,'Validation must retain the explicit choice for the review command');
  assert.doesNotThrow(()=>historyBody(placement()),'Existing reviews remain valid without a preparation choice');
  assert.doesNotThrow(()=>historyBody({...command,placement:'new-document',newDocumentId:'encoded_document'}));
});

test('encoded rebuild preparation is exact and cannot be supplied to older preparation or acceptance commands',()=>{
  for(const preparation of [undefined,null,false,0,'','deferred','prepared-reuse','encoded-rebuild-2',{},[]]){
    assert.throws(()=>historyBody({...placement(),preparation}),JSON.stringify({preparation}));
  }
  assert.throws(()=>historyBody({...placement(),type:'PrepareCandidateAdoption',preparation:'encoded-rebuild'}));
  assert.doesNotThrow(()=>historyBody({...placement(),type:'PrepareCandidateAdoption'}));
  assert.throws(()=>historyBody({type:'AdoptReviewedCandidate',reviewId:'review_1',reviewHash:'sha256:'+'1'.repeat(64),draft:null,preparation:'encoded-rebuild'}));
  assert.throws(()=>historyBody({...placement(),preparaton:'encoded-rebuild'}),'Unknown or misspelled fields must not silently select a preparation path');
});
