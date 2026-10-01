import { createHash } from 'node:crypto';
import { readFileSync, lstatSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const digestJSON = value => sha256(JSON.stringify(value));

export function sourceIdentity(root) {
  const result = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw Error('Cannot enumerate source identity');
  const paths = [...new Set(result.stdout.split('\0').filter(path => /^(src\/|server\/|tooling\/|tests\/|docs\/spec\/|vendor\/|\.github\/workflows\/|\.npmrc$|\.progress-report\/project\.json$|index\.html$|package(?:-lock)?\.json$|tsconfig[^/]*\.json$|vite[^/]*\.ts$|AGENTS\.md$)/.test(path)))].sort();
  const files = paths.map(path => {
    try {
      const absolute = resolve(root, path);
      if (!lstatSync(absolute).isFile()) throw Error(`Source must be a regular file: ${path}`);
      const bytes = readFileSync(absolute);
      return { path, bytes: bytes.length, sha256: sha256(bytes) };
    } catch (error) {
      if (error.code === 'ENOENT') return { path, deleted: true };
      throw error;
    }
  });
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (head.status !== 0) throw Error('Cannot identify Git revision');
  return { head: head.stdout.trim(), digest: digestJSON(files), files };
}

// Deliberately construct rather than copy the ambient provider/proxy environment.
// Credentials and NODE_OPTIONS never enter a selected child process.
export function executionEnvironment(environment, pinnedBin, receiptDirectory) {
  const allowed = ['HOME', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL', 'DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'PLAYWRIGHT_BROWSERS_PATH'];
  const clean = Object.fromEntries(allowed.filter(key => environment[key] !== undefined).map(key => [key, environment[key]]));
  return { ...clean, PATH: `${pinnedBin}:${environment.PATH ?? '/usr/bin:/bin'}`, NO_COLOR: '1', CI: '1', QUEUE_EVIDENCE: `${receiptDirectory}/queue`, CANDIDATE_EVIDENCE: `${receiptDirectory}/candidates`, ADAPTER_EVIDENCE: `${receiptDirectory}/adapters`, TEXT_STATE_EVIDENCE: `${receiptDirectory}/text-state`, EDITOR_RECEIPT: `${receiptDirectory}/editor`, IE_RASTER_OUTPUT: `${receiptDirectory}/raster`, IE_HISTORY_OUTPUT: `${receiptDirectory}/history`, IE_RECOVERY_OUTPUT: `${receiptDirectory}/recovery`, TEXT_RECEIPT: `${receiptDirectory}/text`, SPECTRUM_OUTPUT: `${receiptDirectory}/spectrum`, QUALIFICATION_OUTPUT: receiptDirectory };
}

export function tapCounts(log) {
  const result = {};
  for (const field of ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...log.matchAll(new RegExp(`^# ${field} (\\d+)\\s*$`, 'gm'))];
    if (matches.length) result[field] = Number(matches.at(-1)[1]);
  }
  return result;
}

export function gateOutcome({ exitCode, signal, timedOut, interrupted, counts }, requireTests) {
  if (timedOut || interrupted || signal || exitCode !== 0 || (counts.fail ?? 0) > 0 || (counts.cancelled ?? 0) > 0) return 'FAIL';
  if (requireTests && (!Number.isInteger(counts.tests) || counts.tests <= 0 || !Number.isInteger(counts.pass))) return 'INCONCLUSIVE';
  if ((counts.skipped ?? 0) > 0 || (counts.todo ?? 0) > 0) return 'INCONCLUSIVE';
  if (requireTests && counts.pass !== counts.tests) return 'INCONCLUSIVE';
  return 'PASS';
}

export function receiptOutcome(gates, expectedIds, sourceBefore, sourceAfter) {
  if (gates.some(gate => gate.outcome === 'FAIL')) return 'FAIL';
  if (sourceBefore !== sourceAfter || gates.some(gate => gate.outcome !== 'PASS') || gates.length !== expectedIds.length || gates.some((gate, index) => gate.id !== expectedIds[index])) return 'INCONCLUSIVE';
  return 'PASS';
}

const safeRelative = path => typeof path === 'string' && path && !isAbsolute(path) && !path.includes('\\') && path.split('/').every(part => part && part !== '.' && part !== '..');
function verifyOutputTree(tree, readBytes, label) {
  if (!safeRelative(tree.output) || !Array.isArray(tree.files) || !tree.files.length || new Set(tree.files.map(file => file.path)).size !== tree.files.length || tree.files.some(file => !safeRelative(file.path))) throw Error(`Invalid fixture output manifest for ${label}`);
  if (tree.manifest?.path !== `${tree.output}.manifest.json`) throw Error(`Missing fixture output manifest for ${label}`);
  const bytes = readBytes(tree.manifest.path);
  if (bytes.length !== tree.manifest.bytes || sha256(bytes) !== tree.manifest.sha256) throw Error(`Fixture output manifest digest mismatch for ${label}`);
  const manifest = JSON.parse(bytes);
  if (manifest.kind !== 'qualification-preparation-output-1' || manifest.output !== tree.output || digestJSON(manifest.files) !== digestJSON(tree.files)) throw Error(`Fixture output inventory mismatch for ${label}`);
  for (const file of tree.files) {
    const bytes = readBytes(`${tree.output}/${file.path}`);
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw Error(`Fixture build digest mismatch for ${label}:${file.path}`);
  }
}

export function verifyReceipt(receipt, readBytes) {
  if (receipt.kind !== 'qualification-functional-run-1' || !Array.isArray(receipt.gates) || !Array.isArray(receipt.selected) || !receipt.selected.length || !Array.isArray(receipt.plan?.gates) || !receipt.plan.gates.length) throw Error('Unsupported or empty qualification receipt');
  if (new Set(receipt.selected).size !== receipt.selected.length) throw Error('Duplicate selected gate in receipt');
  if (digestJSON(receipt.plan.gates.map(gate => gate.id)) !== digestJSON(receipt.selected)) throw Error('Receipt selection differs from planned gates');
  if (digestJSON(receipt.identity.before.files) !== receipt.identity.before.digest || digestJSON(receipt.identity.after.files) !== receipt.identity.after.digest) throw Error('Source manifest digest mismatch');
  for (const [index, gate] of receipt.gates.entries()) {
    if (gate.id !== receipt.selected[index] || digestJSON(gate.command) !== digestJSON(receipt.plan.gates[index]?.command)) throw Error('Executed command differs from planned gate');
    if (digestJSON(gate.requiredEnvironment ?? {}) !== digestJSON(receipt.plan.gates[index]?.requiredEnvironment ?? {})) throw Error('Executed environment differs from planned gate');
    const bytes = readBytes(gate.log.path);
    if (bytes.length !== gate.log.bytes || sha256(bytes) !== gate.log.sha256) throw Error(`Log digest mismatch for ${gate.id}`);
    const counts = tapCounts(bytes.toString('utf8'));
    if (digestJSON(counts) !== digestJSON(gate.counts)) throw Error(`Counts mismatch for ${gate.id}`);
    if (gateOutcome({ ...gate, counts }, gate.id.startsWith('node:')) !== gate.outcome) throw Error(`Outcome mismatch for ${gate.id}`);
    for (const fixture of gate.fixturePrerequisites ?? []) {
      const bytes = readBytes(fixture.path);
      if (bytes.length !== fixture.bytes || sha256(bytes) !== fixture.sha256) throw Error(`Fixture prerequisite digest mismatch for ${gate.id}:${fixture.name}`);
    }
    if (gate.outcome === 'PASS' && receipt.plan.gates[index]?.completionPrerequisites) {
      const names = ['COMPLETION_APPLICATION_IDENTITY', 'COMPLETION_ISSUER_MANIFEST', 'PROTOCOL_OLD_MONITOR', 'HOST_HANDLER_CAPTURE'];
      if (digestJSON((gate.fixturePrerequisites ?? []).map(value => value.name).sort()) !== digestJSON(names.sort()) || gate.fixturePreparations?.length !== 2) throw Error(`Missing completion prerequisite closure for ${gate.id}`);
      for (const [role, required] of [['completion-issuers', ['application-identity.json', 'host-final-issuers.json', 'receipt.json']], ['completion-inputs', ['PROTOCOL_OLD_MONITOR.mjs', 'preparation.json', 'capture.log', 'handler-capture/result.json', 'handler-capture/first/result.json', 'handler-capture/independent/result.json']]]) {
        const trees = gate.fixturePreparations.filter(tree => tree.role === role);
        if (trees.length !== 1 || trees[0].output !== `${gate.id.replaceAll(':', '-')}-${role}` || required.some(path => !trees[0].files?.some(file => file.path === path))) throw Error(`Missing independent completion preparation for ${gate.id}:${role}`);
      }
      for (const [name, role, path] of [['COMPLETION_APPLICATION_IDENTITY', 'completion-issuers', 'application-identity.json'], ['COMPLETION_ISSUER_MANIFEST', 'completion-issuers', 'host-final-issuers.json'], ['PROTOCOL_OLD_MONITOR', 'completion-inputs', 'PROTOCOL_OLD_MONITOR.mjs'], ['HOST_HANDLER_CAPTURE', 'completion-inputs', 'handler-capture/first/result.json']]) {
        const input = gate.fixturePrerequisites.find(value => value.name === name), tree = gate.fixturePreparations.find(value => value.role === role), file = tree.files.find(value => value.path === path);
        if (input.path !== `${tree.output}/${path}` || input.bytes !== file.bytes || input.sha256 !== file.sha256) throw Error(`Completion input differs from sealed preparation for ${gate.id}:${name}`);
      }
    }
    for (const tree of gate.fixturePreparations ?? []) verifyOutputTree(tree, readBytes, `${gate.id}:${tree.role}`);
    if (gate.outcome === 'PASS' && receipt.plan.gates[index]?.fixtureBuild && !gate.fixtureBuild) throw Error(`Missing planned fixture producer for ${gate.id}`);
    if (gate.fixtureBuild) {
      if (gate.outcome === 'PASS' && (gate.fixtureBuild.code !== 0 || gate.fixtureBuild.signal || gate.fixtureBuild.timedOut || gate.fixtureBuild.interrupted || !gate.fixtureBuild.files?.length)) throw Error(`Incomplete fixture producer for ${gate.id}`);
      const planned = receipt.plan.gates[index]?.fixtureBuild;
      if (planned && gate.outcome === 'PASS') {
        const command = gate.fixtureBuild.command, expectedOutput = `${gate.id.replaceAll(':', '-')}-${planned.id}`;
        const executable = gate.fixtureBuild.executable;
        if (executable?.node !== '26.10.0' || !isAbsolute(executable.path ?? '') || !Number.isSafeInteger(executable.bytes) || executable.bytes <= 0 || !/^[a-f0-9]{64}$/.test(executable.sha256 ?? '') || command?.[0] !== executable.path) throw Error(`Fixture producer executable differs for ${gate.id}`);
        if (gate.fixtureBuild.output !== expectedOutput || !Array.isArray(command) || command.length !== 7 || typeof command[0] !== 'string' || !isAbsolute(command[0]) || digestJSON(command.slice(1, 6)) !== digestJSON(['node_modules/vite/bin/vite.js', 'build', '--config', planned.config, '--outDir']) || !isAbsolute(command[6]) || !command[6].endsWith(`/${expectedOutput}`)) throw Error(`Fixture producer command differs for ${gate.id}`);
      }
      if (gate.fixtureBuild.files?.length) verifyOutputTree(gate.fixtureBuild, readBytes, gate.id);
    }
  }
  const outcome = receiptOutcome(receipt.gates, receipt.selected, receipt.identity.before.digest, receipt.identity.after.digest);
  if (outcome !== receipt.outcome) throw Error('Receipt outcome mismatch');
  return { outcome, gates: receipt.gates.length, selected: receipt.selected.length, qualification: false, scope: receipt.scope };
}
