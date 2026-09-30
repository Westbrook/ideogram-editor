import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createReviewDraft, createThemePair, emitThemePairCSS, createThemeCompanion} from '@en-reve/tokens';

const root = new URL('../../', import.meta.url);
const source = new URL('vendor/themes/spectrum/', root);
const read = async name => readFile(new URL(name, source), 'utf8');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const provenance = JSON.parse(await read('provenance.json'));
for (const [name, digest] of Object.entries(provenance.snapshotFiles)) assert.equal(hash(await read(name)), digest, name);
const definition = JSON.parse(await read('definition.json'));
const branches = {};
const companion = [];
for (const mode of ['light', 'dark']) {
  const draft = createReviewDraft(definition.baseOptions[mode]);
  for (const edit of JSON.parse(await read(`spectrum.${mode}.json`))) {
    if (edit.type === 'context') { const {type, ...context} = edit; draft.setContext(context); }
    else if (edit.type === 'token') draft.setToken(edit.id, edit.value);
    else if (edit.type === 'restore') draft.restoreToken(edit.id);
    else assert.fail(`Unknown edit type ${edit.type}`);
  }
  assert.equal(draft.theme.mode, mode);
  assert.equal(draft.theme.density, definition.density);
  assert.deepEqual(draft.theme.diagnostics, []);
  branches[mode] = draft.theme;
  companion.push(createThemeCompanion(draft.theme, definition.companion, {name: definition.id}).css);
}
const pair = createThemePair({name: definition.id, ...branches});
const auto = companion.map((css, index) => `@media (prefers-color-scheme: ${['light','dark'][index]}) {\n${css.replaceAll(`[data-en-appearance="${['light','dark'][index]}"]`, ':not([data-en-appearance="light"], [data-en-appearance="dark"])')}\n}`).join('\n');
const outputs = {
  'src/theme/spectrum.css': emitThemePairCSS(pair),
  'src/theme/spectrum.companion.css': companion.join('\n') + auto + '\n',
  'vendor/themes/spectrum/compiled.json': JSON.stringify({pairSourceHash:pair.sourceHash, compilerVersion:pair.compilerVersion, branches:Object.fromEntries(Object.entries(branches).map(([mode, theme])=>[mode,{sourceHash:theme.sourceHash,tokens:Object.fromEntries(Object.entries(theme.tokens).map(([id,t])=>[id,{cssName:t.cssName,value:t.cssValue}]))}]))},null,2)+'\n',
};
for (const [name, content] of Object.entries(outputs)) {
  if (process.argv.includes('--write')) await writeFile(new URL(name, root), content);
  else assert.equal(await readFile(new URL(name, root),'utf8'), content, `Regenerate ${name}`);
}
console.log(JSON.stringify({pairSourceHash:pair.sourceHash, outputs:Object.fromEntries(Object.entries(outputs).map(([name,content])=>[name,hash(content)]))},null,2));
