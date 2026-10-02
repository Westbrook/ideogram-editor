import { functionalGates, selectGates } from '../manifest.mjs';

const engines = ['chromium', 'firefox', 'webkit', 'all'];
const scopes = ['base', 'features'];
const usage = 'Usage: node tooling/qualification/container/run.mjs [chromium|firefox|webkit|all] [base|features] [--browser-only]';

// This chooses an existing runner's plan; it does not execute a second runner.
export function parseContainerSelection(argv) {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) throw Error(usage);
  const args = [...argv];
  const browserOnly = args.at(-1) === '--browser-only';
  if (browserOnly) args.pop();
  const [selection = 'chromium', scope = 'features'] = args;
  if (args.length > 2 || !engines.includes(selection) || !scopes.includes(scope)) throw Error(usage);
  return Object.freeze({ selection, scope, browserOnly });
}

export function selectContainerNodePlan(root, { scope, browserOnly }) {
  if (!scopes.includes(scope) || typeof browserOnly !== 'boolean') throw Error(usage);
  // Fresh app/server dependencies remain in the browser invocation. The full
  // discovery audit still runs, so omitted Node execution cannot hide an orphan.
  const selector = browserOnly ? 'build-server' : scope === 'features' ? 'all' : 'base';
  return selectGates(functionalGates(root), selector);
}

// Forward only the explicitly supplied packet location. The existing installer
// remains responsible for canonical paths, sealed bytes and platform authority.
export function containerPacketEnvironment(environment) {
  return environment.IE_SCHEMA18_EXECUTABLE_PACKET === undefined ? {} :
    { IE_SCHEMA18_EXECUTABLE_PACKET: environment.IE_SCHEMA18_EXECUTABLE_PACKET };
}
