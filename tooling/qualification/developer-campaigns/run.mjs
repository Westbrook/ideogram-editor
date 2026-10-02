import { startEvidenceMonitor, retainEvidenceAudit } from '../evidence-volume.mjs';
import { lstat } from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {developerCommandPlan, runDeveloperCommandCampaign} from './commands.mjs';
import {archivePlan, prepareArchiveRecipe, runArchiveCampaign} from './archive.mjs';
import {json} from './common.mjs';

const values = {'--campaign': 'campaign', '--output': 'output', '--repo': 'sourceRoot', '--registry': 'registry',
  '--browser-download-host': 'browserDownloadHost', '--input-packet': 'inputPacket', '--recipe': 'recipePath',
  '--frozen': 'frozenDirectory', '--browser-cache': 'browserCacheDirectory', '--browser-executable': 'browserExecutable',
  '--ci-plan': 'ciPlan', '--stage': 'stage', '--received': 'received', '--workspace': 'workspace'};
const flags = {'--plan': 'plan', '--run': 'run', '--install': 'install', '--verify': 'verify', '--prepare-recipe': 'prepare'};

export function parseCampaignOptions(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i], key = values[arg] ?? flags[arg];
    if (!key || Object.hasOwn(options, key)) throw Error('Unknown or duplicate developer campaign option: ' + arg);
    if (values[arg]) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error('Missing value for ' + arg);
      options[key] = args[++i];
    } else options[key] = true;
  }
  if (!['I0', 'I1', 'I2'].includes(options.campaign)) throw Error('--campaign must select I0, I1 or I2');
  if (['plan', 'run', 'verify', 'prepare'].filter(key => options[key]).length > 1) throw Error('Choose one campaign mode');
  if (!options.run && !options.verify && !options.prepare) options.plan = true;
  const allowed = options.plan ? ['campaign', 'plan'] : options.campaign === 'I0'
    ? options.run ? ['campaign', 'run', 'install', 'ciPlan', 'stage', 'received', 'workspace', 'output'] : ['campaign', 'verify', 'ciPlan', 'received', 'output']
    : options.campaign === 'I1' ? ['campaign', 'run', 'install', 'sourceRoot', 'output', 'registry', 'browserDownloadHost', 'inputPacket']
    : options.prepare ? ['campaign', 'prepare', 'sourceRoot', 'output', 'frozenDirectory', 'browserCacheDirectory', 'browserExecutable']
    : ['campaign', 'run', 'install', 'sourceRoot', 'output', 'registry', 'recipePath'];
  for (const key of Object.keys(options)) if (!allowed.includes(key)) throw Error('Option is not applicable to selected campaign mode: ' + key);
  if (options.run && !options.install) throw Error('--run requires --install for campaign-owned dependency installation');
  if (options.campaign === 'I0' && !options.plan) {
    for (const key of ['ciPlan', 'received', 'output', ...(options.run ? ['stage', 'workspace'] : [])]) if (!options[key]) throw Error('I0 requires --' + ({ciPlan: 'ci-plan'}[key] ?? key));
    if (options.run && !/^q3-(?:base|candidate)-i0-(?:normal|cold)-(?:prepareC|restC|H)$/.test(options.stage)) throw Error('I0 stage must identify the exact revision, cache cohort and physical-host branch');
  }
  if (options.campaign === 'I2' && options.run && !options.recipePath) throw Error('I2 requires --recipe with sealed producer/browser inputs');
  if (options.prepare && (!options.browserCacheDirectory || !options.output)) throw Error('Recipe preparation requires --browser-cache and a fresh --output file');
  return options;
}

export function campaignPlan(campaign) {
  if (campaign === 'I1') return developerCommandPlan();
  if (campaign === 'I2') return {...archivePlan(), qualification: false};
  if (campaign !== 'I0') throw Error('Unknown developer campaign');
  return {kind: 'developer-pipeline-campaign-plan-1', job: 'I0', qualification: false,
    samples: ['one complete normal core pipeline', 'one complete cold core pipeline'],
    execution: 'Dedicated physical C and H hosts execute sealed CI graph stages; one local stage is only part of I0.',
    executor: 'tooling/qualification/ci/execute.mjs', workflow: '.github/workflows/qualification.yml',
    planPurposes: {comparison: 'Both base and candidate I0 graphs; immutable distinct revisions.', 'initial-baseline': 'Candidate-only full Q3 including both I0 graphs; no comparison base or relative qualification.'},
    stage: '--campaign I0 --run --install --ci-plan <sealed-ci-plan.json> --stage q3-<base|candidate>-i0-<normal|cold>-<prepareC|restC|H> --received <downloaded-stage-artifacts> --workspace <owned-subjects> --output <fresh-stage-output>',
    join: '--campaign I0 --verify --ci-plan <same-plan.json> --received <all-stage-artifacts> --output <new-result.json>',
    boundaries: 'The CI coordinator verifies dependencies, transfers sealed C2 product bytes, executes H0 native preparation, and joins actual raw node receipts with the same-C pipeline boundary. Queue/provisioning and release acceptance remain separate.'};
}

export async function mainCampaign(args) {
  const options = parseCampaignOptions(args);
  if (options.plan) { console.log(json(campaignPlan(options.campaign))); return; }
  const controller = new AbortController(), interrupt = () => controller.abort('SIGINT'), terminate = () => controller.abort('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  let evidenceMonitor = null, retainedReceiptPath = null;
  try {
    if (options.run && options.campaign !== 'I0') {
      if (!options.output) throw Error('Evidence-accounted campaign requires explicit --output');
      evidenceMonitor = await startEvidenceMonitor({ output: resolve(options.output), campaignId: 'developer-' + options.campaign + '-' + Date.now(), onAlarm: alarm => console.error(JSON.stringify({ evidenceStorageAlarm: alarm })) });
    }
    if (options.campaign === 'I0') {
      const {runCiExecution} = await import('../ci/execute.mjs');
      const arguments_ = [options.run ? 'stage' : 'verify', '--plan', options.ciPlan, '--received', options.received, '--output', options.output];
      if (options.run) arguments_.push('--stage', options.stage, '--workspace', options.workspace);
      await runCiExecution(arguments_, controller.signal);
    } else if (options.campaign === 'I1') {
      const receipt = await runDeveloperCommandCampaign({...options, abortSignal: controller.signal, evidenceStorage: evidenceMonitor?.reference});
      console.log(json({status: receipt.status, qualification: receipt.qualification, groups: receipt.groups.length, missing: receipt.missingQualification, failure: receipt.failure}));
      if (receipt.status !== 'PASS') process.exitCode = 1;
    } else if (options.prepare) {
      const receipt = await prepareArchiveRecipe({...options, abortSignal: controller.signal});
      console.log(json({status: receipt.status, recipe: receipt.recipe, directory: receipt.directory, failure: receipt.failure}));
      if (receipt.status !== 'passed') process.exitCode = 1;
    } else {
      const receipt = await runArchiveCampaign({...options, abortSignal: controller.signal, evidenceStorage: evidenceMonitor?.reference});
      console.log(json({status: receipt.status, directory: receipt.directory, summary: receipt.summary}));
      if (receipt.status !== 'passed-local-campaign') process.exitCode = 1;
    }
  } finally {
    try {
      if (evidenceMonitor) {
        for (const name of ['receipt.json', 'campaign.json', 'failure.json']) {
          const path = join(resolve(options.output), name);
          try { if ((await lstat(path)).isFile()) { retainedReceiptPath = path; break; } } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        const audit = await evidenceMonitor.finish({ receiptPath: retainedReceiptPath, outcome: process.exitCode ? 'FAIL' : 'UNKNOWN' });
        if (retainedReceiptPath) await retainEvidenceAudit(evidenceMonitor.reference, resolve(options.output));
        console.log(json({ evidenceStorage: { status: audit.status, auditId: audit.auditId } }));
        if (audit.status !== 'PASS' && process.exitCode !== 1) process.exitCode = audit.status === 'FAIL' ? 1 : 2;
      }
    } finally {
    process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
    if (controller.signal.aborted) process.exitCode = controller.signal.reason === 'SIGINT' ? 130 : 143;
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) mainCampaign(process.argv.slice(2)).catch(error => { console.error(String(error)); process.exitCode = 1; });
