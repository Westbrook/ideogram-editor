import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {createThemePair, emitThemePairCSS, createThemeCompanion} from '@en-reve/tokens';
import {root, hash, spectrumSource, pairedCompanion} from './spectrum-source.mjs';

const source = await spectrumSource();
const {definition} = source;
const branches = {};
const companion = [];
for (const mode of ['light', 'dark']) {
  const theme = source.branch(mode);
  branches[mode] = theme;
  companion.push(createThemeCompanion(theme, definition.companion, {name: definition.id}).css);
}
const pair = createThemePair({name: definition.id, ...branches});
const outputs = {
  'src/theme/spectrum.css': emitThemePairCSS(pair),
  'src/theme/spectrum.companion.css': pairedCompanion(companion),
  'vendor/themes/spectrum/compiled.json': JSON.stringify({pairSourceHash:pair.sourceHash, compilerVersion:pair.compilerVersion, branches:Object.fromEntries(Object.entries(branches).map(([mode, theme])=>[mode,{sourceHash:theme.sourceHash,tokens:Object.fromEntries(Object.entries(theme.tokens).map(([id,t])=>[id,{cssName:t.cssName,value:t.cssValue}]))}]))},null,2)+'\n',
};
for (const [name, content] of Object.entries(outputs)) {
  if (process.argv.includes('--write')) await writeFile(new URL(name, root), content);
  else assert.equal(await readFile(new URL(name, root),'utf8'), content, `Regenerate ${name}`);
}
console.log(JSON.stringify({pairSourceHash:pair.sourceHash, outputs:Object.fromEntries(Object.entries(outputs).map(([name,content])=>[name,hash(content)]))},null,2));
