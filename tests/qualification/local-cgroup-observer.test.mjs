import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const fixture = fileURLToPath(new URL('./fixtures/local-cgroup-observer-unit.py', import.meta.url));
const worker = fileURLToPath(new URL('../../tooling/rollback-producer/local-cgroup-observer.py', import.meta.url));
for (const group of ['parsers', 'credentials', 'observation', 'drift', 'bounds', 'diagnostics', 'group-authority']) {
  test(`local cgroup observer: ${group} read-only kernel controls`, async () => {
    const {stdout, stderr} = await promisify(execFile)('python3', ['-I', '-S', '-B', fixture, worker, group],
      {timeout: 10000, maxBuffer: 131072});
    assert.equal(stderr, '');
    const result = JSON.parse(stdout);
    assert.equal(result.group, group);
    assert.equal(result.status, 'PASS');
    assert.ok(result.cases >= 5);
    assert.equal(result.kernelExecuted, false);
  });
}
