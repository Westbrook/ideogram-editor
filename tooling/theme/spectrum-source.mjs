import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createReviewDraft} from '@en-reve/tokens';

export const root = new URL('../../', import.meta.url);
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// The approved source is immutable. Density variants are separate app outputs;
// replaying it never changes the sealed source or its original compact theme.
export async function spectrumSource() {
  const source = new URL('vendor/themes/spectrum/', root);
  const read = async name => readFile(new URL(name, source), 'utf8');
  const provenance = JSON.parse(await read('provenance.json'));
  for (const [name, digest] of Object.entries(provenance.snapshotFiles)) assert.equal(hash(await read(name)), digest, name);
  const definition = JSON.parse(await read('definition.json'));
  const edits = Object.fromEntries(await Promise.all(['light', 'dark'].map(async mode => [mode, JSON.parse(await read(`spectrum.${mode}.json`))])));
  return {
    definition, provenance,
    branch(mode, density = definition.density) {
      const draft = createReviewDraft(definition.baseOptions[mode]);
      for (const edit of edits[mode]) {
        if (edit.type === 'context') { const {type, ...context} = edit; draft.setContext(context); }
        else if (edit.type === 'token') draft.setToken(edit.id, edit.value);
        else if (edit.type === 'restore') draft.restoreToken(edit.id);
        else assert.fail(`Unknown edit type ${edit.type}`);
      }
      assert.equal(draft.theme.mode, mode);
      assert.equal(draft.theme.density, definition.density);
      draft.setContext({density});
      assert.equal(draft.theme.density, density);
      assert.deepEqual(draft.theme.diagnostics, []);
      return draft.theme;
    },
  };
}

export function pairedCompanion(companion) {
  const auto = companion.map((css, index) => `@media (prefers-color-scheme: ${['light','dark'][index]}) {\n${css.replaceAll(`[data-en-appearance="${['light','dark'][index]}"]`, ':not([data-en-appearance="light"], [data-en-appearance="dark"])')}\n}`).join('\n');
  return companion.join('\n') + auto + '\n';
}
