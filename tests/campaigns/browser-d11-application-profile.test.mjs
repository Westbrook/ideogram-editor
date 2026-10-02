import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { D11_APPLICATION_SOURCE_PATHS, verifyD11ApplicationProfile } from '../../tooling/qualification/campaigns/browser-d11-application-profile.mjs';

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const identity = (path, text) => ({ path, rawBytes: Buffer.byteLength(text), sha256: 'sha256:' + createHash('sha256').update(text).digest('hex') });
let retained;
async function specimen() {
  retained ??= (async () => {
    const sourceTextByPath = {};
    for (const path of D11_APPLICATION_SOURCE_PATHS) {
      const bytes = await readFile(join(repo, path));
      assert(bytes.length <= 16 * 1048576);
      const text = bytes.toString('utf8'); assert(Buffer.from(text).equals(bytes));
      sourceTextByPath[path] = text;
    }
    // Read the product bootstrap as source data, never by importing static.ts.
    const staticSource = await readFile(join(repo, 'server/static.ts'), 'utf8');
    const matches = [...staticSource.matchAll(/export const BOOTSTRAP_PRELUDE = `([^`]+)`;/g)];
    assert.equal(matches.length, 1); assert(!matches[0][1].includes('${'));
    const bootstrapText = matches[0][1];
    return { sourceTextByPath, sourceInputs: Object.entries(sourceTextByPath).map(([path, text]) => identity(path, text)), bootstrapText };
  })();
  return structuredClone(await retained);
}

test('the current reviewed application corpus and actual bootstrap require matching finalized inputs', async () => {
  const value = await specimen(), before = structuredClone(value);
  const proof = verifyD11ApplicationProfile(value);
  assert.equal(proof.kind, 'verified-d11-application-profile-1');
  assert.equal(proof.profile, 'reviewed-d11-startup-corpus-1');
  assert.equal(proof.inputs.length, D11_APPLICATION_SOURCE_PATHS.length + 1);
  assert.deepEqual(proof.inputs.find(input => input.path === 'inline:bootstrap'), identity('inline:bootstrap', value.bootstrapText));
  assert.deepEqual(verifyD11ApplicationProfile(value), proof);
  assert.deepEqual(value, before);
  assert(Object.isFrozen(D11_APPLICATION_SOURCE_PATHS));
});

test('changed sources cannot self-authorize by recomputing their receipt', async () => {
  for (const path of ['src/ui/native-text.ts', 'src/ui/shell.ts', 'src/ui/request.ts', 'src/ui/returned-description.ts', 'src/ui/command-search.ts', 'index.html']) {
    const value = await specimen(); value.sourceTextByPath[path] += '\n/* changed callback census */\n';
    value.sourceInputs[value.sourceInputs.findIndex(input => input.path === path)] = identity(path, value.sourceTextByPath[path]);
    assert.throws(() => verifyD11ApplicationProfile(value), /reviewed application source differs/);
  }
});

test('new, missing, aliased, and receipt-only application sources fail the exact inventory', async () => {
  for (const mutate of [
    value => { value.sourceTextByPath['src/extra.ts'] = 'activate();'; value.sourceInputs.push(identity('src/extra.ts', 'activate();')); },
    value => { delete value.sourceTextByPath['src/ui/native-text.ts']; },
    value => { value.sourceTextByPath['src/../outside.ts'] = ''; },
    value => { value.sourceInputs.push(identity('src/receipt-only.ts', '')); },
    value => { value.sourceInputs = value.sourceInputs.filter(input => input.path !== 'index.html'); },
    value => { value.sourceInputs.push({ ...value.sourceInputs[0] }); },
  ]) {
    const value = await specimen(); mutate(value);
    assert.throws(() => verifyD11ApplicationProfile(value));
  }
});

test('missing or changed source receipts and bootstrap bodies provide no profile authority', async () => {
  for (const mutate of [
    value => { delete value.sourceInputs; },
    value => { value.sourceInputs[0].rawBytes++; },
    value => { value.sourceInputs[0].sha256 = 'sha256:' + '0'.repeat(64); },
    value => { delete value.bootstrapText; },
    value => { value.bootstrapText += '\ndocument.querySelector("ie-shell")[unknownOwner][unknownAction]();'; },
    value => { value.sourceTextByPath['index.html'] += '<script>activate()</script>'; },
  ]) {
    const value = await specimen(); mutate(value);
    assert.throws(() => verifyD11ApplicationProfile(value));
  }
});
