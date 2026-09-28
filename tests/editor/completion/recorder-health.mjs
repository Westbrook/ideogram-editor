import assert from 'node:assert/strict';

// Samples come from the owning child, never from a previously saved epoch.
export function recorderHealth({recorder,instance,ownsRecorder,ownsDispatch}) {
  let uninstalled=false;
  return {
    removed(){uninstalled=true;},
    snapshot(phase='live') {
      return structuredClone({...recorder.state,phase,instance,
        installed:!uninstalled&&ownsRecorder(),originalInstallation:recorder.state.installed,
        dispatchOwned:!uninstalled&&ownsDispatch(),uninstalled,
        rowCount:recorder.rows.length,lastSequence:recorder.rows.at(-1)?.sequence??0});
    },
  };
}
export function validateRecorder(sample,{pid,instance,rows,final}) {
  assert(sample,'Actual recorder health required');
  assert.equal(sample.pid,pid);assert.equal(sample.instance,instance);
  assert.deepEqual(sample.failures,[],'Recorder observation failures are permanent');
  assert.equal(sample.originalInstallation,true);
  assert.equal(sample.rowCount,rows.length,'Recorder and retained ledger must include every observation');
  assert.equal(sample.lastSequence,rows.at(-1)?.sequence??0);
  assert.equal(sample.requests,rows.filter(r=>r.kind==='request').length);
  if(final){assert.equal(sample.phase,'closed');assert.equal(sample.installed,false);assert.equal(sample.active,false);assert.equal(sample.uninstalled,true);assert.equal(sample.dispatchOwned,false);}
  else {assert.equal(sample.phase,'live');assert.equal(sample.installed,true);assert.equal(sample.active,true);assert.equal(sample.dispatchOwned,true);assert.equal(sample.uninstalled,false);}
  return sample;
}
export function retainedRecorder(server,rows) {
  const end=server.shutdown,final=end?.reply?.recorder;
  assert(end?.exit,'Actual owned process exit required');assert(final,'Final recorder close reply required');
  assert.equal(end.reply.type,'completion-closed');assert.equal(end.reply.cleanupOnly,false);
  assert.deepEqual(end.errors,[]);assert.deepEqual(end.reply.failures,[]);
  const owner={pid:server.pid,instance:server.instance};
  if(end.mode==='restart'){
    assert.equal(end.exit.signal,'SIGKILL');assert.equal(final.kind,'abrupt');
    assert.equal(end.reply.serverClosed,false);assert.equal(final.after,undefined);
    return validateRecorder(final.before,{...owner,rows});
  }
  assert.equal(end.exit.code,0);assert.equal(end.exit.signal,null);
  assert.equal(final.kind,'graceful');assert.equal(end.reply.serverClosed,true);
  // The final installed sample precedes only its own uninstall ledger row.
  validateRecorder(final.before,{...owner,rows:rows.slice(0,final.before.rowCount)});
  assert.equal(final.after.rowCount,final.before.rowCount+1);
  assert.equal(rows.at(-1)?.kind,'recorder-uninstall');assert.equal(rows.at(-1)?.restoredOriginal,true);
  validateRecorder(final.after,{...owner,rows,final:true});
  return final.before;
}
