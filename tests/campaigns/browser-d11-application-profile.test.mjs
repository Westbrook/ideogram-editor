import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parseSync } from 'rolldown/utils';
import { D11_ROLE_CONTEXT } from '../../tooling/qualification/campaigns/browser-d11-registration.mjs';
import { assertD11MemberAssignmentEffects, assertD11DOMDataEffects, deriveD11NativePreparationClosure, deriveD11WorkerActivation } from '../../tooling/qualification/campaigns/browser-d11-worker-activation.mjs';
import { D11_APPLICATION_SOURCE_PATHS, verifyD11ApplicationProfile } from '../../tooling/qualification/campaigns/browser-d11-application-profile.mjs';
import { assertD11EventCorpus } from '../../tooling/qualification/campaigns/browser-d11-private-events.mjs';

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
  ['src/ui/adapter-library.ts', 40327, '[next[index+offset],next[index]]=[next[index]!,next[index+offset]!]'],
  ['src/ui/composition.ts', 44026, '[es[i],es[j]]=[es[j],es[i]]'],
  ['src/ui/composition.ts', 56460, '[a[i-1],a[i]]=[a[i],a[i-1]]'],
  ['src/ui/request-v45-edit.ts', 12316, '[next.references[index],next.references[target]]=[next.references[target],next.references[index]]'],
  ['src/ui/shell.ts', 87789, '[ids[i],ids[i+1]]=[ids[i+1],ids[i]]'],
  ['src/ui/shell.ts', 87847, '[ids[i],ids[i-1]]=[ids[i-1],ids[i]]'],
];
let retainedClosure;
async function provisional() {
  retainedClosure ??= specimen().then(value => deriveD11NativePreparationClosure({ sourceTextByPath: value.sourceTextByPath, parser }));
  const proof = structuredClone(await retainedClosure);
  assert.equal(proof.complete, true, proof.missing.join('; '));
  return proof;
}
const conditionalFrom = sites => ({ kind: 'd11-conditional-member-assignments-1', sites: sites.map(({ effect, ...row }) => ({ ...row, requirement: 'reviewed-data-only-array-reordering' })) });

test('fully verified profile derives the complete six reviewed member effects from exact source spans', async () => {
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

// The effect argument below exercises only the structural join. Actual archive,
// installed input and emitted member authority is tested by the invocation
// contract's authentic fixture; caller-created objects cannot mint exclusions.
const treeEffect={treeSelectedKeys:'immutable-string-array-from-reviewed-value-model'};
test('verified application profile binds both exact tree observations and requires their producer effect',async()=>{
  const value=await specimen(),profile=verifyD11ApplicationProfile(value),proof=await provisional();
  const source='src/ui/shell.ts',expression='(tree as EnTree).selectedKeys[0]';
  const expected=[77537,78210].map(start=>({source,start,end:start+expression.length,
    sourceSha256:identity(source,value.sourceTextByPath[source]).sha256,expressionSha256:identity(source,expression).sha256,effect:'en-tree-selected-keys-zero-read'}));
  assert.deepEqual(profile.domDataEffects,{kind:'reviewed-d11-dom-data-reads-1',sites:expected});
  assert.deepEqual(assertD11DOMDataEffects(proof.witness.conditionalDOMEffects,profile,treeEffect),expected);
  for(const effect of [undefined,{}, {treeSelectedKeys:'any-property-is-data'}])assert.throws(()=>assertD11DOMDataEffects(proof.witness.conditionalDOMEffects,profile,effect));
  profile.domDataEffects.sites[0].effect='changed';
  assert.deepEqual(verifyD11ApplicationProfile(value).domDataEffects.sites,expected);
});

test('missing changed extra or caller-forged DOM observation rows cannot satisfy the final join',async()=>{
  const profile=verifyD11ApplicationProfile(await specimen()),conditional=(await provisional()).witness.conditionalDOMEffects;
  for(const mutate of [
    x=>{x.sites.pop();},x=>{x.sites.push({...x.sites[0]});},x=>{x.sites[0].start++;},x=>{x.sites[0].end++;},
    x=>{x.sites[0].source='src/ui/request.ts';},x=>{x.sites[0].sourceSha256='sha256:'+'0'.repeat(64);},
    x=>{x.sites[0].expressionSha256='sha256:'+'0'.repeat(64);},x=>{x.sites[0].requirement='selectedKeys-name';},
    x=>{x.sites.push({...x.sites[0],start:x.sites[0].end,end:x.sites[0].end+1});},
  ]){const changed=structuredClone(conditional);mutate(changed);assert.throws(()=>assertD11DOMDataEffects(changed,profile,treeEffect));}
  for(const mutate of [
    x=>{delete x.domDataEffects;},x=>{x.domDataEffects.sites.pop();},x=>{x.domDataEffects.sites[0].effect='any-tree';},
    x=>{x.domDataEffects.sites[0].expressionSha256='sha256:'+'0'.repeat(64);},x=>{x.inputs=x.inputs.filter(row=>row.path!=='src/ui/shell.ts');},
  ]){const changed=structuredClone(profile);mutate(changed);assert.throws(()=>assertD11DOMDataEffects(conditional,changed,treeEffect));}
  const value=await specimen();
  const result=deriveD11WorkerActivation({...value,parser,roleContext:D11_ROLE_CONTEXT,files:[],outputTextByFile:{},
    applicationSourceProfile:profile,conditionalDOMEffects:conditional,invocationEffects:treeEffect});
  assert.equal(result.complete,false);assert.deepEqual(result.excludedWorkers,[]);
});

test('spoofed tree query registration template or property cannot acquire data-read authority',async()=>{
  const authentic=await specimen(),source='src/ui/shell.ts';
  for(const [before,after] of [
    ["tree=this.querySelector<HTMLElement>('#layer-tree')","tree=this.querySelector<HTMLElement>('#other-owner')"],
    ['<en-tree id="layer-tree"','<other-owner id="layer-tree"'],
    ['(tree as EnTree).selectedKeys[0]','(tree as EnTree).controllers[0]'],
    ['(tree as EnTree).selectedKeys[0]','(tree as EnTree).selectedKeys[1]'],
    ["import { treeDefinition } from '@en-reve/elements/definitions/tree.js';","import { treeDefinition } from './fake-tree.js';"],
  ]){
    const value=structuredClone(authentic);assert(value.sourceTextByPath[source].includes(before));
    value.sourceTextByPath[source]=value.sourceTextByPath[source].replace(before,after);
    value.sourceInputs[value.sourceInputs.findIndex(row=>row.path===source)]=identity(source,value.sourceTextByPath[source]);
    value.domDataEffects=verifyD11ApplicationProfile(authentic).domDataEffects;
    assert.throws(()=>verifyD11ApplicationProfile(value),/reviewed application source differs/);
  }
});

// This is the only computed data alias with same-binding receiver calls in the
// root's complete current-source census. These tests verify retained source
// effects only; they do not execute the application or mint feature admission.
test('verified profile binds the one request operation lookup and all four exact string calls', async () => {
  const value = await specimen(), before = structuredClone(value), profile = verifyD11ApplicationProfile(value);
  const source = 'src/ui/request.ts', text = value.sourceTextByPath[source];
  const expression = 'operations[labels.indexOf(label)]', declarationExpression = 'op=' + expression;
  const callExpression = "op.endsWith('-v45')";
  assert.equal(text.indexOf(expression), 54549);
  assert.equal(text.indexOf(expression, 54550), -1);
  assert.equal(text.indexOf(declarationExpression), 54546);
  const calls = [54641, 55059, 55084, 55674].map(start => {
    assert.equal(text.slice(start, start + callExpression.length), callExpression);
    return { start, end: start + callExpression.length, expressionSha256: identity(source, callExpression).sha256, method: 'endsWith', argument: '-v45' };
  });
  assert.equal(text.split(callExpression).length - 1, calls.length);
  const expected = { kind: 'reviewed-d11-event-data-calls-1', sites: [{
    source, start: 54549, end: 54582, expressionSha256: identity(source, expression).sha256,
    sourceSha256: identity(source, text).sha256,
    declaration: { start: 54546, end: 54582, expressionSha256: identity(source, declarationExpression).sha256 },
    calls, effect: 'request-operation-literal-string-method',
  }] };
  assert.deepEqual(profile.eventDataEffects, expected);
  for (const path of [source, 'src/request/core.ts', 'src/request/family.ts']) {
    assert.deepEqual(profile.inputs.find(row => row.path === path), identity(path, value.sourceTextByPath[path]));
  }
  assert.deepEqual(value, before);
  profile.eventDataEffects.sites[0].declaration.start++;
  profile.eventDataEffects.sites[0].calls[0].method = 'call';
  profile.eventDataEffects.sites.push({ ...profile.eventDataEffects.sites[0] });
  assert.deepEqual(verifyD11ApplicationProfile(value).eventDataEffects, expected, 'returned mutable metadata cannot change the fixed review');
});

test('changed request data producers imports guard and receiver calls cannot self-authorize new event effects', async () => {
  const authentic = await specimen(), eventDataEffects = verifyD11ApplicationProfile(authentic).eventDataEffects;
  const request = 'src/ui/request.ts';
  for (const [source, before, after] of [
    ['src/request/core.ts', "operations=['generate','instant'", "operations=[globalThis.unreviewedCallback,'instant'"],
    ['src/request/family.ts', "operations=[...v4.operations,'generate-v45'", "operations=[...v4.operations,globalThis.unreviewedCallback"],
    ['src/request/family.ts', "labels=[...v4.labels,'Generate with Ideogram v4.5'", "labels=[...v4.labels,globalThis.unreviewedLabel"],
    [request, "from '../request/family.js';", "from './unreviewed-family.js';"],
    [request, 'operations[labels.indexOf(label)]', 'operations[label]'],
    [request, 'if(!op||op===this.op)return;', 'if(op===this.op)return;'],
    [request, "op.endsWith('-v45')", "op.call('-v45')"],
    [request, "op.endsWith('-v45')", "op.endsWith(unreviewedSuffix)"],
    [request, "op.endsWith('-v45')", "op.endsWith('-v45');op()"],
  ]) {
    const value = structuredClone(authentic); assert(value.sourceTextByPath[source].includes(before));
    value.sourceTextByPath[source] = value.sourceTextByPath[source].replace(before, after);
    value.sourceInputs[value.sourceInputs.findIndex(row => row.path === source)] = identity(source, value.sourceTextByPath[source]);
    value.eventDataEffects = structuredClone(eventDataEffects);
    assert.throws(() => verifyD11ApplicationProfile(value), /reviewed application source differs/);
  }
});

test('later data mutation native-method replacement and extra callback consumers cannot inherit the reviewed string effect', async () => {
  const authentic = await specimen();
  for (const [source, addition] of [
    ['src/request/core.ts', '\noperations[0]=globalThis.unreviewedCallback;\n'],
    ['src/request/family.ts', '\noperations.push(globalThis.unreviewedCallback);\n'],
    ['src/ui/request.ts', '\nString.prototype.endsWith=function(){globalThis.unreviewedCallback();return true;};\n'],
    ['src/ui/request.ts', '\nfunction unreviewed(callbacks,key){const op=callbacks[key];op.endsWith("-v45");}\n'],
  ]) {
    const value = structuredClone(authentic); value.sourceTextByPath[source] += addition;
    value.sourceInputs[value.sourceInputs.findIndex(row => row.path === source)] = identity(source, value.sourceTextByPath[source]);
    value.eventDataEffects = verifyD11ApplicationProfile(authentic).eventDataEffects;
    assert.throws(() => verifyD11ApplicationProfile(value), /reviewed application source differs/);
  }
});

test('event data effects are unavailable before complete source receipt and bootstrap verification and ignore caller claims', async () => {
  const authentic = await specimen(), expected = verifyD11ApplicationProfile(authentic);
  for (const mutate of [
    value => { delete value.sourceTextByPath['src/request/core.ts']; },
    value => { value.sourceInputs = value.sourceInputs.filter(row => row.path !== 'src/request/family.ts'); },
    value => { value.sourceInputs.find(row => row.path === 'src/ui/request.ts').rawBytes++; },
    value => { delete value.bootstrapText; },
    value => { value.bootstrapText += '\n/* unreviewed execution */'; },
  ]) {
    const value = structuredClone(authentic); mutate(value); value.eventDataEffects = expected.eventDataEffects;
    assert.throws(() => verifyD11ApplicationProfile(value));
  }
  for (const eventDataEffects of [null, { kind: 'reviewed-d11-event-data-calls-1', sites: [] }, { kind: 'caller-allowlist', sites: [{ method: 'endsWith' }] }]) {
    assert.deepEqual(verifyD11ApplicationProfile({ ...authentic, eventDataEffects }), expected);
  }
});

// These independent literal positions and complete calls preserve the finite
// receiver review. They never infer authority from a method named select.
const expectedFileSelections = [
  ["src/ui/authoring.ts", 55970, "this.select", "this.select('Selection shape','shape',['rectangle','ellipse','polygon'],v=>{this.shape=v as typeof this.shape;})"],
  ["src/ui/authoring.ts", 56092, "this.select", "this.select('Selection combination','combine',['replace','add','subtract','intersect'],v=>{this.combine=v as Combine;})"],
  ["src/ui/authoring.ts", 57651, "this.select", "this.select('Brush action','brush',['add','subtract'],v=>this.brush=v as typeof this.brush)"],
  ["src/ui/authoring.ts", 61758, "this.select", "this.select('Mask preview view','previewMode',Object.keys(p.views),v=>{this.previewMode=v;})"],
  ["src/ui/authoring.ts", 62702, "this.select", "this.select('Sample source','sampleScope',['merged','active'],v=>{this.sampleScope=v;this.sampleGeneration++;})"],
  ["src/ui/image-import.ts", 11899, "this.select", "this.select(files)"],
  ["src/ui/native-text.ts", 81986, "this.editor.select", "this.editor.select([review.parts[0].layerId])"],
  ["src/ui/native-text.ts", 86688, "this.editor.select", "this.editor.select([s.layerId])"],
  ["src/ui/native-text.ts", 98022, "this.control.select", "this.control.select()"],
  ["src/ui/native-text.ts", 102683, "this.select", "this.select('Text alignment',s.style.align,['left','center','right','start','end'],(s,v)=>s.style={...s.style,align:v as TextStyle['align']})"],
  ["src/ui/native-text.ts", 102827, "this.select", "this.select('Text direction',s.style.direction,['auto','ltr','rtl'],(s,v)=>s.style={...s.style,direction:v as TextStyle['direction']})"],
  ["src/ui/shell.ts", 12064, "editor.select", "editor.select([id])"],
  ["src/ui/shell.ts", 73137, "controls.select", "controls.select(files)"],
  ["src/ui/shell.ts", 90832, "editor.select", "editor.select(ids)"],
];
test('exact current selection receivers close every FileUpload activation obligation', async () => {
  const value = await specimen(), profile = verifyD11ApplicationProfile(value);
  const sites = expectedFileSelections.map(([source, start, expression, callExpression]) => {
    const text = value.sourceTextByPath[source];
    assert.equal(text.slice(start, start + callExpression.length), callExpression);
    assert.equal(text.indexOf(callExpression), start);assert.equal(text.indexOf(callExpression, start + 1), -1);
    return {source,start,end:start+expression.length,sourceSha256:identity(source,text).sha256,expressionSha256:identity(source,expression).sha256,
      call:{start,end:start+callExpression.length,expressionSha256:identity(source,callExpression).sha256},effect:'non-file-upload-selection'};
  });
  assert.equal(sites.length,14);assert.deepEqual(profile.fileSelectionEffects,{kind:'reviewed-d11-file-selection-calls-1',sites});
  assert.doesNotThrow(()=>assertD11EventCorpus({...value,parser,applicationSourceProfile:profile}));
  for(const mutate of [
    x=>{delete x.fileSelectionEffects;},x=>{x.fileSelectionEffects.sites.pop();},x=>{x.fileSelectionEffects.sites.push({...x.fileSelectionEffects.sites[0]});},
    x=>{x.fileSelectionEffects.sites[0].effect='any-select-is-safe';},x=>{x.fileSelectionEffects.sites[0].start++;},
    x=>{x.fileSelectionEffects.sites[0].call.end++;},x=>{x.fileSelectionEffects.sites[0].call.expressionSha256='sha256:'+'0'.repeat(64);},
    x=>{x.fileSelectionEffects.sites[0].sourceSha256='sha256:'+'0'.repeat(64);},x=>{x.inputs=x.inputs.filter(row=>row.path!=='src/ui/shell.ts');},
  ]) {const changed=structuredClone(profile);mutate(changed);assert.throws(()=>assertD11EventCorpus({...value,parser,applicationSourceProfile:changed}));}
});
test('rebound selection receiver or loader callback cannot mint a current selection effect', async () => {
  const baseline=await specimen(),profile=verifyD11ApplicationProfile(baseline);
  for(const [source,before,after] of [
    ['src/ui/native-text.ts','this.editor.select([s.layerId])','this.control.select([s.layerId])'],
    ['src/ui/shell.ts','new loaded.ImageImportControls(this,editor)',"this.querySelector('en-file-upload')"],
    ['src/ui/shell.ts','controls=>controls.select(files)',"controls=>this.querySelector('en-file-upload').select(files)"],
  ]) {
    const value=structuredClone(baseline);assert.equal(value.sourceTextByPath[source].split(before).length,2);
    value.sourceTextByPath[source]=value.sourceTextByPath[source].replace(before,after);
    value.sourceInputs=value.sourceInputs.map(row=>row.path===source?identity(source,value.sourceTextByPath[source]):row);
    assert.throws(()=>verifyD11ApplicationProfile(value),/reviewed application source differs/);
    assert.throws(()=>assertD11EventCorpus({...value,parser,applicationSourceProfile:profile}));
  }
});
