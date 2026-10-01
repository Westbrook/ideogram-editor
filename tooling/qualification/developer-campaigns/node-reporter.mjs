import {caseIdentity, normalizeCasePath, contractsForCase} from './selectors.mjs';

// The ordinary TAP reporter can run alongside this one. No test is wrapped or
// replaced; records come from Node's documented test reporter event stream.
export default async function* reporter(events) {
  const method = process.env.QUALIFICATION_METHOD, occurrences = new Map(), discovered = []; let failed = false;
  const frameworkId = data => JSON.stringify([normalizeCasePath(process.cwd(), data.entryFile ?? data.file), data.testId]);
  for await (const event of events) {
    if (event.type === 'test:interrupted' || event.type === 'test:summary' && event.data.success !== true) failed = true;
    // Node 26 also enqueues the file wrapper, which has no entryFile and
    // reuses a child testId. Only actual cases belong in discovery.
    if (method === 'B' && event.type === 'test:enqueue' && event.data.type === 'test' && event.data.entryFile) {
      if (!Number.isSafeInteger(event.data.testId)) failed = true;
      discovered.push({id: frameworkId(event.data), file: normalizeCasePath(process.cwd(), event.data.file)});
    }
    if (['test:pass', 'test:fail'].includes(event.type) && event.data.details?.type !== 'suite') {
      const data = event.data;
      if (!data.file) { failed = true; continue; }
      const file = normalizeCasePath(process.cwd(), data.file), key = JSON.stringify([file, data.name]);
      const occurrence = (occurrences.get(key) ?? 0) + 1; occurrences.set(key, occurrence);
      const status = data.skip ? 'skipped' : data.todo ? 'todo' : event.type === 'test:pass' ? 'passed' : 'failed';
      if (status === 'failed' || status === 'todo') failed = true;
      yield JSON.stringify({type: 'case', id: caseIdentity(method, file, data.name, occurrence), method, file, name: data.name, occurrence,
        frameworkId: frameworkId(data), contracts: contractsForCase(method, file, data.name, occurrence), line: data.line, column: data.column, status, durationMs: data.details?.duration_ms}) + '\n';
    }
  }
  if (method === 'B') yield JSON.stringify({type: 'discovery', framework: 'node:test', ids: discovered.map(item => item.id), files: [...new Set(discovered.map(item => item.file))]}) + '\n';
  yield JSON.stringify({type: 'end', status: failed ? 'failed' : 'passed', framework: 'node:test'}) + '\n';
}
