import {readFile, mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {hashFile, fileManifest, json} from './common.mjs';
import {exactPattern, classifySuite, nativeNodeBrowserFiles} from './selectors.mjs';
import {verifyAdapterFixture} from '../container/inputs.mjs';
import {requiredSuiteEnvironment} from '../suite-prerequisites.mjs';
const records = bytes => bytes.toString('utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const issuerPreparations = new Map();

async function completionIssuers(source, directory) {
  const key = source + '\0' + directory;
  if (!issuerPreparations.has(key)) issuerPreparations.set(key, (async () => {
    const {prepareCompletionIssuers} = await import('../completion-issuers/index.mjs');
    const output = join(directory, 'completion-issuers');
    const prepared = await prepareCompletionIssuers(output, source);
    return {env: prepared.env, evidence: {output, files: await fileManifest(output)}};
  })());
  return issuerPreparations.get(key);
}

export function browserEnvironment(directory) {
  return {EDITOR_RECEIPT: directory, IE_SHELL_OUTPUT: directory, IE_CONSUMER_OUTPUT: directory, IE_RASTER_OUTPUT: directory,
    IE_HISTORY_OUTPUT: directory, IE_RECOVERY_OUTPUT: directory, TEXT_RECEIPT: directory, SPECTRUM_OUTPUT: directory,
    ADAPTER_OUTPUT: directory, QUALIFICATION_A11Y_OUTPUT: directory, QUALIFICATION_AXE_OUTPUT: directory,
    EDITOR_BROWSER: 'chromium', QUALIFICATION_BROWSER: 'chromium', SPECTRUM_BROWSER: 'chromium'};
}

export async function runNodeSelection({source, directory, group, mode, focused, inventory, command, pinned, abortSignal}) {
        const method = group === 'unit' ? 'U' : 'L', selection = mode === 'focused' ? focused[group] : null;
        const selected = selection ? [...new Set(selection.map(item => item.file))].map(file => inventory.find(item => item.file === file)) : inventory.filter(item => item.method === method);
        if (selected.some(item => !item) || !selected.length) throw Error('Node selector has missing or zero files');
        // Focused per-file selection prevents a same-titled test in another
        // file from acquiring an unintended slot. Full files share only guards.
        const groups = new Map();
        for (const item of selected) { const key = selection ? item.file : item.guard; groups.set(key, [...(groups.get(key) ?? []), item]); }
        let completionInputs = {}, fixturePrerequisite = null, issuerPrerequisite = null, adapterFixture = null;
        if (selected.some(item => item.file.startsWith('tests/adapters/'))) {
          adapterFixture = {before: await verifyAdapterFixture({root: source})};
          completionInputs = {IE_ADAPTER_PROFILE_FIXTURE: adapterFixture.before.path, IE_ADAPTER_FIXTURE: adapterFixture.before.path};
        }
        if (selected.some(item => item.file.startsWith('tests/editor/completion/'))) {
          const prepared = await completionIssuers(source, directory);
          completionInputs = {...completionInputs, ...prepared.env}; issuerPrerequisite = prepared.evidence;
        }
        if (selected.some(item => /tests\/editor\/completion\/(?:protocol-membership|handler-source)\.test\.mjs$/.test(item.file))) {
          const output = join(directory, `${mode}-${group}-completion-inputs`);
          const {prepareCompletionInputs} = await import('../completion-inputs/index.mjs');
          completionInputs = {...completionInputs, ...await prepareCompletionInputs(output, source, {abortSignal, env: {...process.env, ...completionInputs}})};
          fixturePrerequisite = {output, files: await fileManifest(output)};
        }
        const summaries = [];
        for (const files of groups.values()) {
          const expected = selection?.filter(item => files.some(file => file.file === item.file)) ?? null;
          const report = join(directory, `${mode}-${group}-${summaries.length + 1}.ndjson`);
          await command(`${mode}-${group}`, ['--import', './' + files[0].guard, '--test', '--test-concurrency=1', '--test-reporter', './tooling/qualification/developer-campaigns/node-reporter.mjs', '--test-reporter-destination', report,
            ...(expected ? ['--test-name-pattern', exactPattern(expected.map(item => item.name))] : []), ...files.map(item => item.file)], {...requiredSuiteEnvironment(files.map(item => item.file)), QUALIFICATION_METHOD: method, EDITOR_RECEIPT: join(directory, `${mode}-${group}-${summaries.length + 1}-editor`), ...completionInputs}, pinned.executable, 1800000);
          const summary = classifySuite(records(await readFile(report)), {method, files: files.map(item => item.file), expected});
          summaries.push({...summary, report: {path: report, ...await hashFile(report)}});
          if (summary.outcome !== 'PASS') throw Error(`Incomplete ${mode} ${group} command: ${summary.reasons.join(',')}`);
        }
        if (adapterFixture) {
          adapterFixture.after = await verifyAdapterFixture({root: source});
          if (json(adapterFixture.before) !== json(adapterFixture.after)) throw Error('Adapter fixture changed during required Node suite');
        }
        return {group, mode, summaries, fixturePrerequisite, issuerPrerequisite, adapterFixture, executed: summaries.reduce((n, summary) => n + summary.executed, 0)};
      }

export async function runBrowserSelection({source, directory, mode, focused, plan, command, pinned}) {
        const steps = mode === 'focused' ? focused.browser.map((item, i) => ({id: `focused-${i + 1}`, config: item.config, expected: item, env: {}, files: [item.file]})) : plan.steps.filter(step => step.config);
        const summaries = [], issuers = await completionIssuers(source, directory);
        for (const step of steps) {
          const output = join(directory, `${mode}-browser`, step.id); await mkdir(output, {recursive: true});
          const report = join(output, 'cases.ndjson');
          const selectedArgs = step.expected ? ['--config', step.config, step.expected.file, '--grep', exactPattern([step.expected.name]).replace(/^\^/, '(?:^| )')]
            : step.args.slice(step.args.indexOf('test') + 1).filter((value, index, args) => value !== '--reporter' && args[index - 1] !== '--reporter');
          if (!step.expected && step.args.indexOf('test') < 0) throw Error('Browser plan has no executable Playwright test command');
          await command(`${mode}-${step.id}`, ['node_modules/@playwright/test/cli.js', 'test', ...selectedArgs, '--workers=1', '--retries=0', '--forbid-only', '--reporter', './tooling/qualification/developer-campaigns/browser-reporter.mjs'],
          {...browserEnvironment(output), ...step.env, ...issuers.env, QUALIFICATION_CASE_REPORT: report}, pinned.executable, 1800000);
          const actual = records(await readFile(report));
          const files = step.expected ? [step.expected.file] : step.files ?? [...new Set(actual.filter(item => item.type === 'case').map(item => item.file))];
          const summary = classifySuite(actual, {method: 'B', files, expected: step.expected ? [step.expected] : null});
          summaries.push({...summary, report: {path: report, ...await hashFile(report)}});
          if (summary.outcome !== 'PASS') throw Error(`Incomplete browser command: ${step.id}`);
        }
        if (mode === 'full') {
          const output = join(directory, 'full-browser', 'native-node'), app = join(output, 'text-state-app'), evidence = join(output, 'text-state-evidence');
          await mkdir(evidence, {recursive: true});
          await command('full-native-node-fixture', ['node_modules/vite/bin/vite.js', 'build', '--config', 'tests/text-state/vite.config.ts', '--outDir', app]);
          const report = join(output, 'cases.ndjson');
          await command('full-native-node-browser', ['--import', './tests/session/no-egress.mjs', '--test', '--test-concurrency=1', '--test-reporter', './tooling/qualification/developer-campaigns/node-reporter.mjs', '--test-reporter-destination', report, ...nativeNodeBrowserFiles],
            {...browserEnvironment(output), ...issuers.env, QUALIFICATION_METHOD: 'B', TEXT_STATE_APP: app, TEXT_STATE_EVIDENCE: evidence, TEXT_STATE_ENGINES: 'chromium'}, pinned.executable, 1800000);
          const summary = classifySuite(records(await readFile(report)), {method: 'B', files: [...nativeNodeBrowserFiles]});
          summaries.push({...summary, report: {path: report, ...await hashFile(report)}});
          if (summary.outcome !== 'PASS') throw Error('Incomplete native Node-hosted browser command');
        }
        return {group: 'browser', mode, summaries, issuerPrerequisite: issuers.evidence, executed: summaries.reduce((n, summary) => n + summary.executed, 0)};
}
