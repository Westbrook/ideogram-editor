import { test as base, expect } from '@playwright/test';
import { mkdtemp, realpath, readFile, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import type { startLocalServer as ServerFactory } from '../../server/http.js';
import type { launch as Launcher } from '../../tooling/launcher.js';
import type { measureD11StartupBuildBound } from '../../tooling/qualification/campaigns/browser-d11-startup-bound.mjs';

// Keep the offline AST/build census out of this process: the live local server's
// unchanged admission limits sample this process's RSS throughout later cases.
// Only the original final bound crosses the child boundary; no inventory or AST
// is returned, and the exact source/artifact/dependency verification still runs.
const startupAnalyses = new WeakMap<import('@playwright/test').Page, { close: () => Promise<void> }>();
async function isolatedStartupBuildBound(page: import('@playwright/test').Page): Promise<ReturnType<typeof measureD11StartupBuildBound>> {
  if (startupAnalyses.has(page)) throw Error('D11 analysis already owns this page');
  const repo = resolve('.'), input = JSON.stringify({ repo, cacheDirectory: process.env.IE_D11_NPM_CACHE });
  const source = [
    `import { loadD11Build } from ${JSON.stringify(pathToFileURL(resolve('tooling/qualification/campaigns/browser-d11-build.mjs')).href)};`,
    `import { measureD11StartupBuildBound } from ${JSON.stringify(pathToFileURL(resolve('tooling/qualification/campaigns/browser-d11-startup-bound.mjs')).href)};`,
    'const inventory = await loadD11Build(JSON.parse(process.argv[1]));',
    'const bound = measureD11StartupBuildBound(inventory);',
    'const effects = globalThis.__storeNetworkCounters.read();',
    "if (Object.keys(effects).length !== 8 || Object.values(effects).some(value => value !== 0)) throw Error('D11 analysis attempted a network effect');",
    'process.stdout.write(JSON.stringify(bound));',
  ].join('\n');
  let resolveResult!: (value: string) => void, rejectResult!: (error: Error) => void;
  const result = new Promise<string>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  // A timeout or buffer overflow kills this exact owned PID. Teardown below also
  // handles a Playwright interruption before the normal result await completes.
  const child = execFile(process.execPath, ['--import', resolve('tests/store/no-network.mjs'), '--input-type=module', '--eval', source, input],
    { cwd: repo, encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL' },
    (error, stdout) => { if (error) rejectResult(error); else resolveResult(stdout); });
  void result.catch(() => {});
  let exited = false, cleanup: Promise<void> | undefined;
  const closed = new Promise<void>(resolve => child.once('close', () => { exited = true; resolve(); }));
  const owner = { close: (): Promise<void> => cleanup ??= (async () => {
    if (!exited && child.pid !== undefined && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([closed, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(Error('D11 analysis child exit deadline')), 2000); })]); }
    finally { clearTimeout(timer); }
  })() };
  startupAnalyses.set(page, owner);
  try {
    const bound = JSON.parse(await result);
    if (!bound || typeof bound !== 'object' || Array.isArray(bound) || bound.kind !== 'd11-startup-build-upper-bound-1' || bound.qualification !== false) throw Error('D11 analysis returned an invalid bound');
    return bound;
  } finally {
    await owner.close();
    if (startupAnalyses.get(page) === owner) startupAnalyses.delete(page);
  }
}

// Exercise the same compiled server/worker entry points used by npm start.
// Playwright's source transform does not provide a worker-thread module loader.
const { startLocalServer }: { startLocalServer: typeof ServerFactory } = await import(pathToFileURL(resolve('dist/local/server/http.js')).href);
const { launch }: { launch: typeof Launcher } = await import(pathToFileURL(resolve('dist/local/tooling/launcher.js')).href);

type Server = Awaited<ReturnType<typeof startLocalServer>>;
const test = base.extend<{ local: { server: Server; advance: (ms: number) => void } }>({
  local: async ({}, use) => {
    let now = Date.now();
    const directory = await mkdtemp(join(await realpath(tmpdir()), 'ie-browser-'));
    const server = await startLocalServer({ root: join(directory, 'private'), staticDirectory: resolve('dist/app'), credentialConfigured: false, now: () => now });
    try { await use({ server, advance: ms => { now += ms; } }); } finally { await server.close(); }
  },
});
const output=process.env.IE_SHELL_OUTPUT??'artifacts';
test.beforeEach(async ({ context }) => {
  context.on('request',request=>{const url=new URL(request.url());expect(url.protocol==='blob:'||['127.0.0.1','localhost'].includes(url.hostname)).toBe(true);});
});
// Passive, bounded failure evidence. Never retain error/console text, request
// bodies, headers, cookies, URL queries/fragments or data URLs. Asset locations
// bind an error to the exact emitted build without serializing application data.
const shellDiagnostics = new WeakMap<import('@playwright/test').Page, { events: unknown[]; dropped: number }>();
const diagnosticAsset = (url: string) => {
  try { const parsed = new URL(url); return parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && /^\/assets\/[A-Za-z0-9_-]+\.(?:js|css)$/.test(parsed.pathname) ? parsed.pathname : null; } catch { return null; }
};
const diagnosticText = (text: string) => ({ characters: text.length, sha256: createHash('sha256').update(text).digest('hex') });

// Opt-in failure diagnosis only. A debugger pause cannot qualify timing or
// performance. This inspects the two already-settled proof outcomes at the sole
// emitted failure throw; it never invokes or mutates an application controller.
const commandProofDiagnostics = new WeakMap<import('@playwright/test').Page, { evidence: Record<string, unknown>; close: () => Promise<void> }>();
type CommandProofRemote = { type: string; subtype?: string; className?: string; objectId?: string; value?: unknown; description?: string };
const commandProofObjectGroup = 'shell-command-proof-diagnostics';
async function summarizeCommandProofs(session: import('@playwright/test').CDPSession, outcomes: CommandProofRemote, active: () => boolean) {
  const errorNames = ['Error', 'TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'EvalError', 'URIError', 'DOMException', 'AggregateError'];
  const idbNames = ['AbortError', 'ConstraintError', 'DataCloneError', 'DataError', 'InvalidAccessError', 'InvalidStateError', 'NotFoundError', 'QuotaExceededError', 'ReadOnlyError', 'TransactionInactiveError', 'UnknownError', 'VersionError'];
  let requests = 0, remaining = 8;
  const seen = new Set<string>();
  const own = async (value: CommandProofRemote | undefined, kind: 'array' | 'record' | 'error', keys: readonly string[]) => {
    if (!active() || !value?.objectId || value.type !== 'object' || value.subtype === 'proxy' || requests >= 24) return null;
    if (kind === 'array' ? value.subtype !== 'array' || value.className !== 'Array' : kind === 'record' ? value.className !== 'Object' || value.subtype !== undefined : value.subtype !== 'error' && value.className !== 'DOMException') return null;
    requests++;
    const response = await session.send('Runtime.getProperties', { objectId: value.objectId, ownProperties: true, generatePreview: false });
    // CDP has no response-byte pagination. These limits bound only traversal and
    // retained scalar output; raw descriptors remain transient and are not logged.
    if (!active() || response.exceptionDetails || response.result.length > 16) return null;
    const fields = new Map<string, CommandProofRemote>();
    for (const descriptor of response.result) if (descriptor.name.length <= 16 && keys.includes(descriptor.name) && descriptor.isOwn !== false && descriptor.value && !descriptor.get && !descriptor.set && !descriptor.wasThrown) fields.set(descriptor.name, descriptor.value);
    return fields;
  };
  const known = new Map([
    ['Invalid recovery data', 'INVALID_RECOVERY_DATA'], ['Projection changed in another tab', 'RECOVERY_PUBLICATION_CONFLICT'],
    ['Recovery is already active', 'RECOVERY_ALREADY_ACTIVE'], ['Duplicate event identity', 'DUPLICATE_EVENT_IDENTITY'],
    ['Duplicate asset', 'DUPLICATE_ASSET'], ['Invalid creation', 'INVALID_CREATION'], ['Unsupported event schema', 'UNSUPPORTED_EVENT_SCHEMA'],
    ['TRANSACTION_UNAVAILABLE', 'TRANSACTION_UNAVAILABLE'], ['TRANSACTION_CHANGED', 'TRANSACTION_CHANGED'], ['TRANSACTION_CORRUPT', 'TRANSACTION_CORRUPT'], ['TRANSACTION_INCOMPLETE', 'TRANSACTION_INCOMPLETE'],
    ['MODEL_MEMORY_ALLOWANCE', 'MODEL_MEMORY_ALLOWANCE'], ['MODEL_MEMORY_RELEASED', 'MODEL_MEMORY_RELEASED'], ['MODEL_CONTENT_LIMIT', 'MODEL_CONTENT_LIMIT'],
    ['ALLOCATION_BUDGET', 'ALLOCATION_BUDGET'], ['ALLOCATION_RELEASED', 'ALLOCATION_RELEASED'], ['ALLOCATION_INVALID', 'ALLOCATION_INVALID'],
    ['RECOVERY_RESPONSE_OWNER', 'RECOVERY_RESPONSE_OWNER'], ['RECOVERY_BODY', 'RECOVERY_BODY'], ['RECOVERY_WORKSPACE', 'RECOVERY_WORKSPACE'],
    ['RECOVERY_RELEASE_UNCONFIRMED: body', 'RECOVERY_BODY_RELEASE'], ['RECOVERY_RELEASE_UNCONFIRMED: reader', 'RECOVERY_READER_RELEASE'],
    ['COMMAND_RESULT_RELEASE_FAILED', 'COMMAND_RESULT_RELEASE_FAILED'], ['COMMAND_RECOVERY_RELEASE_UNCONFIRMED', 'COMMAND_RECOVERY_RELEASE_UNCONFIRMED'],
    ['COMMAND_EVENT_READ_FAILED', 'COMMAND_EVENT_READ_FAILED'], ['COMMAND_EVENT_READER_CLEANUP_FAILED', 'COMMAND_EVENT_READER_CLEANUP_FAILED'],
    ['PROMPT_READER_CLEANUP_FAILED', 'PROMPT_READER_CLEANUP_FAILED'], ['PROMPT_CONTENT_LENGTH', 'PROMPT_CONTENT_LENGTH'],
    ['The original command owner changed. Its journaled delivery remains available.', 'COMMAND_OWNER_CHANGED'],
    ['Recovery was cancelled.', 'RECOVERY_CANCELLED'], ['Model read was superseded.', 'MODEL_READ_SUPERSEDED'],
    ['Command result read was cancelled; its original receipt is retained.', 'COMMAND_READ_CANCELLED'],
  ]);
  const error = async (value: CommandProofRemote | undefined, depth: number): Promise<unknown> => {
    if (!active() || remaining <= 0 || depth > 3) return { truncated: true }; remaining--;
    if (!value?.objectId || value.type !== 'object' || value.subtype === 'proxy' || (value.subtype !== 'error' && value.className !== 'DOMException')) return { name: 'Other', unavailable: true };
    if (seen.has(value.objectId)) return { repeated: true }; seen.add(value.objectId);
    const name = errorNames.find(candidate => candidate === value.className) ?? 'Error';
    const fields = await own(value, 'error', ['message', 'name', 'stack', 'errors', 'cause']);
    if (!fields) return { name, unavailable: true };
    const message = fields.get('message')?.value, ownName = fields.get('name')?.value;
    const idbName = name !== 'DOMException' ? null : typeof ownName === 'string' && idbNames.includes(ownName) ? ownName : typeof value.description === 'string' ? idbNames.find(candidate => value.description!.startsWith(candidate + ':')) ?? null : null;
    const stackValue = fields.get('stack')?.value;
    // A native inspector description can contain the native error stack. It is
    // inspected only locally for fixed safe coordinates, never copied to evidence.
    const stack = typeof stackValue === 'string' ? stackValue : value.description;
    const locations: { path: string; line: number; column: number }[] = [];
    if (typeof stack === 'string' && stack.length <= 16384) for (const match of stack.matchAll(/http:\/\/127\.0\.0\.1:\d+(\/assets\/[A-Za-z0-9_-]+\.js):(\d+):(\d+)/g)) {
      const line = Number(match[2]), column = Number(match[3]);
      if (Number.isSafeInteger(line) && Number.isSafeInteger(column)) locations.push({ path: match[1], line, column }); if (locations.length === 4) break;
    }
    const summary: Record<string, unknown> = { name, idbName, code: typeof message === 'string' && message.length <= 256 ? known.get(message) ?? 'UNKNOWN' : 'UNKNOWN', messageCharacters: typeof message === 'string' ? message.length : null, locations };
    const children = fields.get('errors');
    if (children) {
      const entries = await own(children, 'array', ['length', '0', '1', '2', '3']), count = entries?.get('length')?.value;
      if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 && entries) {
        const errors: unknown[] = []; for (let index = 0; index < Math.min(4, count); index++) errors.push(await error(entries.get(String(index)), depth + 1));
        summary.errors = errors; summary.childrenTruncated = count > 4;
      } else summary.childrenUnavailable = true;
    }
    const cause = fields.get('cause'); if (cause) summary.cause = await error(cause, depth + 1);
    return summary;
  };
  const entries = await own(outcomes, 'array', ['length', '0', '1']);
  if (!entries || entries.get('length')?.value !== 2) return { shape: 'unavailable', descriptorRequests: requests };
  const branches: unknown[] = [];
  for (let index = 0; index < 2; index++) {
    const row = await own(entries.get(String(index)), 'record', ['status', 'reason']), status = row?.get('status')?.value;
    branches.push({ branch: index === 0 ? 'readCommandEvents' : 'sync', status: status === 'fulfilled' || status === 'rejected' ? status : 'unknown', ...(status === 'rejected' ? { failure: await error(row?.get('reason'), 0) } : {}) });
  }
  return { shape: 'two-settled-proofs', branches, descriptorRequests: requests };
}

async function readCommandProofDiagnosticFile(path: string, limit: number, privateMarker = false) {
  const file = await open(path, privateMarker ? constants.O_RDONLY | constants.O_NOFOLLOW : 'r');
  try {
    const before = await file.stat();
    if (privateMarker && (typeof process.getuid !== 'function' || before.uid !== process.getuid() || (before.mode & 0o077) !== 0 || before.nlink !== 1)) throw Error('COMMAND_PROOF_DIAGNOSTIC_MARKER_OWNER');
    if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size < 1 || before.size > limit) throw Error('COMMAND_PROOF_DIAGNOSTIC_SOURCE_BOUND');
    const bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) {
      const part = await file.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset);
      if (!part.bytesRead) throw Error('COMMAND_PROOF_DIAGNOSTIC_SOURCE_CHANGED'); offset += part.bytesRead;
    }
    const extra = await file.read(Buffer.alloc(1), 0, 1, offset), after = await file.stat();
    if (extra.bytesRead || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw Error('COMMAND_PROOF_DIAGNOSTIC_SOURCE_CHANGED');
    return bytes;
  } finally { await file.close(); }
}
async function commandProofDiagnosticOptIn(): Promise<{ assetSha256: string; markerSha256: string } | null> {
  let bytes: Buffer;
  try { bytes = await readCommandProofDiagnosticFile('artifacts/shell-command-proof-diagnostic-01.json', 1024, true); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const marker = JSON.parse(bytes.toString());
  if (!marker || typeof marker !== 'object' || Array.isArray(marker) || Object.keys(marker).sort().join(',') !== 'assetSha256,kind,outputDirectory' || marker.kind !== 'shell-command-proof-diagnostic-1' || typeof marker.assetSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(marker.assetSha256) || typeof marker.outputDirectory !== 'string' || marker.outputDirectory.length > 512) throw Error('COMMAND_PROOF_DIAGNOSTIC_MARKER');
  if (marker.outputDirectory !== resolve(output)) throw Error('COMMAND_PROOF_DIAGNOSTIC_MARKER_RUN');
  return { assetSha256: marker.assetSha256, markerSha256: createHash('sha256').update(bytes).digest('hex') };
}
async function installCommandProofDiagnostics(page: import('@playwright/test').Page, optIn: { assetSha256: string; markerSha256: string }) {
  const buildBytes = await readCommandProofDiagnosticFile('dist/app/build-evidence.json', 1024 ** 2), build = JSON.parse(buildBytes.toString());
  if (!Array.isArray(build.outputs) || build.outputs.length > 256) throw Error('COMMAND_PROOF_DIAGNOSTIC_BUILD_BOUND');
  const outputs = build.outputs.filter((row: { file: string }) => typeof row?.file === 'string' && /^assets\/[A-Za-z0-9_-]+\.js$/.test(row.file));
  let selected: { file: string; sha256: string; bytes: number; binding: string; offset: number; endOffset: number; line: number; column: number } | undefined;
  for (const row of outputs) {
    const bytes = await readCommandProofDiagnosticFile(resolve('dist/app', row.file), 4 * 1024 ** 2);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (row.bytes !== bytes.length || row.sha256 !== sha256) throw Error('COMMAND_PROOF_DIAGNOSTIC_BUILD_MISMATCH');
    const source = bytes.toString(), marker = source.indexOf('COMMAND_RESULT_PROOF_FAILED'); if (marker < 0) continue;
    if (selected || source.indexOf('COMMAND_RESULT_PROOF_FAILED', marker + 1) !== -1) throw Error('COMMAND_PROOF_DIAGNOSTIC_THROW_AMBIGUOUS');
    const offset = source.lastIndexOf('throw ', marker), prefix = source.slice(Math.max(0, marker - 2048), marker);
    const bindings = [...prefix.matchAll(/(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await Promise\.allSettled\(\[/g)], binding = bindings.at(-1)?.[1];
    if (!binding || !/^throw (?:new )?AggregateError\([A-Za-z_$][\w$]*\s*,\s*[`'"]$/.test(source.slice(offset, marker)) || !prefix.includes(binding + '[0].status') || !prefix.includes(binding + '.filter(')) throw Error('COMMAND_PROOF_DIAGNOSTIC_SCOPE_UNAVAILABLE');
    const before = source.slice(0, offset).split('\n'); selected = { file: row.file, sha256, bytes: bytes.length, binding, offset, endOffset: marker + 'COMMAND_RESULT_PROOF_FAILED'.length + 2, line: before.length - 1, column: before.at(-1)!.length };
  }
  if (!selected) throw Error('COMMAND_PROOF_DIAGNOSTIC_THROW_MISSING');
  if (selected.sha256 !== optIn.assetSha256) throw Error('COMMAND_PROOF_DIAGNOSTIC_MARKER_ASSET');
  const target = selected, session = await page.context().newCDPSession(page), evidence: Record<string, unknown> = { kind: 'command-proof-breakpoint-diagnostic-1', timingQualification: false, markerSha256: optIn.markerSha256, asset: target.file, assetSha256: target.sha256, assetBytes: target.bytes, throwOffset: target.offset, throwLine: target.line, throwColumn: target.column, buildEvidenceSha256: createHash('sha256').update(buildBytes).digest('hex'), captured: false };
  let breakpoint = '', observed = false, closed = false, paused = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined, cleanup: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (cleanup) return cleanup; closed = true; clearTimeout(watchdog);
    // Dispatch every cleanup operation before waiting. A stuck source/evaluate
    // response cannot prevent resume or detach from being requested.
    const attempts = [session.send('Debugger.setSkipAllPauses', { skip: true }).catch(() => {})];
    if (paused) { evidence.resumeRequested = true; attempts.push(session.send('Debugger.resume').then(() => { evidence.resumeAcknowledged = true; }).catch(() => {})); }
    if (breakpoint) attempts.push(session.send('Debugger.removeBreakpoint', { breakpointId: breakpoint }).catch(() => {}));
    attempts.push(session.send('Runtime.releaseObjectGroup', { objectGroup: commandProofObjectGroup }).then(() => { evidence.objectGroupReleased = true; }).catch(() => {}), session.send('Debugger.disable').catch(() => {}), session.detach().catch(() => {}));
    cleanup = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([Promise.allSettled(attempts), new Promise<void>(resolve => { timer = setTimeout(() => { evidence.cleanupDeadline = true; resolve(); }, 500); })]); }
      finally { clearTimeout(timer); }
    })(); return cleanup;
  };
  session.on('Debugger.paused', event => {
    paused = true;
    if (closed || observed) { if (observed) evidence.unexpectedPause = true; void close(); return; }
    watchdog = setTimeout(() => { evidence.capture = 'pause-deadline'; void close(); }, 1000);
    void (async () => {
      try {
        if (observed || !event.hitBreakpoints?.includes(breakpoint)) { evidence.unexpectedPause = true; return; } observed = true;
        await session.send('Debugger.setSkipAllPauses', { skip: true }); if (closed) return;
        const frame = event.callFrames[0]; if (!frame) { evidence.capture = 'frame-unavailable'; return; }
        const actual = await session.send('Debugger.getScriptSource', { scriptId: frame.location.scriptId }); if (closed) return;
        if (Buffer.byteLength(actual.scriptSource) !== target.bytes || createHash('sha256').update(actual.scriptSource).digest('hex') !== target.sha256) { evidence.capture = 'script-identity-mismatch'; return; }
        const column = frame.location.columnNumber;
        if (typeof column !== 'number' || !Number.isSafeInteger(column) || column < 0) { evidence.capture = 'throw-location-unavailable'; return; }
        const lines = actual.scriptSource.split('\n'), at = lines.slice(0, frame.location.lineNumber).reduce((n, line) => n + line.length + 1, 0) + column;
        if (at < target.offset || at > target.endOffset) { evidence.capture = 'throw-location-mismatch'; return; }
        const result = await session.send('Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrameId, expression: target.binding, objectGroup: commandProofObjectGroup, returnByValue: false, generatePreview: false, silent: true, throwOnSideEffect: true, timeout: 250 }); if (closed) return;
        if (result.exceptionDetails || result.result.type !== 'object' || !result.result.objectId) { evidence.capture = 'binding-unavailable'; return; }
        const proofs = await summarizeCommandProofs(session, result.result, () => !closed); if (closed) return;
        evidence.proofs = proofs; evidence.captured = proofs.shape === 'two-settled-proofs'; if (!evidence.captured) evidence.capture = 'property-read-unavailable';
      } catch { if (!closed) evidence.capture = 'protocol-unavailable'; }
      finally { await close(); }
    })();
  });
  commandProofDiagnostics.set(page, { evidence, close });
  try {
    await session.send('Debugger.enable'); await session.send('Debugger.setPauseOnExceptions', { state: 'none' });
    const escaped = ('/' + target.file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const result = await session.send('Debugger.setBreakpointByUrl', { urlRegex: '^http://127\\.0\\.0\\.1:[0-9]+' + escaped + '$', lineNumber: target.line, columnNumber: target.column, condition: target.binding + '[0].status === "rejected" || ' + target.binding + '[1].status === "rejected"' }); breakpoint = result.breakpointId;
  } catch (error) { await close(); throw error; }
}

test.beforeEach(async ({ page }, info) => {
  if (info.title.startsWith('B02 ') && page.context().browser()?.browserType().name() === 'chromium') {
    const optIn = await commandProofDiagnosticOptIn(); if (optIn) await installCommandProofDiagnostics(page, optIn);
  }
  const record = { events: [] as unknown[], dropped: 0 }; shellDiagnostics.set(page, record);
  const add = (event: unknown) => { if (record.events.length < 128) record.events.push(event); else record.dropped++; };
  page.on('pageerror', error => {
    const locations: { path: string; line: number; column: number }[] = [];
    for (const match of (error.stack ?? '').matchAll(/http:\/\/127\.0\.0\.1:\d+(\/assets\/[A-Za-z0-9_-]+\.js):(\d+):(\d+)/g)) { locations.push({ path: match[1], line: Number(match[2]), column: Number(match[3]) }); if (locations.length === 8) break; }
    add({ kind: 'pageerror', name: ['Error', 'TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'DOMException', 'AggregateError'].includes(error.name) ? error.name : 'Other', message: diagnosticText(error.message), locations });
  });
  page.on('console', message => { if (message.type() !== 'error') return; const location = message.location(); add({ kind: 'console-error', message: diagnosticText(message.text()), path: diagnosticAsset(location.url), line: location.lineNumber, column: location.columnNumber }); });
  page.on('request', request => { const path = diagnosticAsset(request.url()); if (path) add({ kind: 'asset-request', path }); });
  page.on('response', response => { const path = diagnosticAsset(response.url()); if (path) add({ kind: 'asset-response', path, status: response.status() }); });
  page.on('requestfailed', request => { const path = diagnosticAsset(request.url()); if (path) add({ kind: 'asset-failed', path, failure: diagnosticText(request.failure()?.errorText ?? '') }); });
});
test.afterEach(async ({ page }, info) => {
  await startupAnalyses.get(page)?.close();
  const commandProof = commandProofDiagnostics.get(page);
  if (commandProof) { await commandProof.close(); await info.attach('shell-command-proof-diagnostics', { body: JSON.stringify(commandProof.evidence, null, 2), contentType: 'application/json' }); }
  if (info.status === info.expectedStatus) return;
  const record = shellDiagnostics.get(page);
  const dom = page.isClosed() ? { closed: true } : await page.evaluate(() => {
    const dialog = document.querySelector('en-dialog#editor-dialog') as (HTMLElement & { open?: boolean }) | null;
    const surface = dialog?.shadowRoot?.querySelector('dialog'), root = surface?.getRootNode();
    const heading = root instanceof ShadowRoot ? root.querySelector('#en-overlay-heading') : null;
    const slot = heading?.querySelector('slot');
    let parentRoot: Node | undefined = surface ?? undefined;
    while (parentRoot?.parentNode) parentRoot = parentRoot.parentNode;
    let escapedReferenceResolves = false;
    try { escapedReferenceResolves = parentRoot instanceof ShadowRoot && parentRoot.querySelector('#' + CSS.escape('en-overlay-heading')) === heading; } catch { /* Preserve a false scalar; never alter the reference. */ }
    const style = (element: Element | null | undefined) => element ? { display: getComputedStyle(element).display, visibility: getComputedStyle(element).visibility, ariaHidden: element.getAttribute('aria-hidden') } : null;
    return {
      nameReference: {
        labelledByMatches: surface?.getAttribute('aria-labelledby') === 'en-overlay-heading', hasAriaLabel: surface?.hasAttribute('aria-label') ?? false,
        rootIsHostShadow: !!surface && root === dialog?.shadowRoot,
        headingCount: root instanceof ShadowRoot ? root.querySelectorAll('#en-overlay-heading').length : null,
        headingIsNewDocument: heading?.textContent?.trim() === 'New document', slotFallbackIsNewDocument: slot?.textContent?.trim() === 'New document',
        assignedNodes: slot?.assignedNodes().length ?? null, headingStyle: style(heading), slotStyle: style(slot),
        escapedReferenceResolves, assignedLabelIsNewDocument: slot?.assignedNodes().some(node => node.textContent?.trim() === 'New document') ?? false,
        fallbackChildren: [...(slot?.childNodes ?? [])].slice(0, 8).map(node => ({ type: node.nodeType, assigned: !!(node as Text).assignedSlot, textIsNewDocument: node.textContent?.trim() === 'New document' })),
        nativeInert: surface?.inert ?? null, nativeModal: surface?.matches(':modal') ?? null,
      },
      operationBusy: document.querySelector('[aria-label="Operation status"]')?.getAttribute('aria-busy') ?? null,
      editorDialogExists: !!dialog, editorDialogDefined: dialog?.matches(':defined') ?? false,
      editorDialogOpen: typeof dialog?.open === 'boolean' ? dialog.open : null,
      nativeDialogOpen: dialog?.shadowRoot?.querySelector('dialog')?.open ?? null,
      newNameExists: !!document.querySelector('#new-name'), newWidthExists: !!document.querySelector('#new-width'),
      newIntentRecorded: performance.getEntriesByName('ie.intent.Open new', 'mark').length > 0,
      newCompletionRecorded: performance.getEntriesByName('ie.complete.Open new', 'mark').length > 0,
    };
  }).catch(() => ({ unavailable: true }));
  const namedRoleCounts = page.isClosed() ? null : await Promise.all([
    page.getByRole('dialog', { name: 'New document', exact: true }).count(),
    page.getByRole('dialog', { name: 'New document', exact: true, includeHidden: true }).count(),
  ]).then(([normal, includingHidden]) => ({ normal, includingHidden })).catch(() => null);
  // Read the native AX node independently of Playwright's role-name resolver.
  // Only the fixed surface is evaluated; no application methods are called.
  let nativeAX: unknown = { unavailable: true };
  if (!page.isClosed() && page.context().browser()?.browserType().name() === 'chromium') {
    const session = await page.context().newCDPSession(page).catch(() => null);
    if (session) try {
      const { result } = await session.send('Runtime.evaluate', { expression: "document.querySelector('en-dialog#editor-dialog')?.shadowRoot?.querySelector('dialog')", objectGroup: 'shell-panel-diagnostics', returnByValue: false });
      if (result.objectId) {
        const { nodes } = await session.send('Accessibility.getPartialAXTree', { objectId: result.objectId, fetchRelatives: false });
        const node = nodes.find(value => value.role?.value === 'dialog');
        nativeAX = node ? {
          ignored: node.ignored, nameIsNewDocument: node.name?.value === 'New document', name: diagnosticText(typeof node.name?.value === 'string' ? node.name.value : ''),
          nameSourceCount: node.name?.sources?.length ?? 0,
          nameSources: node.name?.sources?.slice(0, 8).map(source => ({
            type: ['attribute', 'implicit', 'style', 'contents', 'placeholder', 'relatedElement'].includes(source.type) ? source.type : 'Other',
            attribute: ['aria-labelledby', 'aria-label', 'title'].includes(source.attribute ?? '') ? source.attribute : null,
            invalid: source.invalid ?? false, superseded: source.superseded ?? false,
            invalidReason: diagnosticText(source.invalidReason ?? ''),
            relatedNodes: (source.attributeValue?.relatedNodes ?? source.value?.relatedNodes ?? []).slice(0, 8).map(related => ({ headingReference: related.idref === 'en-overlay-heading', textIsNewDocument: related.text === 'New document', backendNodeId: related.backendDOMNodeId })),
          })) ?? [],
        } : { dialogNode: false };
      } else nativeAX = { dialogNode: false };
    } catch { nativeAX = { unavailable: true }; }
    finally { await session.send('Runtime.releaseObjectGroup', { objectGroup: 'shell-panel-diagnostics' }).catch(() => {}); await session.detach().catch(() => {}); }
  }
  await info.attach('shell-safe-diagnostics', { body: JSON.stringify({ ...record, dom, namedRoleCounts, nativeAX }, null, 2), contentType: 'application/json' });
});
async function paired(page: import('@playwright/test').Page, server: Server, flag = false) {
  const link = new URL(server.issuePairingURL()); if (flag) link.search = '?progress-report';
  await Promise.all([page.waitForResponse(response => response.url() === server.origin + '/api/v1/session/bootstrap'), page.goto(link.href)]);
  await expect(page.getByRole('button', { name: 'Connected locally', exact: true })).toBeVisible();
  await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();
}

// Request drafts belong to a real local document. Pairing an empty root does
// not manufacture a document or expose an unowned native prompt.
async function newRequestDocument(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New document', exact: true });
  await expect(dialog).toBeVisible();
  // Authored fields/footer are slotted from the public component host; they
  // are not DOM descendants of its native shadow-root dialog.
  const controls = page.locator('en-dialog#editor-dialog');
  for (const [name, value] of [['Width (px)', '128'], ['Height (px)', '96']]) {
    const field = controls.getByRole('spinbutton', { name, exact: true });
    await field.fill(value); await field.press('Tab');
  }
  const creation = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/commands' && request.postDataJSON()?.command?.body?.type === 'CreateDocument');
  await controls.getByRole('button', { name: 'Create', exact: true }).click();
  const documentId = (await creation).postDataJSON().command.documentId as string;
  expect(documentId).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Close document', exact: true })).toBeEnabled();
  await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('');
  return documentId;
}

test('B01 launcher, native bootstrap ordering, strict cookie, reload and startup bytes', async ({ page, context }, info) => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'ie-launch-browser-'));
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(() => {
    const observations = { cleaned: 0, fetches: [] as { path: string; hash: string; consumed: boolean }[] };
    Object.defineProperty(window, '__testObservations', { value: observations });
    const replace = history.replaceState.bind(history);
    history.replaceState = (...args) => { replace(...args); observations.cleaned = performance.now(); };
    const fetchOriginal = window.fetch;
    window.fetch = (...args) => {
      observations.fetches.push({ path: String(args[0]), hash: location.hash, consumed: !Object.hasOwn(window, '__IE_PAIRING__') });
      return fetchOriginal(...args);
    };
  });
  let first = '';
  const logs: string[] = [];
  const server = await launch({ root: join(directory, 'private'), staticDirectory: resolve('dist/app'), log: line => logs.push(line), openBrowser: async link => { first = link; await page.goto(link); } });
  try {
    await expect(page.getByRole('button', { name: 'Connected locally', exact: true })).toBeVisible();
    const observations = await page.evaluate(() => {
      const state = (window as unknown as { __testObservations: { cleaned: number; fetches: unknown[] } }).__testObservations;
      return { ...state, resources: performance.getEntriesByType('resource').map(item => ({ path: new URL(item.name).pathname, start: item.startTime })), hash: location.hash, hasPairing: Object.hasOwn(window, '__IE_PAIRING__'), storage: [localStorage.length, sessionStorage.length], cookie: document.cookie };
    });
    expect(observations.hash).toBe(''); expect(observations.hasPairing).toBe(false); expect(observations.storage[0]).toBe(0); expect(observations.storage[1]).toBeLessThanOrEqual(1); expect(observations.cookie).toBe('');
    expect(observations.fetches.slice(0,2)).toEqual([{ path: '/api/v1/session/bootstrap', hash: '', consumed: true }, { path: '/api/v1/capabilities', hash: '', consumed: true }]);
    for (const resource of observations.resources) expect(resource.start, resource.path).toBeGreaterThanOrEqual(observations.cleaned);
    const cookies = await context.cookies(); expect(cookies).toHaveLength(1); expect(cookies[0].httpOnly).toBe(true); expect(cookies[0].sameSite).toBe('Strict');
    expect(logs.join('\n').includes(first.split('#')[1])).toBe(false);
    const dom = await page.content(); expect(dom.includes(first.split('pairing=')[1])).toBe(false);
    await page.reload(); await expect(page.getByRole('button', { name: 'Connected locally', exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __testObservations: {fetches: {path:string}[]} }).__testObservations.fetches.slice(0,2).map(x => x.path))).toEqual(['/api/v1/session', '/api/v1/capabilities']);
    expect(errors).toEqual([]);
    const build = JSON.parse(await readFile('dist/app/build-evidence.json', 'utf8'));
    // The original producer fields include every reachable dynamic descendant.
    // Retain that diagnostic verbatim; the cap uses a separately proved whole-
    // artifact startup upper bound for D11's fixed W0/W1 context. This B01 visit
    // remains a bootstrap/security check, not the real W0/W1 evaluation audit.
    await info.attach('D11-all-reachable-build-diagnostic', { body: JSON.stringify({ scope: 'Conservative all-reachable build diagnostic including dynamic descendants', observations: build.observations.D11 }, null, 2), contentType: 'application/json' });
    const startupBound = await isolatedStartupBuildBound(page);
    await info.attach('D11-static-startup-build-upper-bound', { body: JSON.stringify(startupBound, null, 2), contentType: 'application/json' });
    expect(startupBound.status, JSON.stringify({ missing: startupBound.missing, failures: startupBound.failures, budgets: startupBound.artifactBuildBudgets, violations: startupBound.artifactBuildViolations })).toBe('PASS');
    expect(startupBound.bounds?.jsRawBytes).toBeLessThan(1.5 * 1024 * 1024);
    expect(startupBound.bounds?.jsGzipBytes).toBeLessThan(500 * 1024);
    expect(startupBound.bounds?.uiCssFontGzipBytes).toBeLessThan(200 * 1024);
    const manifests=build.outputs.filter((x:{file:string})=>/^assets\/profile-[A-Za-z0-9_-]{8}\.json$/.test(x.file));
    expect(manifests).toHaveLength(1);
    expect(await readFile('dist/app/'+manifests[0].file)).toEqual(await readFile('src/text/profile.json'));
    expect(observations.resources.some((x:{path:string})=>x.path.endsWith('/'+manifests[0].file))).toBe(false);
    expect(build.outputs.flatMap((x:{modules:string[]})=>x.modules).some((x:string)=>x.endsWith('profile.json?raw'))).toBe(false);
    expect(build.outputs.flatMap((x: {modules:string[]}) => x.modules).some((x:string) => /prosemirror|server\/|tooling\/launcher|elements\/dist\/index.js/.test(x))).toBe(false);
    await info.attach('bootstrap-observations', { body: JSON.stringify(observations, null, 2), contentType: 'application/json' });
    await page.screenshot({ path: output+'/shell-desktop-1440.png' });
  } finally { await server.close(); }
});

test('B02 real native prompt drafts, inert text, selection and composition-safe shortcuts', async ({ page, local }) => {
  await paired(page, local.server); const documentId = await newRequestDocument(page);
  const calls: { path: string; type: string; localDraftWork: boolean }[] = [], draftStages = new Set<string>();
  page.on('request', request => {
    if (request.method() !== 'POST') return;
    const path = new URL(request.url()).pathname, body = request.postDataJSON();
    const draftStage = path === '/api/v1/assets/staging' && body?.protocolVersion === 1 && ['text', 'caption'].includes(body.purpose);
    if (draftStage) draftStages.add(body.stagingId);
    // Native editing saves exact local draft assets/UI; it never reviews,
    // accepts, queues or authorizes a provider request as a side effect.
    const localDraftWork = draftStage
      || path === '/api/v1/commands' && body?.command?.body?.type === 'FinalizeStaging' && body.command.documentId === null && draftStages.has(body.command.body.stagingId)
      || /^\/api\/v1\/ui\/[A-Za-z0-9_-]+$/.test(path) && body?.body?.type === 'SaveDraft' && ['request', 'composition'].includes(body.body.draft.kind) && body.body.draft.documentId === documentId
      || /^\/api\/v1\/recovery\/[A-Za-z0-9_-]+\/release$/.test(path) && body?.protocolVersion === 1;
    calls.push({ path, type: body?.command?.body?.type ?? (body?.body?.type === 'SaveDraft' ? 'SaveDraft:'+body.body.draft.kind : body?.body?.type) ?? body?.purpose ?? '', localDraftWork });
  });
  const prompt = page.getByRole('textbox', { name: 'Prompt', exact: true });
  const hostile = '<img src=x onerror="window.pwned=1">\nשלום 日本語 & untouched';
  await prompt.fill(hostile);
  await prompt.evaluate(node => (node as HTMLTextAreaElement).setSelectionRange(2, 9, 'backward'));
  await page.getByRole('tab', { name: 'Jobs' }).click();
  expect(await prompt.evaluate(node => { const n = node as HTMLTextAreaElement; return [n.selectionStart, n.selectionEnd, n.selectionDirection]; })).toEqual([2, 9, 'backward']);
  await prompt.focus(); await page.keyboard.press('End'); await page.keyboard.type('hz');
  await expect(page.getByRole('button', { name: 'Pan' })).toHaveAttribute('aria-pressed', 'true');
  await prompt.dispatchEvent('compositionstart');
  await prompt.dispatchEvent('keydown', { key: 'z', bubbles: true, composed: true, isComposing: true });
  await prompt.dispatchEvent('compositionend');
  await expect(page.getByRole('button', { name: 'Pan' })).toHaveAttribute('aria-pressed', 'true');
  const edited = await prompt.inputValue();
  await page.getByLabel('Operation', { exact: true }).selectOption({ label: 'Generate with Fast' });
  await expect(prompt).toHaveValue(edited); await prompt.fill('A separate Fast draft');
  await page.getByLabel('Operation', { exact: true }).selectOption({ label: 'Generate image' });
  await expect(prompt).toHaveValue(edited);
  await page.getByLabel('Operation', { exact: true }).selectOption({ label: 'Generate with Fast' });
  await expect(prompt).toHaveValue('A separate Fast draft');
  await page.getByLabel('Operation', { exact: true }).selectOption({ label: 'Generate image' });
  await expect(prompt).toHaveValue(edited);
  expect(await page.evaluate(() => Object.hasOwn(window, 'pwned'))).toBe(false);
  expect(await page.locator('ie-shell img').count()).toBe(0);
  await expect(page.getByRole('button', { name: 'Review exact request', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Enqueue accepted request', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Live provider', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh provider and eligible jobs', exact: true }).click();
  await expect(page.getByText('Provider: Disabled. No server credential configured.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Review live dispatch for / })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Import image', exact: true })).toBeEnabled();
  await expect(page.locator('footer')).toContainText('Draft saved locally');
  expect(calls.some(call => call.type === 'SaveDraft:request')).toBe(true);
  expect(calls.filter(call => !call.localDraftWork)).toEqual([]);
});

test('B03 keyboard panels, roving tool focus, resize and collapsed content', async ({ page, local }) => {
  await paired(page, local.server);
  const errors: string[] = []; page.on('console', m => {if(m.type()==='error') errors.push(m.text());});
  await page.getByRole('button', { name: 'Pan' }).focus(); await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('button', { name: 'Zoom' })).toBeFocused();
  await page.keyboard.press('Enter'); await expect(page.getByRole('button', { name: 'Zoom' })).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#canvas').focus(); await page.keyboard.press('h'); await expect(page.getByRole('button', { name: 'Pan' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('tab', { name: 'Results' }).focus(); await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Jobs' })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Inspect durable jobs', exact: true })).toBeVisible();
  const activity = page.getByRole('region', { name: 'Activity', exact: true });
  const activityToggle = activity.getByRole('button', { name: 'Activity', exact: true });
  await expect(activityToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(activity.locator('en-tabs')).toBeVisible();
  await activityToggle.click();
  await expect(activityToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(activity.locator('en-tabs')).toBeHidden();
  await expect(activityToggle).toBeFocused();
  await activityToggle.press('Enter');
  await expect(activityToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(activity.locator('en-tabs')).toBeVisible();
  await page.getByRole('tab', { name: 'Composition', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Semantic element inspector', exact: true })).toBeVisible();
  await expect(page.getByText('Select a Composition element. This does not select a native layer.', { exact: true })).toBeVisible();
  const splitter = page.getByRole('separator', { name: 'Request panel width' }).first();
  const width = (await page.locator('#request').boundingBox())!.width;
  await splitter.focus(); await page.keyboard.press('ArrowRight');
  expect((await page.locator('#request').boundingBox())!.width).toBeGreaterThan(width);
  await expect(page.getByText('Shortcuts and recovery',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Help',exact:true}).hover();await page.getByRole('button',{name:'Help',exact:true}).focus();const ax=await(await page.context().newCDPSession(page)).send('Accessibility.getFullAXTree');expect(ax.nodes.filter(n=>n.role?.value==='button'&&n.name?.value==='Help').map(n=>n.description?.value)).toEqual(['Shortcuts and recovery']);await page.getByRole('button', { name: 'Help' }).click();
  await page.keyboard.press('Escape'); await expect(page.getByRole('button', { name: 'Help' })).toBeFocused();
  expect(errors).toEqual([]);
});

test('B04 renew, stale CSRF/cookie rejection, revoke, expiry and fresh local pairing', async ({ page, context, local }) => {
  await paired(page, local.server);
  const oldCookies = await context.cookies();
  const oldCsrf = await page.evaluate(async () => (await (await fetch('/api/v1/session', { headers: { 'X-App-Client': 'LP-1' } })).json()).csrfToken as string);
  await page.getByRole('button', { name: 'Connected locally', exact: true }).click();
  await page.getByRole('button', { name: 'Renew connection', exact: true }).click();
  await expect(page.getByText('Connected to your local workspace.', {exact:true})).toBeVisible();
  const rejected = await page.evaluate(async token => (await fetch('/api/v1/session/renew', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-CSRF': token }, body: JSON.stringify({ protocolVersion: 1 }) })).status, oldCsrf);
  expect(rejected).toBe(403);
  const currentCookies = await context.cookies();
  await context.addCookies(oldCookies);
  const stale = await page.evaluate(async () => (await fetch('/api/v1/session', { headers: { 'X-App-Client': 'LP-1' } })).status);
  expect(stale).toBe(401); await context.addCookies(currentCookies);
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pairing needed', exact: true })).toBeVisible();
  await paired(page, local.server);
  local.advance(30 * 60 * 1000);
  if (!(await page.getByRole('button', { name: 'Check connection', exact: true }).isVisible())) await page.getByRole('button', { name: 'Connected locally', exact: true }).click();
  await page.getByRole('button', { name: 'Check connection', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pairing needed', exact: true })).toBeVisible();
  await paired(page, local.server);
  const expired = local.server.issuePairingURL(); local.advance(5 * 60 * 1000);
  await page.goto(expired); await expect(page.getByRole('button', { name: 'Pairing needed', exact: true })).toBeVisible();
  await paired(page, local.server);
});

test('B05 browser-controlled hostile origin, null origin, navigation and no marker reads', async ({ page, context, local }, info) => {
  await paired(page, local.server);
  expect(await page.evaluate(async () => (await fetch('/api/v1/session')).status)).toBe(403);
  const statuses: number[] = [];
  const hostile = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Hostile origin test</title>'); });
  await new Promise<void>(resolve => hostile.listen(0, '127.0.0.1', resolve));
  const address = hostile.address() as {port:number};
  const attacker = await context.newPage();
  const cdp = await context.newCDPSession(attacker);
  await cdp.send('Network.enable');
  const ids = new Set<string>();
  cdp.on('Network.requestWillBeSent', e => { if(e.request.url.startsWith(local.server.origin + '/api')) ids.add(e.requestId); });
  cdp.on('Network.responseReceivedExtraInfo', e => { if(ids.has(e.requestId)) statuses.push(e.statusCode); });
  try {
    await attacker.goto(`http://localhost:${address.port}`);
    const outcome = await attacker.evaluate(async origin => {
      const outcomes: string[] = [];
      for (const init of [{}, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"protocolVersion":1}' }]) {
        try { const result = await fetch(origin + '/api/v1/session/revoke', { ...init, credentials: 'include', mode: 'no-cors' }); outcomes.push(result.type); } catch { outcomes.push('blocked'); }
      }
      return outcomes;
    }, local.server.origin);
    expect(outcome.every(x => x === 'opaque' || x === 'blocked')).toBe(true);
    await expect.poll(() => statuses.length).toBe(2);
    await attacker.goto('data:text/html,<title>Opaque origin security probe</title>');
    const nullOriginOutcome = await attacker.evaluate(async origin => { try { const response = await fetch(origin + '/api/v1/session/revoke', { method:'POST', mode:'no-cors', credentials:'include', body:'{}' }); return response.type; } catch { return 'blocked-before-response'; } }, local.server.origin);
    expect(['opaque', 'blocked-before-response']).toContain(nullOriginOutcome);
    if (nullOriginOutcome === 'opaque') await expect.poll(() => statuses.length).toBe(3);
    expect(statuses.every(status => status === 403)).toBe(true);
    await page.reload(); await expect(page.getByRole('button', { name: 'Connected locally', exact:true })).toBeVisible();
    const nav = await context.newPage(); const response = await nav.goto(local.server.origin + '/api/v1/session'); expect(response?.status()).toBe(403); await nav.close();
    await info.attach('hostile-browser-outcomes', {body:JSON.stringify({statuses,outcome,nullOriginOutcome}),contentType:'application/json'});
  } finally { await attacker.close(); await new Promise<void>(resolve => hostile.close(() => resolve())); }
});

test('B06 320px and 200% equivalent reflow, draft retention, named drawers and focus return', async ({ page, local }) => {
  await paired(page, local.server); await newRequestDocument(page);
  await page.getByRole('textbox', { name:'Prompt',exact:true }).fill('Keep this draft through reflow');
  await page.setViewportSize({width:720,height:450});
  await expect(page.getByRole('textbox', {name:'Prompt',exact:true})).toBeFocused();
  await expect(page.getByRole('button', {name:'Hide request',exact:true})).toBeVisible();
  await expect(page.getByRole('textbox', {name:'Prompt',exact:true})).toHaveValue('Keep this draft through reflow');
  await page.screenshot({path:output+'/shell-reflow-720.png',fullPage:true});
  await page.setViewportSize({width:320,height:800});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(320);
  await page.getByRole('textbox', {name:'Prompt',exact:true}).focus();
  await page.getByRole('button', {name:'Hide request',exact:true}).click();
  await page.getByRole('button', {name:'Show layers',exact:true}).click();
  await page.getByRole('tab',{name:'Composition',exact:true}).click();
  await page.getByRole('button',{name:'Hide layers',exact:true}).click();
  await page.getByRole('button', {name:'Show request',exact:true}).click();
  await page.screenshot({path:output+'/shell-reflow-320.png',fullPage:true});
  const skipViewport=page.viewportSize();if(!skipViewport)throw Error('The skip-link fixture requires its configured viewport.');
  const destinations=[['results','History'],['inspector','Layers'],['canvas','Canvas'],['request','Request']] as const,newButton=page.locator('.document-bar').getByRole('button',{name:'New',exact:true});
  const skipGeometry=()=>page.locator('.skip-links').evaluate(region=>{
    const hosts=[...region.querySelectorAll<HTMLElement>('en-link')];if(hosts.length!==4)throw Error('Expected the four public skip links.');
    const box=(element:Element)=>{const rect=element.getBoundingClientRect();return {left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,width:rect.width,height:rect.height};};
    return {width:innerWidth,height:innerHeight,clientWidth:window.document.documentElement.clientWidth,scrollWidth:window.document.documentElement.scrollWidth,links:hosts.map(host=>{const anchor=host.shadowRoot?.querySelector<HTMLAnchorElement>('a');if(!anchor)throw Error('Expected the native skip-link anchor.');const style=getComputedStyle(anchor),range=window.document.createRange();range.selectNodeContents(host);const labelRects=range.getClientRects(),labelCount=labelRects.length,labels=Array.from({length:Math.min(labelCount,8)},(_,index)=>{const rect=labelRects[index]!;return {left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,width:rect.width,height:rect.height};});range.detach();return {labelCount,labels,target:anchor.getAttribute('href'),focused:host.shadowRoot?.activeElement===anchor,focusVisible:anchor.matches(':focus-visible'),outlineStyle:style.outlineStyle,outlineWidth:Number.parseFloat(style.outlineWidth),clearance:Math.max(0,Number.parseFloat(style.outlineWidth)+Number.parseFloat(style.outlineOffset)),host:box(host),anchor:box(anchor)};})};
  });
  const labelBoxes=(link:Awaited<ReturnType<typeof skipGeometry>>['links'][number])=>{expect(link.labelCount).toBeGreaterThan(0);expect(link.labelCount).toBeLessThanOrEqual(8);expect(link.labels).toHaveLength(link.labelCount);for(const bounds of link.labels){expect(bounds.width).toBeGreaterThan(0);expect(bounds.height).toBeGreaterThan(0);}return link.labels;};
  let skipFailure:unknown;
  try{
    for(const width of [320,390,1440]){
      await page.setViewportSize({width,height:skipViewport.height});
      for(let target=0;target<destinations.length;target++){
        await expect(newButton).toBeEnabled();await newButton.focus();await expect(newButton).toBeFocused();
        const resting=await skipGeometry();expect(resting.scrollWidth).toBe(resting.clientWidth);for(const link of resting.links){expect(link.focused).toBe(false);expect(link.host.bottom).toBeLessThanOrEqual(0);expect(link.anchor.bottom).toBeLessThanOrEqual(0);for(const bounds of labelBoxes(link))expect(bounds.bottom).toBeLessThanOrEqual(0);}
        for(let index=0;index<=target;index++){
          await page.keyboard.press('Shift+Tab');const [id,label]=destinations[index]!;await expect(page.locator('.skip-links').getByRole('link',{name:'Go to '+label,exact:true})).toBeFocused();
          const focused=await skipGeometry();expect(focused.scrollWidth).toBe(focused.clientWidth);
          for(const link of focused.links){if(link.target!=='#'+id){expect(link.focused).toBe(false);expect(link.host.bottom).toBeLessThanOrEqual(0);expect(link.anchor.bottom).toBeLessThanOrEqual(0);for(const bounds of labelBoxes(link))expect(bounds.bottom).toBeLessThanOrEqual(0);continue;}expect(link.focused).toBe(true);expect(link.focusVisible).toBe(true);expect(link.outlineStyle).not.toBe('none');expect(link.outlineWidth).toBeGreaterThan(0);
            for(const bounds of [link.host,link.anchor,...labelBoxes(link)]){expect(bounds.width).toBeGreaterThan(0);expect(bounds.height).toBeGreaterThan(0);expect(bounds.left).toBeGreaterThanOrEqual(0);expect(bounds.top).toBeGreaterThanOrEqual(0);expect(bounds.right).toBeLessThanOrEqual(focused.width);expect(bounds.bottom).toBeLessThanOrEqual(focused.height);}
            expect(link.anchor.left-link.clearance).toBeGreaterThanOrEqual(0);expect(link.anchor.top-link.clearance).toBeGreaterThanOrEqual(0);expect(link.anchor.right+link.clearance).toBeLessThanOrEqual(focused.width);expect(link.anchor.bottom+link.clearance).toBeLessThanOrEqual(focused.height);
          }
        }
        const [id]=destinations[target]!;await page.keyboard.press('Enter');await expect(page.locator('#'+id)).toBeVisible();await expect(page.locator('#'+id)).toBeFocused();await expect.poll(()=>page.evaluate(()=>window.location.hash)).toBe('#'+id);
        const activated=await skipGeometry();expect(activated.scrollWidth).toBe(activated.clientWidth);for(const link of activated.links){expect(link.focused).toBe(false);expect(link.host.bottom).toBeLessThanOrEqual(0);expect(link.anchor.bottom).toBeLessThanOrEqual(0);for(const bounds of labelBoxes(link))expect(bounds.bottom).toBeLessThanOrEqual(0);}
      }
    }
  }catch(error){skipFailure=error;throw error;}finally{try{await page.setViewportSize(skipViewport);}catch(error){if(skipFailure!==undefined)throw new AggregateError([skipFailure,error],'Skip-link checks and viewport restoration failed');throw error;}}
});

test('B07 trusted report flag, navigation fragment, unflagged absence and offline recovery', async ({ page, local }) => {
  await paired(page, local.server); await expect(page.getByRole('link',{name:'Progress Report'})).toHaveCount(0);
  await page.goto(local.server.origin + '/?progress-report=https://untrusted.example#request');
  await expect(page.getByRole('button',{name:'Connected locally',exact:true})).toBeVisible();
  await expect(page.getByRole('link',{name:'Progress Report'})).toHaveAttribute('href','http://127.0.0.1:4381/');
  expect(new URL(page.url()).hash).toBe('#request');
  await page.getByRole('link',{name:'Go to Canvas',exact:true}).focus(); await page.keyboard.press('Enter');
  expect(new URL(page.url()).searchParams.has('progress-report')).toBe(true); expect(new URL(page.url()).hash).toBe('#canvas');
  await page.reload(); expect(new URL(page.url()).hash).toBe('#canvas');
  await expect(page.getByRole('link',{name:'Progress Report'})).toBeVisible();
  await newRequestDocument(page);
  await page.getByRole('textbox',{name:'Prompt',exact:true}).fill('Draft survives failed reads');
  await page.getByRole('button',{name:'Connected locally',exact:true}).click();
  await local.server.close();
  await page.getByRole('button',{name:'Check connection',exact:true}).first().click();
  await expect(page.getByRole('button',{name:'Server offline',exact:true})).toBeVisible();
  await expect(page.getByRole('textbox',{name:'Prompt',exact:true})).toHaveValue('Draft survives failed reads');
});


test('B08 lost renewal response is read back without retry; restarted server requires pairing', async ({page, local}, info) => {
  // Passive evidence: fixed endpoint classes, status/native codes and bounded
  // process RSS samples. No URL, query, header, body, token or private path is
  // retained; this observer adds or retries no request and changes no limit.
  type Phase = 'initial' | 'reload' | 'renewal' | 'readback' | 'restart' | 'repaired';
  let phase:Phase='initial', restartedOrigin:string|null=null, apiResponses=0, otherFailures=0, dropped=0;
  let composition507=0, repairedCompositionReads=0, repairedCompositionVisible=false;
  const counts=new Map<string,{phase:Phase;server:'original'|'restarted';endpoint:string;method:string;status:number;count:number}>();
  const samples:{kind:'http'|'writer';phase:Phase;code:string;sqliteCode:number|null;rssBytes:number}[]=[];
  const sample=(kind:'http'|'writer',code:string,sqliteCode:number|null=null)=>{
    if(samples.length>=24||samples.filter(row=>row.kind===kind&&row.phase===phase).length>=2){dropped++;return;}
    samples.push({kind,phase,code,sqliteCode,rssBytes:process.memoryUsage().rss});
  };
  const classify=(path:string)=>{
    const fixed:Record<string,string>={
      '/api/v1/session':'session','/api/v1/session/bootstrap':'bootstrap','/api/v1/session/renew':'renewal',
      '/api/v1/capabilities':'capabilities','/api/v1/events':'events','/api/v1/events/stream':'event-stream',
      '/api/v1/ui':'ui-inventory','/api/v1/commands/pending':'pending-inventory','/api/v1/assets/staging/recovery':'staging-inventory',
    };
    if(Object.hasOwn(fixed,path))return fixed[path];
    if(/^\/api\/v1\/ui\/[^/]+\/request-reviews$/.test(path))return 'request-reviews';
    if(/^\/api\/v1\/ui\/[^/]+$/.test(path))return 'ui-checkpoint';
    if(/^\/api\/v1\/(?:documents|ui)\/[^/]+\/composition$/.test(path))return 'composition';
    if(/^\/api\/v1\/documents\/[^/]+\/(?:image|history|checkpoints|save-status)$/.test(path))return 'document-model';
    if(/^\/api\/v1\/documents\/[^/]+$/.test(path))return 'document';
    if(/^\/api\/v1\/recovery\/[^/]+\/release$/.test(path))return 'recovery-release';
    if(/^\/api\/v1\/(?:snapshots|protocol-content|namespace-events)\/[^/]+$/.test(path))return 'recovery-content';
    return 'other-api';
  };
  const observe=(response:import('@playwright/test').Response)=>{
    const url=new URL(response.url());
    if(url.origin!==local.server.origin&&url.origin!==restartedOrigin||!url.pathname.startsWith('/api/v1/'))return;
    apiResponses++;const status=response.status(),endpoint=classify(url.pathname);
    // This scalar covers every phase even if the bounded diagnostic rows fill.
    if(endpoint==='composition'&&status===507)composition507++;
    if(status<400)return;
    const server=url.origin===restartedOrigin?'restarted':'original';
    if(endpoint==='other-api')otherFailures++;
    const rawMethod=response.request().method(),method=['GET','POST','HEAD'].includes(rawMethod)?rawMethod:'other';
    const key=[phase,server,endpoint,method,status].join(':'),prior=counts.get(key);
    if(prior)prior.count++;else if(counts.size<48)counts.set(key,{phase,server,endpoint,method,status,count:1});else dropped++;
    if(status===507)sample('http','HTTP_507');
  };
  page.on('response',observe);
  try {
  await paired(page, local.server); const documentId=await newRequestDocument(page);
  const prompt = page.getByRole('textbox', {name:'Prompt',exact:true});
  await prompt.fill('Preserved after a lost response'); await prompt.press('Tab');
  await expect(page.locator('footer')).toContainText('Draft saved locally');
  phase='reload';await page.reload();
  await expect(prompt).toHaveValue('Preserved after a lost response');
  let renewals = 0;
  await page.route('**/api/v1/session/renew', async route => {
    renewals++;
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    await route.abort('connectionreset');
  });
  await page.getByRole('button', {name:'Connected locally',exact:true}).click();
  phase='renewal';await page.getByRole('button', {name:'Renew connection',exact:true}).click();
  await expect(page.getByRole('button', {name:'Server offline',exact:true})).toBeVisible();
  phase='readback';await page.getByRole('button', {name:'Check connection',exact:true}).first().click();
  await expect(page.getByRole('button', {name:/^(Connected locally|Pairing needed)$/})).toBeVisible();
  expect(renewals).toBe(1);
  await expect(page.getByRole('textbox', {name:'Prompt',exact:true})).toHaveValue('Preserved after a lost response');
  await local.server.close();
  phase='restart';
  const next = await startLocalServer({root:local.server.root,staticDirectory:resolve('dist/app')},{writer:{onFailure:failure=>{
    const code=['CAPACITY','STORAGE_FULL','ENOSPC','EDQUOT'].includes(failure.code??'')?failure.code!:'OTHER';
    const sqliteCode=Number.isSafeInteger(failure.sqliteCode)&&failure.sqliteCode!>=0&&failure.sqliteCode!<=255?failure.sqliteCode!:null;
    sample('writer',code,sqliteCode);
  }}});restartedOrigin=next.origin;
  try {
    await page.goto(next.origin);
    await expect(page.getByRole('button', {name:'Pairing needed',exact:true})).toBeVisible();
    // Fresh pairing autoopens this root's sole retained document. Observe its
    // actual model response before pairing, then require the owned public UI.
    phase='repaired';
    const [compositionResponse]=await Promise.all([
      page.waitForResponse(response=>{
        const url=new URL(response.url());
        return phase==='repaired'&&url.origin===next.origin&&url.pathname==='/api/v1/documents/'+documentId+'/composition'&&response.request().method()==='GET';
      }),
      paired(page,next),
    ]);
    expect(compositionResponse.status()).toBe(200);
    expect(await compositionResponse.finished()).toBeNull();repairedCompositionReads++;
    const composition=page.getByRole('radio',{name:'Composition',exact:true});
    await composition.focus();await composition.press('Space');
    const scene=page.getByRole('textbox',{name:'Scene',exact:true});
    await expect(scene).toBeVisible();await expect(scene).toBeEnabled();repairedCompositionVisible=true;
    expect(repairedCompositionReads).toBeGreaterThan(0);
  } finally { await next.close(); }
  expect(composition507,'Valid recovery must not encounter Composition capacity refusal').toBe(0);
  } finally {
    page.off('response',observe);
    await info.attach('B08-recovery-capacity-diagnostic',{body:JSON.stringify({kind:'shell-recovery-capacity-diagnostic-1',qualification:false,
      apiResponses,otherFailures,dropped,composition507,repairedCompositionReads,repairedCompositionVisible,
      counts:[...counts.values()],samples,finalPhase:phase},null,2),contentType:'application/json'});
  }
});


test('B09 CSP permits only the trusted split styles and blocks injected inline behavior', async ({page, local}) => {
  await paired(page,local.server);
  const result = await page.evaluate(() => {
    const node = document.createElement('div');
    node.setAttribute('style','position:fixed;inset:0');
    node.setAttribute('onclick','window.inlineExecuted=true');
    document.body.append(node); node.click();
    const script = document.createElement('script'); script.textContent='window.scriptExecuted=true'; document.head.append(script);
    const result = {position:getComputedStyle(node).position, inline:Object.hasOwn(window,'inlineExecuted'),script:Object.hasOwn(window,'scriptExecuted')};
    node.remove();script.remove();return result;
  });
  expect(result).toEqual({position:'static',inline:false,script:false});
});


test('B10 same-site user navigation opens only the anonymous shell; fetch and frame remain denied', async ({page,local,context}) => {
  const report = createServer((_request,response) => {
    response.setHeader('Content-Type','text/html'); response.end(`<a href="${local.server.origin}/?progress-report">Editor</a>`);
  });
  await new Promise<void>(resolve=>report.listen(0,'127.0.0.1',resolve));
  const origin = `http://127.0.0.1:${(report.address() as {port:number}).port}`;
  try {
    await page.goto(origin); await page.getByRole('link',{name:'Editor',exact:true}).click();
    await expect(page.getByRole('button',{name:'Pairing needed',exact:true})).toBeVisible();
    await expect(page.getByRole('link',{name:'Progress Report'})).toBeVisible();
    const attacker=await context.newPage(); await attacker.goto(origin);
    const cdp=await context.newCDPSession(attacker); await cdp.send('Network.enable');
    const statuses:number[]=[]; cdp.on('Network.responseReceivedExtraInfo', e=>statuses.push(e.statusCode));
    await attacker.evaluate(async url=>{try {await fetch(url,{mode:'no-cors'});}catch {}},local.server.origin);
    await expect.poll(()=>statuses).toEqual([403]);
    const navigation=await attacker.goto(local.server.origin+'/api/v1/session');expect(navigation?.status()).toBe(403);
    await attacker.goto(origin);
    const frameResponse=attacker.waitForResponse(response=>response.url()===local.server.origin+'/');
    await attacker.evaluate(url=>{const frame=document.createElement('iframe');frame.src=url;document.body.append(frame);},local.server.origin);
    expect((await frameResponse).status()).toBe(403);
    await attacker.close();
  } finally { await new Promise<void>(resolve=>report.close(()=>resolve())); }
});


test('same shell remount replaces the retired Lit canvas, restores resize observation and document-close ownership', async ({page,local})=>{
  await paired(page,local.server);
  const shell=await page.locator('ie-shell').elementHandle();expect(shell).not.toBeNull();
  const mount=await shell!.evaluateHandle(node=>({node,parent:node.parentNode!,next:node.nextSibling,canvas:node.querySelector('canvas')!,oldCanvas:node.querySelector('canvas')!}));
  await mount.evaluate(({node})=>node.remove());
  await expect.poll(()=>mount.evaluate(({node,canvas})=>({suspended:(node as HTMLElement&{renderReadiness:{viewport:{suspended:boolean}}}).renderReadiness.viewport.suspended,width:canvas.width,height:canvas.height}))).toEqual({suspended:true,width:0,height:0});
  await mount.evaluate(({node,parent,next})=>parent.insertBefore(node,next?.parentNode===parent?next:null));
  await expect.poll(()=>mount.evaluate(({node,canvas})=>({same:node.querySelector('canvas')===canvas,suspended:(node as HTMLElement&{renderReadiness:{viewport:{suspended:boolean}}}).renderReadiness.viewport.suspended,registered:Object.hasOwn((node as HTMLElement&{documentLifecycle:{consumers:Record<string,unknown>}}).documentLifecycle.consumers,'editor-shell')}))).toEqual({same:false,suspended:false,registered:true});
  expect(await mount.evaluate(({oldCanvas})=>({width:oldCanvas.width,height:oldCanvas.height}))).toEqual({width:0,height:0});
  await mount.evaluate(state=>{state.canvas=state.node.querySelector('canvas')!;});
  await expect(page.getByRole('button',{name:'Connected locally',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'New',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'New',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'New document',exact:true});
  await expect(dialog).toBeVisible();const controls=page.locator('en-dialog#editor-dialog');
  await controls.getByRole('spinbutton',{name:'Width (px)',exact:true}).fill('128');
  await controls.getByRole('spinbutton',{name:'Height (px)',exact:true}).fill('96');
  await controls.getByRole('button',{name:'Create',exact:true}).click();
  await expect(dialog).toBeHidden();await expect(page.locator('#close-document')).toBeEnabled();
  await expect.poll(()=>mount.evaluate(({canvas})=>canvas.width>1&&canvas.height>1)).toBe(true);
  const before=await mount.evaluate(({canvas})=>({width:canvas.width,height:canvas.height}));
  await page.setViewportSize({width:1200,height:760});
  await expect.poll(()=>mount.evaluate(({canvas},before)=>canvas.width!==before.width||canvas.height!==before.height,before)).toBe(true);
  const releases=await shell!.evaluate(node=>(node as HTMLElement&{documentLifecycle:{releases:number}}).documentLifecycle.releases);
  await page.locator('#close-document').click();
  await expect.poll(()=>shell!.evaluate((node,releases)=>{const state=(node as HTMLElement&{documentLifecycle:{releases:number;releasing:boolean;failed:boolean}}).documentLifecycle;return !state.releasing&&!state.failed&&state.releases>releases;},releases)).toBe(true);
  expect(await mount.evaluate(({node,canvas})=>({same:node.querySelector('canvas')===canvas,width:canvas.width,height:canvas.height,reads:(node as HTMLElement&{documentLifecycle:{consumers:Record<string,{canvasReads:number}>}}).documentLifecycle.consumers['editor-shell'].canvasReads}))).toEqual({same:true,width:1,height:1,reads:0});
  await mount.dispose();await shell!.dispose();
});


test('shell detached before its first Lit update initializes a real canvas after reattachment',async({page,local})=>{
  await paired(page,local.server);const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const prior=await page.locator('ie-shell').elementHandle();
  await prior!.evaluate(node=>node.remove());
  await expect.poll(()=>prior!.evaluate(node=>(node as HTMLElement&{renderReadiness:{viewport:{suspended:boolean;pendingReads:number}}}).renderReadiness.viewport.pendingReads)).toBe(0);
  const fresh=await prior!.evaluateHandle(previous=>{
    const owner=previous.ownerDocument,tag=previous.localName,scoped='customElementRegistry' in previous;
    const registry=scoped?(previous as HTMLElement&{customElementRegistry:CustomElementRegistry|null}).customElementRegistry:owner.defaultView!.customElements;
    if(!registry||registry.get(tag)!==previous.constructor)throw Error('The prior shell registry must own its exact constructor.');
    const node=scoped?owner.createElement(tag,{customElementRegistry:registry} as ElementCreationOptions):owner.createElement(tag);
    if(node.constructor!==previous.constructor||node.childNodes.length!==0||(node as HTMLElement&{hasUpdated:boolean}).hasUpdated!==false)throw Error('The fresh shell must use the same registry and precede its first Lit update.');
    owner.body.append(node);node.remove();
    if((node as HTMLElement&{hasUpdated:boolean}).hasUpdated!==false)throw Error('The fresh shell must detach synchronously before its first Lit update.');
    return node;
  });
  await fresh.evaluate(async node=>{await (node as HTMLElement&{updateComplete:Promise<unknown>}).updateComplete;});
  expect(errors).toEqual([]);
  await fresh.evaluate(node=>document.body.append(node));
  await expect.poll(()=>fresh.evaluate(node=>{const state=(node as HTMLElement&{renderReadiness:{viewport:null|{suspended:boolean}};documentLifecycle:{consumers:Record<string,unknown>}});return !!node.querySelector('canvas')&&state.renderReadiness.viewport?.suspended===false&&Object.hasOwn(state.documentLifecycle.consumers,'editor-shell');})).toBe(true);
  expect(errors).toEqual([]);await fresh.dispose();await prior!.dispose();
});
