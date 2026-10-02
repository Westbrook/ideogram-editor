import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parseSync } from 'rolldown/utils';
import { D11_ROLE_CONTEXT } from '../../tooling/qualification/campaigns/browser-d11-registration.mjs';
import { assertD11MemberAssignmentEffects, deriveD11NativePreparationClosure, deriveD11WorkerActivation } from '../../tooling/qualification/campaigns/browser-d11-worker-activation.mjs';
import { D11_APPLICATION_SOURCE_PATHS, verifyD11ApplicationProfile } from '../../tooling/qualification/campaigns/browser-d11-application-profile.mjs';

const require = createRequire(import.meta.url);
const parser = { name: 'rolldown', version: require('rolldown/package.json').version, parseSync };
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

// The application profile is verified from the actual complete retained corpus.
// Only the provisional source analysis runs here; no product module is imported
// and no hand-built effect object can produce final Worker admission.
const expectedAssignments = [
  ['src/ui/adapter-library.ts', 54112, '[next[index-1],next[index]]=[next[index]!,next[index-1]!]'],
  ['src/ui/adapter-library.ts', 54385, '[next[index+1],next[index]]=[next[index]!,next[index+1]!]'],
  ['src/ui/composition.ts', 40427, '[es[i],es[j]]=[es[j],es[i]]'],
  ['src/ui/composition.ts', 51699, '[a[i-1],a[i]]=[a[i],a[i-1]]'],
  ['src/ui/request-v45-edit.ts', 12316, '[next.references[index],next.references[target]]=[next.references[target],next.references[index]]'],
  ['src/ui/shell.ts', 83463, '[ids[i],ids[i+1]]=[ids[i+1],ids[i]]'],
  ['src/ui/shell.ts', 83521, '[ids[i],ids[i-1]]=[ids[i-1],ids[i]]'],
];
let retainedClosure;
async function provisional() {
  retainedClosure ??= specimen().then(value => deriveD11NativePreparationClosure({ sourceTextByPath: value.sourceTextByPath, parser }));
  const proof = structuredClone(await retainedClosure);
  assert.equal(proof.complete, true, proof.missing.join('; '));
  return proof;
}
const conditionalFrom = sites => ({ kind: 'd11-conditional-member-assignments-1', sites: sites.map(({ effect, ...row }) => ({ ...row, requirement: 'reviewed-data-only-array-reordering' })) });

test('fully verified profile derives the complete seven reviewed member effects from exact source spans', async () => {
  const value = await specimen(), profile = verifyD11ApplicationProfile(value);
  const expected = expectedAssignments.map(([source, start, expression]) => {
    const text = value.sourceTextByPath[source];
    assert.equal(text.indexOf(expression), start);
    assert.equal(text.indexOf(expression, start + 1), -1);
    return { source, start, end: start + expression.length, sourceSha256: identity(source, text).sha256,
      assignmentSha256: identity(source, expression).sha256, effect: 'data-only-array-reordering' };
  });
  assert.deepEqual(profile.memberAssignmentEffects, { kind: 'reviewed-d11-data-member-assignments-1', sites: expected });
  const proof = await provisional();
  assert.deepEqual(proof.witness.conditionalMemberEffects, conditionalFrom(expected));
  assert.deepEqual(assertD11MemberAssignmentEffects(proof.witness.conditionalMemberEffects, profile), expected);
  assert.equal(Object.hasOwn(proof, 'excludedWorkers'), false, 'provisional analysis is not final authority');
  profile.memberAssignmentEffects.sites[0].effect = 'changed';
  assert.deepEqual(verifyD11ApplicationProfile(value).memberAssignmentEffects.sites, expected, 'a returned object cannot mutate the fixed profile');
});

test('missing, altered, duplicate, and extra conditional member obligations cannot discharge against the real profile', async () => {
  const profile = verifyD11ApplicationProfile(await specimen()), original = (await provisional()).witness.conditionalMemberEffects;
  for (const mutate of [
    value => { value.kind = 'other'; },
    value => { value.sites.pop(); },
    value => { value.sites.push({ ...value.sites[0] }); },
    value => { value.sites[0].start++; },
    value => { value.sites[0].end++; },
    value => { value.sites[0].source = 'src/ui/request.ts'; },
    value => { value.sites[0].sourceSha256 = 'sha256:' + '0'.repeat(64); },
    value => { value.sites[0].assignmentSha256 = 'sha256:' + '0'.repeat(64); },
    value => { value.sites[0].requirement = 'same-container-permutation'; },
    value => { value.sites[0].effect = 'data-only-array-reordering'; },
    value => { value.sites.push({ ...value.sites[0], start: value.sites[0].end, end: value.sites[0].end + 1 }); },
  ]) {
    const conditional = structuredClone(original); mutate(conditional);
    assert.throws(() => assertD11MemberAssignmentEffects(conditional, profile));
  }
  assert.deepEqual(original, (await provisional()).witness.conditionalMemberEffects);
});

test('missing or altered reviewed effect claims do not satisfy the equality join', async () => {
  const original = verifyD11ApplicationProfile(await specimen()), conditional = (await provisional()).witness.conditionalMemberEffects;
  for (const mutate of [
    value => { delete value.memberAssignmentEffects; },
    value => { value.memberAssignmentEffects.kind = 'other'; },
    value => { value.memberAssignmentEffects.sites.pop(); },
    value => { value.memberAssignmentEffects.sites.push({ ...value.memberAssignmentEffects.sites[0] }); },
    value => { value.memberAssignmentEffects.sites[0].effect = 'requires-reviewed-data-flow'; },
    value => { value.memberAssignmentEffects.sites[0].start++; },
    value => { value.memberAssignmentEffects.sites[0].assignmentSha256 = 'sha256:' + '0'.repeat(64); },
    value => { value.inputs = value.inputs.filter(row => row.path !== conditional.sites[0].source); },
  ]) {
    const profile = structuredClone(original); mutate(profile);
    assert.throws(() => assertD11MemberAssignmentEffects(conditional, profile));
  }
});

test('effects are never returned for re-sealed changed statements, numeric origins, receipts, or bootstrap', async () => {
  const authentic = await specimen();
  for (const [source, before, after] of [
    ...expectedAssignments.map(([source, , expression]) => [source, expression, expression + '/* changed */']),
    ['src/ui/composition.ts', 'j=i+delta', 'j="run"'],
    ['src/ui/request-v45-edit.ts', 'const target=index+delta;', 'const target="run";'],
  ]) {
    const value = structuredClone(authentic);
    assert(value.sourceTextByPath[source].includes(before));
    value.sourceTextByPath[source] = value.sourceTextByPath[source].replace(before, after);
    value.sourceInputs[value.sourceInputs.findIndex(row => row.path === source)] = identity(source, value.sourceTextByPath[source]);
    value.memberAssignmentEffects = verifyD11ApplicationProfile(authentic).memberAssignmentEffects;
    assert.throws(() => verifyD11ApplicationProfile(value), /reviewed application source differs/);
  }
  const receipt = structuredClone(authentic); receipt.sourceInputs.find(row => row.path === expectedAssignments[0][0]).rawBytes++;
  assert.throws(() => verifyD11ApplicationProfile(receipt), /finalized application source differs/);
  const bootstrap = structuredClone(authentic); bootstrap.bootstrapText += '\n/* changed */';
  assert.throws(() => verifyD11ApplicationProfile(bootstrap), /reviewed inline bootstrap differs/);
  const overridden = { ...authentic, memberAssignmentEffects: { kind: 'reviewed-d11-data-member-assignments-1', sites: [] } };
  assert.deepEqual(verifyD11ApplicationProfile(overridden), verifyD11ApplicationProfile(authentic), 'caller effects are ignored');
});

test('pre-tainted same-container permutations cannot acquire the current corpus data-only authority', async () => {
  const authentic = await specimen(), profile = verifyD11ApplicationProfile(authentic), value = structuredClone(authentic);
  const source = 'src/ui/composition.ts';
  const expression = '[object[i],object[j]]=[object[j],object[i]]';
  value.sourceTextByPath[source] += '\nfunction unreviewed(callbacks: Record<string, () => void>, k: string) { const object={run:0,hidden:callbacks[k]};const i="run",j="hidden";' + expression + ';object.run(); }\n';
  const text = value.sourceTextByPath[source], start = text.indexOf(expression);
  value.sourceInputs[value.sourceInputs.findIndex(row => row.path === source)] = identity(source, text);
  assert.throws(() => verifyD11ApplicationProfile(value), /reviewed application source differs/);
  const proof = deriveD11NativePreparationClosure({ sourceTextByPath: value.sourceTextByPath, parser });
  if (proof.complete) {
    assert(proof.witness.conditionalMemberEffects.sites.some(row => row.source === source && row.start === start), 'a provisional permutation retains its obligation');
    assert.throws(() => assertD11MemberAssignmentEffects(proof.witness.conditionalMemberEffects, profile));
  } else assert(proof.missing.length > 0, 'a local refusal also supplies no admission');
  // Equality must also reject an explicitly retained extra obligation; neither
  // same-receiver syntax nor re-hashing its changed module grants authority.
  const conditional = structuredClone((await provisional()).witness.conditionalMemberEffects);
  conditional.sites.push({ source, start, end: start + expression.length, sourceSha256: identity(source, text).sha256,
    assignmentSha256: identity(source, expression).sha256, requirement: 'reviewed-data-only-array-reordering' });
  assert.throws(() => assertD11MemberAssignmentEffects(conditional, profile));
});

test('caller-supplied profile and matched effects cannot mint a final Worker exclusion', async () => {
  const value = await specimen(), applicationSourceProfile = verifyD11ApplicationProfile(value), proof = await provisional();
  const matched = assertD11MemberAssignmentEffects(proof.witness.conditionalMemberEffects, applicationSourceProfile);
  const result = deriveD11WorkerActivation({ ...value, parser, roleContext: D11_ROLE_CONTEXT, files: [], outputTextByFile: {},
    applicationSourceProfile, memberAssignmentEffects: matched,
    invocationContract: { effects: { applicationSourceProfile: 'reviewed-d11-startup-corpus-1', nativeEditingBridgeStartup: 'no-preview-or-apply-dispatch' }, applicationSourceProfile } });
  assert.equal(result.complete, false);
  assert.deepEqual(result.excludedWorkers, []);
  assert(result.missing.length > 0);
});
