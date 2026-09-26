import { test as base, expect } from '@playwright/test';
import { mkdtemp, realpath, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { startLocalServer } from '../../server/http.js';
import { launch } from '../../tooling/launcher.js';

type Server = Awaited<ReturnType<typeof startLocalServer>>;
const test = base.extend<{ local: { server: Server; advance: (ms: number) => void } }>({
  local: async ({}, use) => {
    let now = Date.now();
    const directory = await mkdtemp(join(await realpath(tmpdir()), 'ie-browser-'));
    const server = await startLocalServer({ root: join(directory, 'private'), staticDirectory: resolve('dist/app'), credentialConfigured: false, now: () => now });
    try { await use({ server, advance: ms => { now += ms; } }); } finally { await server.close(); }
  },
});
test.beforeEach(async ({ context }) => {
  await context.route('**/*', async route => {
    const host = new URL(route.request().url()).hostname;
    if (host !== '127.0.0.1' && host !== 'localhost') throw new Error('Non-loopback browser request blocked');
    await route.continue();
  });
});
async function paired(page: import('@playwright/test').Page, server: Server, flag = false) {
  const link = new URL(server.issuePairingURL()); if (flag) link.search = '?progress-report';
  await Promise.all([page.waitForResponse(response => response.url() === server.origin + '/api/v1/session/bootstrap'), page.goto(link.href)]);
  await expect(page.getByRole('button', { name: 'Connected locally', exact: true })).toBeVisible();
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
    expect(observations.hash).toBe(''); expect(observations.hasPairing).toBe(false); expect(observations.storage).toEqual([0, 0]); expect(observations.cookie).toBe('');
    expect(observations.fetches).toEqual([{ path: '/api/v1/session/bootstrap', hash: '', consumed: true }, { path: '/api/v1/capabilities', hash: '', consumed: true }]);
    for (const resource of observations.resources) expect(resource.start, resource.path).toBeGreaterThanOrEqual(observations.cleaned);
    const cookies = await context.cookies(); expect(cookies).toHaveLength(1); expect(cookies[0].httpOnly).toBe(true); expect(cookies[0].sameSite).toBe('Strict');
    expect(logs.join('\n').includes(first.split('#')[1])).toBe(false);
    const dom = await page.content(); expect(dom.includes(first.split('pairing=')[1])).toBe(false);
    await page.reload(); await expect(page.getByRole('button', { name: 'Connected locally', exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __testObservations: {fetches: {path:string}[]} }).__testObservations.fetches.map(x => x.path))).toEqual(['/api/v1/session', '/api/v1/capabilities']);
    expect(errors).toEqual([]);
    const build = JSON.parse(await readFile('dist/app/build-evidence.json', 'utf8'));
    expect(build.observations.D11.startupJsRawBytes).toBeLessThan(1.5 * 1024 * 1024);
    expect(build.observations.D11.startupJsGzipBytes).toBeLessThan(500 * 1024);
    expect(build.observations.D11.cssGzipBytes).toBeLessThan(200 * 1024);
    expect(build.outputs.flatMap((x: {modules:string[]}) => x.modules).some((x:string) => /prosemirror|server\/|tooling\/launcher|elements\/dist\/index.js/.test(x))).toBe(false);
    await info.attach('bootstrap-observations', { body: JSON.stringify(observations, null, 2), contentType: 'application/json' });
    await page.screenshot({ path: 'evidence/p1a3/desktop-1440.png' });
  } finally { await server.close(); }
});

test('B02 real native prompt drafts, inert text, selection and composition-safe shortcuts', async ({ page, local }) => {
  await paired(page, local.server);
  const calls: string[] = []; page.on('request', request => { if (request.method() === 'POST') calls.push(new URL(request.url()).pathname); });
  const prompt = page.getByRole('textbox', { name: 'Prompt', exact: true });
  const hostile = '<img src=x onerror="window.pwned=1">\nשלום 日本語 & untouched';
  await prompt.fill(hostile);
  await prompt.evaluate(node => (node as HTMLTextAreaElement).setSelectionRange(2, 9, 'backward'));
  await page.getByRole('tab', { name: 'Jobs' }).click();
  expect(await prompt.evaluate(node => { const n = node as HTMLTextAreaElement; return [n.selectionStart, n.selectionEnd, n.selectionDirection]; })).toEqual([2, 9, 'backward']);
  await prompt.focus(); await page.keyboard.press('End'); await page.keyboard.type('hz');
  await expect(page.getByRole('button', { name: 'Pan (H)' })).toHaveAttribute('aria-pressed', 'true');
  await prompt.dispatchEvent('compositionstart');
  await prompt.dispatchEvent('keydown', { key: 'z', bubbles: true, composed: true, isComposing: true });
  await prompt.dispatchEvent('compositionend');
  await expect(page.getByRole('button', { name: 'Pan (H)' })).toHaveAttribute('aria-pressed', 'true');
  const edited = await prompt.inputValue();
  await page.getByLabel('Operation', { exact: true }).selectOption({ label: 'Generate with Fast' });
  await expect(prompt).toHaveValue(''); await prompt.fill('A separate Fast draft');
  await page.getByLabel('Operation', { exact: true }).selectOption({ label: 'Generate image' });
  await expect(prompt).toHaveValue(edited);
  expect(await page.evaluate(() => Object.hasOwn(window, 'pwned'))).toBe(false);
  expect(await page.locator('ie-shell img').count()).toBe(0);
  await expect(page.getByRole('button', { name: 'Generate', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Import', exact: true })).toBeDisabled();
  expect(calls).toEqual([]);
});

test('B03 keyboard panels, roving tool focus, resize and collapsed content', async ({ page, local }) => {
  await paired(page, local.server);
  const errors: string[] = []; page.on('console', m => {if(m.type()==='error') errors.push(m.text());});
  await page.getByRole('button', { name: 'Pan (H)' }).focus(); await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('button', { name: 'Zoom (Z)' })).toBeFocused();
  await page.keyboard.press('Enter'); await expect(page.getByRole('button', { name: 'Zoom (Z)' })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('h'); await expect(page.getByRole('button', { name: 'Pan (H)' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('tab', { name: 'Results' }).focus(); await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Jobs' })).toBeFocused();
  await expect(page.getByText('No jobs submitted', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Collapse', exact: false }).click();
  await expect(page.locator('#activity-panel')).toBeHidden();
  await page.getByRole('button', { name: 'Expand', exact: false }).click();
  await page.getByRole('tab', { name: 'Composition', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No composition yet' })).toBeVisible();
  const splitter = page.getByRole('separator', { name: 'Request panel width' }).first();
  const width = (await page.locator('#request').boundingBox())!.width;
  await splitter.focus(); await page.keyboard.press('ArrowRight');
  expect((await page.locator('#request').boundingBox())!.width).toBeGreaterThan(width);
  await page.getByRole('button', { name: 'Help and keyboard shortcuts' }).click();
  await page.keyboard.press('Escape'); await expect(page.getByRole('button', { name: 'Help and keyboard shortcuts' })).toBeFocused();
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
  await paired(page, local.server);
  await page.getByRole('textbox', { name:'Prompt',exact:true }).fill('Keep this draft through reflow');
  await page.setViewportSize({width:720,height:450});
  await expect(page.getByRole('textbox', {name:'Prompt',exact:true})).toBeFocused();
  await expect(page.getByRole('button', {name:'Request',exact:true})).toHaveAttribute('aria-expanded','true');
  await expect(page.getByRole('textbox', {name:'Prompt',exact:true})).toHaveValue('Keep this draft through reflow');
  await page.screenshot({path:'evidence/p1a3/reflow-720.png',fullPage:true});
  await page.setViewportSize({width:320,height:800});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(320);
  await page.getByRole('textbox', {name:'Prompt',exact:true}).focus();
  await page.getByRole('button', {name:'Request',exact:true}).click();
  await page.getByRole('button', {name:'Layers & composition',exact:true}).click();
  await page.getByRole('tab',{name:'Composition',exact:true}).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', {name:'Layers & composition',exact:true})).toBeFocused();
  await page.getByRole('button', {name:'Request',exact:true}).click();
  await page.screenshot({path:'evidence/p1a3/reflow-320.png',fullPage:true});
});

test('B07 trusted report flag, navigation fragment, unflagged absence and offline recovery', async ({ page, local }) => {
  await paired(page, local.server); await expect(page.getByRole('link',{name:'Progress Report'})).toHaveCount(0);
  await page.goto(local.server.origin + '/?progress-report=https://untrusted.example#request');
  await expect(page.getByRole('button',{name:'Connected locally',exact:true})).toBeVisible();
  await expect(page.getByRole('link',{name:'Progress Report'})).toHaveAttribute('href','http://127.0.0.1:4381/');
  expect(new URL(page.url()).hash).toBe('#request');
  await page.getByRole('link',{name:'Go to canvas',exact:true}).focus(); await page.keyboard.press('Enter');
  expect(new URL(page.url()).searchParams.has('progress-report')).toBe(true); expect(new URL(page.url()).hash).toBe('#canvas');
  await page.reload(); expect(new URL(page.url()).hash).toBe('#canvas');
  await expect(page.getByRole('link',{name:'Progress Report'})).toBeVisible();
  await page.getByRole('textbox',{name:'Prompt',exact:true}).fill('Draft survives failed reads');
  await page.getByRole('button',{name:'Connected locally',exact:true}).click();
  await local.server.close();
  await page.getByRole('button',{name:'Check connection',exact:true}).click();
  await expect(page.getByRole('button',{name:'Server offline',exact:true})).toBeVisible();
  await expect(page.getByRole('textbox',{name:'Prompt',exact:true})).toHaveValue('Draft survives failed reads');
});


test('B08 lost renewal response is read back without retry; restarted server requires pairing', async ({page, local}) => {
  await paired(page, local.server);
  await page.getByRole('textbox', {name:'Prompt',exact:true}).fill('Preserved after a lost response');
  let renewals = 0;
  await page.route('**/api/v1/session/renew', async route => {
    renewals++;
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    await route.abort('connectionreset');
  });
  await page.getByRole('button', {name:'Connected locally',exact:true}).click();
  await page.getByRole('button', {name:'Renew connection',exact:true}).click();
  await expect(page.getByRole('button', {name:'Server offline',exact:true})).toBeVisible();
  await page.getByRole('button', {name:'Check connection',exact:true}).click();
  await expect(page.getByRole('button', {name:/^(Connected locally|Pairing needed)$/})).toBeVisible();
  expect(renewals).toBe(1);
  await expect(page.getByRole('textbox', {name:'Prompt',exact:true})).toHaveValue('Preserved after a lost response');
  await local.server.close();
  const next = await startLocalServer({root:local.server.root,staticDirectory:resolve('dist/app')});
  try {
    await page.goto(next.origin);
    await expect(page.getByRole('button', {name:'Pairing needed',exact:true})).toBeVisible();
    await paired(page,next);
  } finally { await next.close(); }
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
