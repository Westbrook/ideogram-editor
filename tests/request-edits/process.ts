import { fork } from 'node:child_process';
import { resolve } from 'node:path';
// @ts-ignore Shared owned process lifecycle, with retained failures and finite shutdown.
import { ownServerProcess } from '../editor/completion/owned-process.mjs';

export function serverProcess(root: string, resultSize: 256 | 512 = 512, pendingDiagnostics = false) {
  if (resultSize !== 256 && resultSize !== 512) throw Error('REQUEST_EDITS_FIXTURE_RESULT_SIZE');
  if (typeof pendingDiagnostics !== 'boolean') throw Error('REQUEST_EDITS_FIXTURE_DIAGNOSTICS');
  const child = fork(resolve('tests/request-edits/process-fixture.mjs'), [root, resolve('dist/app'), ...(pendingDiagnostics ? ['pending-diagnostics'] : [])], {
    execArgv: ['--import', resolve('tests/provider/no-egress.mjs')],
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, ...(resultSize === 512 ? {} : { IE_REQUEST_EDITS_RESULT_SIZE: '256' }) },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  return ownServerProcess(child, {});
}
