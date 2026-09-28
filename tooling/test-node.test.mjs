import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { commandsFor, runSuites, suites } from './test-node.mjs';

const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('all and selected suites preserve the actual guard commands in gate order', () => {
  assert.deepEqual(commandsFor(scripts, []).map(x => x.name), suites);
  const selected = commandsFor(scripts, ['store', 'session', 'store']);
  assert.deepEqual(selected.map(x => x.name), ['session', 'store']);
  for (const { name, command } of commandsFor(scripts, [])) {
    assert.equal(`npm run build:server && ${command}`, scripts[`test:${name}`]);
    assert.match(command, /--import .*no-(?:egress|network)\.mjs --test --test-concurrency=1/);
  }
});

test('invalid selection or changed script shape fails before any build', () => {
  const unexpected = () => assert.fail('No command may start');
  assert.throws(() => runSuites(scripts, ['session', 'unknown'], unexpected), /Unknown Node suite/);
  assert.throws(() => runSuites({ ...scripts, 'test:store': 'node changed.mjs' }, [], unexpected), /test:store must start/);
});

test('build and suite failures stop later gates and preserve the failure status', () => {
  for (const [failure, expected] of [['build:server', ['build:server']], ['test:store', ['build:server', 'test:session', 'test:store']]]) {
    const calls = [];
    assert.equal(runSuites(scripts, [], name => { calls.push(name); return name === failure ? 7 : 0; }), 7);
    assert.deepEqual(calls, expected);
  }
});

test('real CLI builds once per invocation, expands the original body, and forwards failure', t => {
  const root = mkdtempSync(join(tmpdir(), 'ideogram-runner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'record.mjs'), "import{appendFileSync}from'node:fs';appendFileSync('calls.txt',process.argv[2]+'\\n');if(process.argv[2]===process.env.FAIL_GATE)process.exit(9);");
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: {
    'build:server': 'node record.mjs build',
    ...Object.fromEntries(suites.map(name => [`test:${name}`, `npm run build:server && node record.mjs ${name}`])),
  } }));
  const runner = fileURLToPath(new URL('./test-node.mjs', import.meta.url));
  const run = (args, extra = {}) => spawnSync(process.execPath, [runner, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, ...extra } });
  const first = run(['store', 'session']);
  assert.equal(first.status, 0, first.stderr + first.stdout);
  assert.equal(readFileSync(join(root, 'calls.txt'), 'utf8'), 'build\nsession\nstore\n');
  const second = run(['protocol'], { FAIL_GATE: 'protocol' });
  assert.equal(second.status, 9, second.stderr + second.stdout);
  assert.equal(readFileSync(join(root, 'calls.txt'), 'utf8'), 'build\nsession\nstore\nbuild\nprotocol\n');
  assert.equal(run(['unknown']).status, 1);
  assert.equal(readFileSync(join(root, 'calls.txt'), 'utf8'), 'build\nsession\nstore\nbuild\nprotocol\n');
});
