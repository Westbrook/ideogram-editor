import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, symlink, readdir, realpath, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {budgetVerdict, budgets, applyEdit, editScopes, withTemporaryEdit, snapshotSource, runCommand, developerPlan, isBuildSource} from '../../tooling/qualification/dev.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function workspace(t) {
  const path = await mkdtemp(join(await realpath(tmpdir()), 'developer-campaign-test-'));
  t.after(() => rm(path, {recursive: true, force: true}));
  return path;
}
test('PERF D03/D04 ceiling equality is admissible; command errors cannot look fast', () => {
  assert.deepEqual(budgets.coldBuild, {row: 'D03', targetMs: 30000, ceilingMs: 60000});
  assert.deepEqual(budgets.fullTypes, {row: 'D04', targetMs: 10000, ceilingMs: 20000});
  assert.deepEqual(budgets.incrementalBuild, {row: 'D04', targetMs: 2000, ceilingMs: 5000});
  assert.deepEqual(budgets.incrementalTypes, {row: 'D04', targetMs: 1000, ceilingMs: 3000});
  for (const budget of Object.values(budgets)) {
    assert.equal(budgetVerdict(budget.targetMs, true, budget), 'target');
    assert.equal(budgetVerdict(budget.ceilingMs, true, budget), 'ceiling');
    assert.equal(budgetVerdict(budget.ceilingMs + 0.01, true, budget), 'cap-exceeded');
    assert.equal(budgetVerdict(0, false, budget), 'command-failed');
  }
  assert.throws(() => budgetVerdict(NaN, true, budgets.fullTypes));
});
test('fixed leaf and domain edits change selected source, with drift or duplicate anchors rejected', () => {
  for (const scope of editScopes) {
    const original = `// before\n${scope.before}\n// after\n`;
    assert.equal(applyEdit(original, scope), `// before\n${scope.after}\n// after\n`);
    assert.throws(() => applyEdit('// changed source', scope), /exactly once/);
    assert.throws(() => applyEdit(original + original, scope), /exactly once/);
  }
});
test('failed edited command restores exact original bytes before restoration build callback', async t => {
  const work = await workspace(t), path = join(work, 'scope.ts'), scope = editScopes[0];
  const original = Buffer.from(`// keep exact CRLF\r\n${scope.before}\r\n`);
  await writeFile(path, original); let restored;
  await assert.rejects(withTemporaryEdit(path, scope, async record => {
    assert.notEqual(hash(await readFile(path)), record.original);
    throw new Error('Compiler failure');
  }, async record => {
    restored = record;
    assert.deepEqual(await readFile(path), original);
  }), /Compiler failure/);
  assert.equal(restored.restored, true); assert.equal(restored.original, hash(original));
  assert.deepEqual(await readFile(path), original);
});
test('snapshot captures independent bytes and refuses linked or escaping source paths', async t => {
  const work = await workspace(t), source = join(work, 'source'), snapshot = join(work, 'snapshot');
  await mkdir(join(source, 'src'), {recursive: true}); await mkdir(snapshot);
  await writeFile(join(source, 'src/a.ts'), 'export const a = 1;\n');
  const receipt = await snapshotSource(source, snapshot, ['src/a.ts']);
  assert.equal(receipt.files[0].sha256, hash('export const a = 1;\n'));
  assert.equal(await readFile(join(snapshot, 'src/a.ts'), 'utf8'), 'export const a = 1;\n');
  await writeFile(join(snapshot, 'src/a.ts'), 'changed only in snapshot');
  assert.equal(await readFile(join(source, 'src/a.ts'), 'utf8'), 'export const a = 1;\n');
  assert.notEqual((await stat(join(source, 'src/a.ts'))).ino, (await stat(join(snapshot, 'src/a.ts'))).ino);
  await assert.rejects(snapshotSource(source, snapshot, ['src/a.ts']), /must be empty/);
  const empty = join(work, 'empty'); await mkdir(empty);
  await assert.rejects(snapshotSource(source, empty, ['../source/src/a.ts']), /Unsafe source path/);
  await symlink(join(source, 'src/a.ts'), join(source, 'linked.ts'));
  await assert.rejects(snapshotSource(source, empty, ['linked.ts']), /links are not permitted/);
  const inside = join(source, 'internal'); await mkdir(inside);
  await assert.rejects(snapshotSource(source, inside, ['src/a.ts']), /outside the live source/);
});
test('build graph selection excludes private/runtime outputs and retains all required config/vendor files', () => {
  for (const path of ['src/new.ts', 'server/writer.ts', 'tests/fixture/input.png', 'tooling/new.mjs', 'vendor/text/engine.wasm', '.progress-report/project.json', 'package-lock.json', 'vite.app.config.ts', 'tsconfig.app.json']) assert.equal(isBuildSource(path), true, path);
  for (const path of ['.env', '.intent/private.md', 'node_modules/typescript/bin/tsc', 'artifacts/run.json', 'dist/app/index.html', '.toolchain/bin/node']) assert.equal(isBuildSource(path), false, path);
});
test('real command receipts retain raw stdout/stderr hashes, exact argv, exit and monotonic duration', async t => {
  const work = await workspace(t);
  const args = ['--input-type=module', '-e', "console.log('exact output'); console.error('diagnostic'); process.exitCode = 7;"];
  const receipt = await runCommand({executable: process.execPath, args, cwd: work, env: {}, logDirectory: join(work, 'logs'), id: 'failed-compiler'});
  assert.equal(receipt.exitCode, 7); assert.equal(receipt.signal, null); assert.equal(receipt.timedOut, false);
  assert.deepEqual(receipt.args, args); assert.ok(receipt.elapsedMs > 0);
  assert.equal(receipt.stdout.sha256, hash('exact output\n')); assert.equal(receipt.stderr.sha256, hash('diagnostic\n'));
  assert.equal(await readFile(receipt.stdout.path, 'utf8'), 'exact output\n');
  assert.equal(await readFile(receipt.stderr.path, 'utf8'), 'diagnostic\n');
  await assert.rejects(runCommand({executable: process.execPath, args, cwd: work, env: {}, logDirectory: join(work, 'logs'), id: 'failed-compiler'}), /EEXIST/);
});
test('spawn failure produces a failed receipt instead of an apparent zero duration pass', async t => {
  const work = await workspace(t);
  const receipt = await runCommand({executable: join(work, 'missing-executable'), args: [], cwd: work, env: {}, logDirectory: join(work, 'logs'), id: 'missing'});
  assert.notEqual(receipt.exitCode, 0); assert.match(receipt.error, /ENOENT/); assert.equal(receipt.timedOut, false);
});
test('command timeout is retained and stops its owned child process group', {skip: process.platform === 'win32'}, async t => {
  const work = await workspace(t), sentinel = join(work, 'child-survived');
  const script = `import {spawn} from 'node:child_process'; spawn(process.execPath, ['--input-type=module','-e', ${JSON.stringify(`import {writeFileSync} from 'node:fs'; setTimeout(() => writeFileSync(${JSON.stringify(sentinel)}, 'bad'), 600);`)}], {stdio:'inherit'}); setTimeout(() => {}, 10000);`;
  const receipt = await runCommand({executable: process.execPath, args: ['--input-type=module', '-e', script], cwd: work, env: {}, logDirectory: join(work, 'logs'), id: 'timeout', timeoutMs: 150});
  assert.equal(receipt.timedOut, true); assert.equal(receipt.exitCode, null); assert.equal(receipt.signal, 'SIGKILL');
  await new Promise(resolve => setTimeout(resolve, 700));
  await assert.rejects(stat(sentinel), {code: 'ENOENT'});
});
test('default CLI only prints a plan and run without explicit isolated install exits before mutation', async t => {
  const work = await workspace(t), script = resolve('tooling/qualification/dev.mjs');
  const plan = spawnSync(process.execPath, [script], {cwd: work, encoding: 'utf8'});
  assert.equal(plan.status, 0, plan.stderr); assert.equal(JSON.parse(plan.stdout).mode, 'plan');
  assert.deepEqual(await readdir(work), []);
  const denied = spawnSync(process.execPath, [script, '--run'], {cwd: work, encoding: 'utf8'});
  assert.equal(denied.status, 1); assert.match(denied.stderr, /requires --install/);
  assert.deepEqual(await readdir(work), []);
  assert.ok(developerPlan().boundaries.some(value => /No I1/.test(value)));
  for (const campaign of ['I0', 'I1', 'I2']) {
    const result = spawnSync(process.execPath, [script, '--campaign', campaign, '--plan'], {cwd: work, encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).qualification, false);
  }
  assert.deepEqual(await readdir(work), []);
});
