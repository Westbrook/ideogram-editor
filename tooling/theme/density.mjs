import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createThemePair, emitThemePairCSS, createThemeCompanion} from '@en-reve/tokens';
import {root, hash, spectrumSource, pairedCompanion} from './spectrum-source.mjs';

export async function densityOutputs() {
  const source = await spectrumSource();
  const themes = [], companions = [], variants = {};
  for (const density of ['comfortable', 'spacious']) {
    const name = `${source.definition.id}-${density}`;
    const branches = Object.fromEntries(['light', 'dark'].map(mode => [mode, source.branch(mode, density)]));
    const pair = createThemePair({name, ...branches});
    themes.push(emitThemePairCSS(pair));
    companions.push(pairedCompanion(['light', 'dark'].map(mode => createThemeCompanion(branches[mode], source.definition.companion, {name}).css)));
    variants[density] = {
      name, density: pair.density, pairSourceHash: pair.sourceHash, compilerVersion: pair.compilerVersion,
      branches: Object.fromEntries(Object.entries(branches).map(([mode, theme]) => [mode, {sourceHash: theme.sourceHash, tokenCount: Object.keys(theme.tokens).length}])),
    };
  }
  const outputs = {
    'src/theme/spectrum.density.css': themes.join('\n'),
    'src/theme/spectrum.density.companion.css': companions.join('\n'),
  };
  outputs['tooling/theme/density.generated.json'] = JSON.stringify({
    schema: 'ideogram-spectrum-density-1',
    sourceFiles: source.provenance.snapshotFiles,
    compilerArchive: source.provenance.compilerArchive,
    compact: {name: source.definition.id, density: source.definition.density, generatedBy: 'tooling/theme/spectrum.mjs'},
    variants,
    outputs: Object.fromEntries(Object.entries(outputs).map(([name, content]) => [name, hash(content)])),
  }, null, 2) + '\n';
  return outputs;
}

export async function verifyDensityOutputs() {
  const outputs = await densityOutputs();
  for (const [name, content] of Object.entries(outputs)) assert.equal(await readFile(new URL(name, root), 'utf8'), content, `Regenerate ${name} with node tooling/theme/density.mjs --write`);
  return Object.fromEntries(Object.entries(outputs).map(([name, content]) => [name, hash(content)]));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.argv.includes('--write')) for (const [name, content] of Object.entries(await densityOutputs())) await writeFile(new URL(name, root), content);
  console.log(JSON.stringify({outputs: await verifyDensityOutputs()}, null, 2));
}
