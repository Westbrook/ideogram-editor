import {parseSync} from 'rolldown/utils';
import {readdirSync, existsSync, readFileSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createBrowserPlan, browserHarnessExclusions} from './container/browser-plan.mjs';
import {functionalGates} from './manifest.mjs';
import {consumerInputs} from '../consumer-inputs.mjs';

export function discoverFiles(root, directory, suffix) {
  return readdirSync(join(root, directory), {withFileTypes:true}).flatMap(entry => entry.isDirectory()
    ? discoverFiles(root, `${directory}/${entry.name}`, suffix) : entry.name.endsWith(suffix) ? [`${directory}/${entry.name}`] : []).sort();
}
export function assertSameInventory(required, assigned, label) {
  const missing = required.filter(file => !assigned.includes(file)), orphan = assigned.filter(file => !required.includes(file));
  if (new Set(assigned).size !== assigned.length || missing.length || orphan.length) throw Error(`${label} inventory mismatch: missing=${missing.join(',')} orphan=${orphan.join(',')} duplicate=${assigned.length-new Set(assigned).size}`);
}
export function checkTestSyntax(path,source){
  // Use the installed, lock-pinned JS/TS parser. Do not transform, import or
  // execute tests; valid non-erasable TypeScript (including enums) stays valid.
  const result=parseSync(path,source);
  if(result.errors.length)throw new Error(`Test syntax ${path}: ${result.errors.map(error=>error.message).join('; ')}`);
}
export async function validationPreflight(root) {
  // Metadata discovery only: never load test modules (even Playwright --list
  // can execute top-level servers, native imports and fixture preparation).
  const gates = functionalGates(root), nodeFiles = gates.flatMap(gate => gate.files ?? []);
  assertSameInventory(discoverFiles(root, 'tests', '.test.mjs'), nodeFiles, 'Node');
  const browser = createBrowserPlan({selection:'all', scope:'features', output:join(root,'artifacts/validation-plan-only')});
  const browserFiles = [...new Set(browser.steps.flatMap(step => step.files))];
  assertSameInventory(discoverFiles(root,'tests','.spec.ts'), [...browserFiles,...browserHarnessExclusions.map(item=>item.file)], 'Browser');
  for (const step of browser.steps) {
    if (step.config && !existsSync(join(root,step.config))) throw Error(`Missing browser configuration: ${step.config}`);
    for (const prerequisite of step.prerequisites ?? []) if (!browser.steps.some(item => item.id === prerequisite && !item.config)) throw Error(`Unknown fixture: ${prerequisite}`);
  }
  for (const entry of browserHarnessExclusions) if (!nodeFiles.includes(entry.parent)) throw Error(`Missing negative harness parent: ${entry.parent}`);
  const testSources=[...discoverFiles(root,'tests','.ts'),...discoverFiles(root,'tests','.mjs')];
  for(const path of testSources)checkTestSyntax(path,readFileSync(join(root,path),'utf8'));
  const consumer = await consumerInputs(root);
  const packageJSON = JSON.parse(readFileSync(join(root,'package.json')));
  return {kind:'validation-preflight-1', nodeFiles:nodeFiles.length, parsedTestSources:testSources.length, browserFiles:browserFiles.length, harnessFiles:browserHarnessExclusions.length,
    browserInvocations:browser.steps.filter(step=>step.config).length, consumerArchives:consumer.archivePaths, toolchain:packageJSON.engines,
    scope:'Source inventory and prerequisites only. No cases executed, no product/qualification result.'};
}
if (import.meta.main) {
  const root=resolve(fileURLToPath(new URL('../../',import.meta.url)));
  console.log(JSON.stringify(await validationPreflight(root),null,2));
}
