import {expect,type Page} from '@playwright/test';
import type {QueueJob,QueueView} from '../../src/protocol/queue.js';
import type {CandidateView} from '../../src/protocol/candidates.js';
import {test,populatedOutput} from './populated-fixture.js';
import {axeEvidence} from './axe.js';
import {liveRegions,type LiveMutation} from './live-regions.js';

const planned=['locally-queued-job','provider-queued-job','provider-running-job','provider-failed-job','provider-cancelled-job','prepared-result','candidate-adoption-review','adopted-result','restart-paused-job','recovered-completed-job'] as const;
const limitations=[
  'Real editor and writer, real queue dispatcher and result observer, and a controlled literal-loopback provider. No production provider capability or paid request is used.',
  'Provider phase controls only change emulator responses; all local mutations and adoption/recovery actions use actual public editor controls.',
  'AX09 records actual rendered open-shadow live-region changes and focus. Native assistive-technology spoken output remains a separate manual requirement.',
  'Source/prepared and document A/B/numeric-reveal keyboard traversal is defined in tests/request-edits/public.spec.ts. This suite scans the generated-candidate document-placement comparison within its adoption review.',
  'Every axe incomplete result remains unadjudicated until explicit manual review. These populated states do not claim training, native AT/IME or full AX01 qualification.',
];
const click=(page:Page,name:string)=>page.getByRole('button',{name,exact:true}).click();
async function number(page:Page,name:string,value:string){const field=page.getByRole('spinbutton',{name,exact:true});await field.fill(value);await field.press('Tab');}
const matching=(events:LiveMutation[],expression:RegExp)=>events.filter(event=>expression.test(event.text));

test('AX01 populated jobs/results, actual restart/adoption; AX09 pending, terminal and focus',async({populated},info)=>{
  const {page,read,allow,phase,restart,effects,record}=populated;
  const evidence=await axeEvidence(page,info,populatedOutput,planned,limitations);
  let live=await liveRegions(page);const announcements:unknown[]=[];
  const prompt=page.getByRole('textbox',{name:'Prompt',exact:true});
  const scan=(name:typeof planned[number])=>evidence.scan(name);
  const queue=()=>read<QueueView>('/api/v1/queue');
  const current=async(id:string)=>{const job=(await queue()).jobs.find(job=>job.id===id);if(!job)throw Error('Missing public queue job');return job;};
  const candidates=(job:QueueJob)=>read<CandidateView>('/api/v1/jobs/'+job.id+'/candidates?attempt='+job.attempts.at(-1)!.id);
  const providerPhase=async(job:QueueJob,value:string)=>{await expect.poll(async()=>(await candidates(job)).observation?.phase,{timeout:20000}).toBe(value);await expect(page.getByText('Provider observation: '+value+'.',{exact:true}).last()).toBeVisible();};
  const remember=async(name:string,start:number)=>{const events=(await live.events()).slice(start);announcements.push({name,events});await record('live-region-sequences',announcements);return events;};
  const terminal=async(name:string,start:number,expression:RegExp)=>{
    await expect.poll(async()=>matching((await live.events()).slice(start),expression).length,{timeout:15000}).toBeGreaterThanOrEqual(1);
    const events=await remember(name,start),matches=matching(events,expression);
    expect(matches,'One semantic terminal announcement, without duplicate live outlets').toHaveLength(1);
    expect(matches[0].politeness,'Background terminal milestone remains polite').toBe('polite');
    await expect(prompt,'Async provider state never steals draft focus').toBeFocused();
  };
  await click(page,'New');await number(page,'Width (px)','512');await number(page,'Height (px)','512');await click(page,'Create');
  await expect(page.getByRole('dialog',{name:'New document',exact:true})).toBeHidden();
  await number(page,'Output width','512');await number(page,'Output height','512');

  async function enqueue(text:string){
    if(await page.getByRole('button',{name:'Close request review',exact:true}).isVisible())await click(page,'Close request review');
    await prompt.fill(text);await click(page,'Review exact request');await expect(page.getByRole('heading',{name:'Immutable request review',exact:true})).toBeVisible();
    await click(page,'Accept this exact review locally');const button=page.getByRole('button',{name:'Enqueue accepted request',exact:true});await expect(button).toBeEnabled();
    const before=(await queue()).jobs.map(job=>job.id),start=(await live.events()).length;
    await button.focus();await button.press('Enter');
    let job:QueueJob|undefined;await expect.poll(async()=>{job=(await queue()).jobs.find(item=>!before.includes(item.id));return !!job;}).toBe(true);
    await expect.poll(async()=>matching((await live.events()).slice(start),/request (?:queued|saved)|queue change saved|queued locally|accepted.*queue/i).length).toBeGreaterThanOrEqual(1);
    const events=await remember('enqueue-'+text,start);
    expect(matching(events,/^Saving request…$/),'Exactly one meaningful pending announcement per enqueue').toHaveLength(1);
    expect(events.findIndex(event=>/^Saving request…$/.test(event.text))).toBeLessThan(events.findIndex(event=>/request (?:queued|saved)|queue change saved|queued locally|accepted.*queue/i.test(event.text)));
    await prompt.focus();return job!;
  }
  async function dispatch(job:QueueJob){
    await allow(job.id);let accepted:QueueJob|undefined;await expect.poll(async()=>{accepted=await current(job.id);return accepted.attempts.at(-1)!.state;}).toBe('acknowledged');
    await providerPhase(accepted!,'queued');return accepted!;
  }

  const failed=await enqueue('AX01 controlled failed request');
  expect(failed.attempts.at(-1)!.state).toBe('not-started');await expect(page.getByRole('button',{name:'Cancel unstarted job '+failed.id,exact:true})).toBeVisible();await scan('locally-queued-job');
  const failedRemote=await dispatch(failed);await scan('provider-queued-job');
  const failureStart=(await live.events()).length;phase(failedRemote.attempts.at(-1)!.requestId!,'running');await providerPhase(failedRemote,'running');await scan('provider-running-job');
  const quietStart=(await live.events()).length,statusCount=effects.filter(effect=>effect.requestId===failedRemote.attempts.at(-1)!.requestId&&effect.path.endsWith('/status')).length;
  await expect.poll(()=>effects.filter(effect=>effect.requestId===failedRemote.attempts.at(-1)!.requestId&&effect.path.endsWith('/status')).length,{timeout:15000}).toBeGreaterThanOrEqual(statusCount+3);
  const quiet=await remember('unchanged-running-polls',quietStart);expect(quiet,'Unchanged provider polls do not announce repeatedly').toEqual([]);await expect(prompt).toBeFocused();
  const readStatus=page.getByRole('region',{name:'Typed request draft',exact:true}).getByRole('button',{name:'Read current status',exact:true});
  for(let repeat=0;repeat<2;repeat++){
    const statusStart=(await live.events()).length;await readStatus.focus();await readStatus.press('Enter');
    await expect.poll(async()=>matching((await live.events()).slice(statusStart),/^Current request status\./).length).toBe(1);
    const repeated=await remember('explicit-read-current-status-'+repeat,statusStart);expect(matching(repeated,/^Current request status\./)[0].politeness).toBe('polite');
    await expect(page.getByRole('status',{name:'Request status',exact:true})).toContainText('running');await expect(readStatus).toBeFocused();
  }
  await prompt.focus();
  phase(failedRemote.attempts.at(-1)!.requestId!,'failed');await providerPhase(failedRemote,'failed');await terminal('failed',failureStart,/\bfailed\b|provider.*error/i);await scan('provider-failed-job');

  const cancelled=await dispatch(await enqueue('AX01 controlled cancelled request'));
  phase(cancelled.attempts.at(-1)!.requestId!,'running');await providerPhase(cancelled,'running');
  const cancelStart=(await live.events()).length;await click(page,'Request cancellation '+cancelled.attempts.at(-1)!.id);await prompt.focus();
  await providerPhase(cancelled,'cancelled');await terminal('cancelled',cancelStart,/cancellation confirmed|\bcancelled\b|\bcanceled\b/i);await scan('provider-cancelled-job');

  const completed=await dispatch(await enqueue('AX01 controlled completed request'));
  const completedStart=(await live.events()).length;phase(completed.attempts.at(-1)!.requestId!,'completed');await providerPhase(completed,'completed');
  await expect.poll(async()=>(await candidates(completed)).items[0]?.state,{timeout:30000}).toBe('prepared');
  await expect(page.getByText('Output 1: prepared. Safety: safe.',{exact:true})).toBeVisible();await terminal('completed',completedStart,/\bcompleted\b/i);await scan('prepared-result');
  await click(page,'Inspect frozen source and candidate');await expect(page.getByRole('combobox',{name:'Candidate treatment',exact:true})).toHaveValue('full-candidate');
  await click(page,'Preview current-document placement');await expect(page.getByRole('heading',{name:'Current-document adoption review',exact:true})).toBeVisible();
  const adopt=page.getByRole('button',{name:'Adopt this reviewed candidate',exact:true});await expect(adopt).toBeEnabled();await scan('candidate-adoption-review');
  const before=(await read<any>('/api/v1/documents/'+completed.documentId)).projection.value.revision;
  await adopt.focus();await adopt.press('Enter');await expect.poll(async()=>(await read<any>('/api/v1/documents/'+completed.documentId)).projection.value.revision).not.toBe(before);
  await expect(page.getByRole('treeitem',{name:/Image · Edited output 1 · visible/})).toBeVisible();await scan('adopted-result');

  const recovering=await dispatch(await enqueue('AX01 retained request survives writer restart'));
  phase(recovering.attempts.at(-1)!.requestId!,'running');await providerPhase(recovering,'running');
  const posts=effects.filter(effect=>effect.method==='POST'&&effect.path==='/ideogram/v4').length;
  await restart();live=await liveRegions(page);
  // axe is scoped to a document; reload after genuine server reopen requires
  // loading the already pinned source again without resetting prior evidence.
  const axe=await import('axe-core');await page.evaluate(axe.default.source);
  await click(page,'Open');await page.getByRole('button',{name:new RegExp('^Restore '+recovering.review.draft.sessionId+' · document '+recovering.documentId+' · sequence ')}).click();
  await expect(page.getByRole('dialog',{name:'Open document',exact:true})).toBeHidden();await expect(prompt).toHaveValue('AX01 retained request survives writer restart');
  await click(page,'Refresh durable queue');await expect.poll(async()=>(await current(recovering.id)).attempts.at(-1)!.recoveryRequired).toBe(true);
  await expect(page.getByText('Recovery is paused after restart; check the existing request explicitly.',{exact:false}).last()).toBeVisible();await scan('restart-paused-job');
  const recoveryStart=(await live.events()).length;await click(page,'Check existing request '+recovering.attempts.at(-1)!.id);await prompt.focus();
  await expect.poll(async()=>(await current(recovering.id)).attempts.at(-1)!.recoveryRequired).toBe(false);
  phase(recovering.attempts.at(-1)!.requestId!,'completed');await providerPhase(recovering,'completed');await expect.poll(async()=>(await candidates(recovering)).items[0]?.state,{timeout:30000}).toBe('prepared');
  await terminal('recovered-completed',recoveryStart,/\bcompleted\b/i);await scan('recovered-completed-job');
  expect(effects.filter(effect=>effect.method==='POST'&&effect.path==='/ideogram/v4'),'Recovery never submits a new provider job').toHaveLength(posts);
  expect(posts).toBe(4);expect(effects.filter(effect=>effect.method==='PUT'&&effect.path.endsWith('/cancel'))).toHaveLength(1);
  await record('scope',{planned,limitations,requestCount:posts,actualWriterRestart:true,adoptionRevisionBefore:before,adoptionRevisionAfter:(await read<any>('/api/v1/documents/'+completed.documentId)).projection.value.revision});
  await evidence.finish();
});
