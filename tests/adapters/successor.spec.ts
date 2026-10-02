import {expect,type Locator,type Page} from '@playwright/test';
import {createHash} from 'node:crypto';
import {createReadStream,existsSync} from 'node:fs';
import {stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import type {AdapterLibraryEntry,AdapterLibraryPage} from '../../src/protocol/adapters.js';
import type {QueueView} from '../../src/protocol/queue.js';
import {test} from './fixture.js';

// Intended destination: tests/adapters/successor.spec.ts.
// This optional retained artifact is never downloaded by a test. Its profile
// grants local eligibility only; this case performs no provider dispatch.
const fixturePath=resolve(process.env.IE_ADAPTER_FIXTURE??'artifacts/p27-evidence/fal-public-lora-example/provider-example.safetensors');
const expectedWeights={hash:'sha256:bd0b96a2fcc3141400ebeffd8585b2d3c4c0d475b10e1468ba5c40acad748bc5',byteLength:'85299896',mediaType:'application/octet-stream'};
const click=(scope:Page|Locator,name:string)=>scope.getByRole('button',{name,exact:true}).click();
const text=async(scope:Page|Locator,name:string,value:string)=>{const input=scope.getByRole('textbox',{name,exact:true});await input.fill(value);await input.press('Tab');};
const number=async(scope:Page|Locator,name:string,value:string)=>{const input=scope.getByRole('spinbutton',{name,exact:true});await input.fill(value);await input.press('Tab');};

test.describe('retained official adapter successor',()=>{
 // A declaration-time skip avoids creating a private server or browser when
 // the optional 85 MB artifact is unavailable.
 test.skip(!existsSync(fixturePath),'Retain the official verified artifact or set IE_ADAPTER_FIXTURE. This test never downloads weights.');
 test('adapter successor replacement remains explicit and preserves queued provenance',async({adapter:{page,commands,read,record}})=>{
  test.setTimeout(180_000);
  expect((await stat(fixturePath)).size).toBe(Number(expectedWeights.byteLength));
  const digest=createHash('sha256');for await(const bytes of createReadStream(fixturePath,{highWaterMark:1048576}))digest.update(bytes);expect('sha256:'+digest.digest('hex')).toBe(expectedWeights.hash);
  await click(page,'New');await number(page,'Width (px)','4');await number(page,'Height (px)','4');await click(page,'Create');await expect(page.getByRole('dialog',{name:'New document',exact:true})).toBeHidden();
  await page.getByRole('combobox',{name:'Operation',exact:true}).selectOption('Generate with adapters');await text(page,'Prompt','Preserve this exact queued adapter version across a deliberate draft update.');
  await click(page,'Adapter library');const library=page.getByRole('region',{name:'Local adapter library',exact:true}),registration=library.locator('en-card[aria-label="Adapter registration review"]');
  const importVersion=async()=>{
   await library.locator('en-file-upload[label="Adapter weights"] input[type=file]').setInputFiles(fixturePath);
   await text(library,'Adapter name','Official successor fixture');await click(library,'Review local adapter import');await expect(registration).toBeVisible({timeout:90_000});await expect(registration).toContainText(expectedWeights.hash);await expect(registration).toContainText('Config not supplied');
   await click(registration,'Register these exact local files');await expect(registration).toHaveCount(0,{timeout:90_000});await expect(library.getByRole('textbox',{name:'Adapter name',exact:true})).toBeEnabled();
  };
  await importVersion();
  const first=(await read<AdapterLibraryPage>('/api/v1/adapters')).items[0]!;expect(first).toMatchObject({version:'1',weights:expectedWeights,locallyEligible:true,runtimeVerified:false,profileId:'v4-fal-public-example-1'});
  await click(library,'Attach exact version 1');await library.getByRole('switch',{name:'Acknowledge runtime uncertainty for adapter 1',exact:true}).check();
  // The same real attachment must retain an invalid native edit, block review,
  // and reveal its exact field from the summary before correction to zero.
  const scale=library.getByRole('spinbutton',{name:'Scale for adapter 1',exact:true});
  await number(library,'Scale for adapter 1','');await expect(scale).toHaveValue('');await expect(scale).toHaveAttribute('aria-invalid','true');
  await expect(library.getByText('Adapter scale must be a number from 0 to 4.',{exact:true})).toBeVisible();
  await number(library,'Scale for adapter 1','4.01');await expect(scale).toHaveValue('4.01');await expect(scale).toHaveAttribute('aria-invalid','true');
  await expect(library.getByText('Adapter scale must be a number from 0 to 4.',{exact:true})).toBeVisible();
  await click(page,'Review current request document');await click(page,'Adapter library');await expect(library).toBeHidden();
  await click(page,'Review exact request');const scaleSummary=page.locator('#request-errors');await expect(scaleSummary).toContainText('SCALE: Each scale must be between 0 and 4.');await expect(scaleSummary).toBeFocused();
  await expect(page.getByRole('heading',{name:'Immutable request review',exact:true})).toHaveCount(0);expect((await read<QueueView>('/api/v1/queue')).jobs).toHaveLength(0);expect(commands.filter(command=>command.body.type==='QueueInference')).toHaveLength(0);
  await scaleSummary.getByRole('link',{name:'SCALE: Each scale must be between 0 and 4.',exact:true}).click();
  await expect(library).toBeVisible();await expect(scale).toBeFocused();await expect(scale).toHaveValue('4.01');await expect(scale).toHaveAttribute('aria-invalid','true');
  await number(library,'Scale for adapter 1','0');await expect(scale).toHaveValue('0');await expect(scale).not.toHaveAttribute('aria-invalid','true');
  await expect(library.getByText('Adapter scale must be a number from 0 to 4.',{exact:true})).toHaveCount(0);await expect(scaleSummary).toHaveCount(0);
  await click(page,'Review current request document');await click(page,'Review exact request');await expect(page.getByRole('heading',{name:'Immutable request review',exact:true})).toBeVisible();await click(page,'Accept this exact review locally');await expect(page.getByRole('button',{name:'Enqueue accepted request',exact:true})).toBeEnabled();await click(page,'Enqueue accepted request');
  await expect.poll(async()=>(await read<QueueView>('/api/v1/queue')).jobs.length).toBe(1);
  const queued=(await read<QueueView>('/api/v1/queue')).jobs[0]!;expect(queued.review.request).toMatchObject({kind:'generate-adapters',adapters:[{version:first.versionId,hash:expectedWeights.hash,scale:'0',runtimeAcknowledged:true}]});
  expect(queued.stagePlan).toEqual([{role:'adapter:0',versionId:first.versionId,original:expectedWeights,transport:expectedWeights}]);
  expect(queued.attempts).toHaveLength(1);expect(queued.attempts.every(attempt=>attempt.state==='not-started')).toBe(true);
  const firstCard=library.locator('en-card').filter({has:page.getByRole('heading',{name:'Official successor fixture',exact:true})});await expect(firstCard).toHaveCount(1);await click(firstCard,'Import a new version');await importVersion();
  const second=(await read<AdapterLibraryPage>('/api/v1/adapters')).items.find(item=>item.version==='2')!;expect(second).toMatchObject({adapterId:first.adapterId,version:'2',weights:expectedWeights,locallyEligible:true,runtimeVerified:false});expect(second.versionId).not.toBe(first.versionId);
  expect(await read<AdapterLibraryEntry>('/api/v1/adapters/'+first.versionId)).toEqual(first);
  const attachment=()=>library.locator('en-card').filter({has:page.getByRole('spinbutton',{name:'Scale for adapter 1',exact:true})});
  await expect(attachment().locator('p').first()).toContainText(first.versionId);await expect(attachment().locator('p').first()).not.toContainText(second.versionId);await expect(library.getByRole('switch',{name:'Acknowledge runtime uncertainty for adapter 1',exact:true})).toBeChecked();
  await click(library,'Check attachment updates');await expect(attachment()).toContainText('Update available');await expect(attachment()).toContainText('version 2');
  const updates=await read<{protocolVersion:1;current:AdapterLibraryEntry;latest:AdapterLibraryEntry|null}>('/api/v1/adapters/'+first.versionId+'/updates');expect(updates).toEqual({protocolVersion:1,current:first,latest:second});
  await click(library,'Review replacement for adapter 1');const replacement=library.locator('en-card[aria-label="Adapter attachment replacement review"]');await expect(replacement).toBeVisible();await expect(replacement).toContainText(first.versionId);await expect(replacement).toContainText(second.versionId);await expect(replacement).toContainText(expectedWeights.hash);await expect(replacement).toContainText(/scale 0/i);await expect(replacement).toContainText(/position 1/i);
  await click(replacement,'Keep current version');await expect(replacement).toHaveCount(0);await expect(attachment()).toContainText(first.versionId);await expect(library.getByRole('switch',{name:'Acknowledge runtime uncertainty for adapter 1',exact:true})).toBeChecked();
  await click(library,'Review replacement for adapter 1');await expect(replacement).toBeVisible();await click(replacement,'Confirm replacement in this draft');await expect(replacement).toHaveCount(0);await expect(attachment()).toContainText(second.versionId);await expect(attachment()).not.toContainText(first.versionId);await expect(library.getByRole('spinbutton',{name:'Scale for adapter 1',exact:true})).toHaveValue('0');await expect(library.getByRole('switch',{name:'Acknowledge runtime uncertainty for adapter 1',exact:true})).not.toBeChecked();
  await click(page,'Adapter library');await expect(library).toBeHidden();
  await click(page,'Review exact request');const acknowledgementSummary=page.locator('#request-errors'),acknowledgementMessage='ADAPTER_RUNTIME_ACK_REQUIRED: Acknowledge runtime uncertainty for the attached adapter versions.';
  await expect(acknowledgementSummary).toContainText(acknowledgementMessage);await expect(acknowledgementSummary).toBeFocused();
  const acknowledgementLink=acknowledgementSummary.getByRole('link',{name:acknowledgementMessage,exact:true});await acknowledgementLink.focus();await expect(acknowledgementLink).toBeFocused();await acknowledgementLink.press('Enter');
  const acknowledgement=library.getByRole('switch',{name:'Acknowledge runtime uncertainty for adapter 1',exact:true}),acknowledgementError=library.locator('#request-adapter-ack-error');
  await expect(library).toBeVisible();await expect(acknowledgement).toBeFocused();await expect(acknowledgement).not.toBeChecked();await expect(acknowledgementError).toHaveText('This request requires runtime uncertainty acknowledgement. Review the unchecked acknowledgements below; local eligibility is checked separately.');await expect(scale).toHaveValue('0');
  await acknowledgement.check();await expect(acknowledgement).toBeChecked();await expect(acknowledgementError).toHaveCount(0);await expect(acknowledgementSummary).toHaveCount(0);await expect(scale).toHaveValue('0');
  const retained=(await read<QueueView>('/api/v1/queue')).jobs.find(job=>job.id===queued.id)!;expect(retained.review).toEqual(queued.review);expect(retained.stagePlan).toEqual(queued.stagePlan);expect(retained.attempts.every(attempt=>attempt.state==='not-started')).toBe(true);
  expect(commands.filter(command=>command.body.type==='QueueInference')).toHaveLength(1);expect(commands.some(command=>command.body.type==='AuthorizeProviderJob')).toBe(false);
  await record('adapter-successor-witness',{first,second,updates,queuedBefore:queued,queuedAfter:retained,replacement:{index:0,scale:'0',runtimeAcknowledged:false},acknowledgementRecovery:{summaryCode:'ADAPTER_RUNTIME_ACK_REQUIRED',libraryRevealed:true,focusedControl:'Acknowledge runtime uncertainty for adapter 1',runtimeAcknowledged:true,scale:'0'},sameWeightsDifferentImmutableVersions:true});
 });
});
