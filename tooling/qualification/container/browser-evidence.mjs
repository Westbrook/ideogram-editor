import { createHash } from 'node:crypto';
import { chmod, readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { browserReportOutcome } from './browser-plan.mjs';
import { validateBrowserSelection } from '../developer-campaigns/selectors.mjs';

// Called after both successful and unsuccessful children. The raw observations
// remain available even when one reporter is missing or malformed.
export async function retainBrowserEvidence(step, output) {
  const evidence = { outcome: 'PASS', failures: [] };
  for (const [key, path, evaluate] of [
    ['browserReport', step.reportFile, bytes => browserReportOutcome(JSON.parse(bytes), step)],
    ['browserCases', step.caseReportFile, bytes => validateBrowserSelection(bytes.toString('utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)), step.files)],
  ]) {
    if (!path) { evidence.failures.push(`${key}:required-report-path-missing`); continue; }
    try {
      const bytes = await readFile(path);
      evidence[key] = { path: relative(output, path), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
      await chmod(path, 0o444);
      try { Object.assign(evidence[key], evaluate(bytes)); }
      catch (error) { evidence[key].outcome = 'INCONCLUSIVE'; evidence[key].error = String(error); }
      if (evidence[key].outcome !== 'PASS') evidence.failures.push(`${key}:${evidence[key].outcome}`);
    } catch (error) { evidence.failures.push(`${key}:${String(error)}`); }
  }
  if (evidence.failures.length) evidence.outcome = evidence.browserReport?.outcome === 'FAIL' || evidence.browserCases?.outcome === 'FAIL' ? 'FAIL' : 'INCONCLUSIVE';
  return evidence;
}
