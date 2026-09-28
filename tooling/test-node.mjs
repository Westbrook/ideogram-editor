import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export const suites = ['session', 'store', 'protocol', 'assets', 'raster', 'history'];
const buildPrefix = 'npm run build:server && ';

export function commandsFor(scripts, requested) {
  for (const name of requested) {
    if (!suites.includes(name)) throw new Error(`Unknown Node suite: ${name}. Choose: ${suites.join(', ')}`);
  }
  const selected = suites.filter(name => requested.length === 0 || requested.includes(name));
  return selected.map(name => {
    const script = scripts[`test:${name}`];
    if (!script?.startsWith(buildPrefix) || !script.slice(buildPrefix.length).trim()) {
      throw new Error(`test:${name} must start with ${JSON.stringify(buildPrefix)}; review the build-once runner.`);
    }
    return { name, command: script.slice(buildPrefix.length) };
  });
}

export function runSuites(scripts, requested, run) {
  // Validate every selection before building or starting any test process.
  const commands = commandsFor(scripts, requested);
  const buildStatus = run('build:server', 'npm run build:server');
  if (buildStatus !== 0) return buildStatus;
  for (const { name, command } of commands) {
    const status = run(`test:${name}`, command);
    if (status !== 0) return status;
  }
  return 0;
}

if (import.meta.main) {
  try {
    const { scripts } = JSON.parse(readFileSync('package.json', 'utf8'));
    process.exitCode = runSuites(scripts, process.argv.slice(2), (label, command) => {
      console.log(`\nRunning ${label}`);
      // The command comes only from the checked-in npm script, never CLI input.
      // npm supplies PATH and the working directory; shell expansion matches npm.
      const result = spawnSync(command, { shell: true, stdio: 'inherit' });
      if (result.error) console.error(result.error.message);
      if (result.signal) console.error(`${label} stopped by ${result.signal}`);
      return result.status ?? 1;
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
