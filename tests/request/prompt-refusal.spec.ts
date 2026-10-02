import {test,expect,type Page,type Locator} from '@playwright/test';
import type {Snapshot} from './prompt-refusal-fixture/types.js';

// This suite uses native browser editing for the first four cases. The last
// case deliberately dispatches synthetic composition events and does not claim
// physical IME, dictation, autofill, native undo storage, or process RSS coverage.
const prompt=(page:Page)=>page.getByRole('textbox',{name:'Prompt',exact:true});
const snapshot=(page:Page):Promise<Snapshot>=>page.evaluate(()=>window.promptFixture.snapshot());
const lastSaved=async(page:Page)=>(await snapshot(page)).saved.at(-1)?.text;
async function seed(page:Page,text:string){await prompt(page).fill(text);await expect.poll(()=>lastSaved(page)).toBe(text);}
async function selection(input:Locator,start:number,end=start){await input.focus();await input.evaluate((element,range)=>{const native=element as HTMLTextAreaElement;native.setSelectionRange(range.start,range.end,'forward');},{start,end});}
async function insert(page:Page,text:string){await page.keyboard.insertText(text);}
async function retry(page:Page,text:string){await page.evaluate(()=>window.promptFixture.releasePressure());await page.getByRole('button',{name:'Retry saving this prompt',exact:true}).click();await expect.poll(()=>lastSaved(page)).toBe(text);await expect.poll(async()=>(await snapshot(page)).refused).toBe(false);await expect(prompt(page)).toHaveValue(text);}
test.beforeEach(async({page},testInfo)=>{
 const external:string[]=[],browserErrors:string[]=[];
 page.on('pageerror',error=>browserErrors.push(error.message));
 await page.route('**/*',route=>{const url=new URL(route.request().url());if(['http:','https:'].includes(url.protocol)&&url.origin!=='http://127.0.0.1:4187'){external.push(url.origin);return route.abort();}return route.continue();});
 await page.goto('/');await expect(page.getByRole('status',{name:'Fixture readiness',exact:true})).toHaveText(/^Ready: (scoped|global)$/);
 await expect(prompt(page)).toBeVisible();
 (testInfo as typeof testInfo&{fixtureObservations?:unknown}).fixtureObservations={external,browserErrors};
});
test.afterEach(async({page,browserName,browser},testInfo)=>{
 const observations=(testInfo as typeof testInfo&{fixtureObservations?:{external:string[];browserErrors:string[]}}).fixtureObservations;
 const state=await snapshot(page),cleanup=await page.evaluate(()=>window.promptFixture.dispose());
 await testInfo.attach('native-prompt-evidence',{body:JSON.stringify({browserName,browserVersion:browser.version(),scope:'Native browser editing plus explicitly synthetic composition sequencing; fake persistence and no physical IME qualification',observations,state,cleanup},null,2),contentType:'application/json'});
 expect(observations?.external).toEqual([]);expect(observations?.browserErrors).toEqual([]);expect(state.errors).toEqual([]);
 expect(cleanup.registrations).toBe(0);expect(cleanup.uiPins).toBe(0);expect(cleanup.responseOwners).toBe(0);expect(cleanup.after).toEqual(cleanup.before);
});

test('trusted native insertion crosses the initial UTF-16 reservation without clipping',async({page})=>{
 const initial='x'.repeat(65534),suffix='😀Z',input=prompt(page);await seed(page,initial);
 const maximum=await input.evaluate(element=>(element as HTMLTextAreaElement).maxLength);expect(maximum).toBeGreaterThan(65536);
 await selection(input,initial.length);const start=(await snapshot(page)).events.length;await insert(page,suffix);
 await expect(input).toHaveValue(initial+suffix);await expect.poll(()=>lastSaved(page)).toBe(initial+suffix);
 expect(await input.evaluate(element=>(element as HTMLTextAreaElement).maxLength)).toBe(maximum);
 const observed=(await snapshot(page)).events.slice(start);expect(observed.some(event=>event.type==='beforeinput'&&event.trusted&&!event.prevented)).toBe(true);expect(observed.some(event=>event.type==='input'&&event.trusted&&event.units===initial.length+suffix.length)).toBe(true);
});

test('failed growth admission cancels the entire native insertion before value or selection changes',async({page})=>{
 const initial='p'.repeat(65534),suffix='😀Z',input=prompt(page);await seed(page,initial);await selection(input,initial.length);
 const prior=await snapshot(page),range=await input.evaluate(element=>{const native=element as HTMLTextAreaElement;return [native.selectionStart,native.selectionEnd];});
 await page.evaluate(()=>window.promptFixture.pressure());await insert(page,suffix);
 await expect(page.getByText(/No part of the insertion was accepted\./)).toBeVisible();await expect(input).toHaveValue(initial);
 expect(await input.evaluate(element=>{const native=element as HTMLTextAreaElement;return [native.selectionStart,native.selectionEnd];})).toEqual(range);
 const refused=await snapshot(page);expect(refused.saved).toEqual(prior.saved);expect(refused.refused).toBe(false);expect(refused.events.slice(prior.events.length).some(event=>event.type==='beforeinput'&&event.trusted&&event.cancelable&&event.prevented)).toBe(true);
 await page.evaluate(()=>window.promptFixture.releasePressure());await insert(page,suffix);await expect(input).toHaveValue(initial+suffix);await expect.poll(()=>lastSaved(page)).toBe(initial+suffix);
});

test('Entry refusal retains complete accepted raw text and fences operation mode and source until exact retry',async({page})=>{
 await page.getByRole('combobox',{name:'Request prompt type',exact:true}).selectOption('raw');
 const initial='Saved Café',suffix='\n日本語 😀\ufeff "raw"',complete=initial+suffix,input=prompt(page);await seed(page,initial);await selection(input,initial.length);
 const prior=await snapshot(page);await page.evaluate(()=>window.promptFixture.pressure());await insert(page,suffix);await expect.poll(async()=>(await snapshot(page)).refused).toBe(true);await expect(input).toHaveValue(complete);
 await selection(input,2,8);await page.evaluate(()=>window.promptFixture.repaint());await expect(input).toHaveValue(complete);await expect(input).toBeFocused();expect(await input.evaluate(element=>{const native=element as HTMLTextAreaElement;return [native.selectionStart,native.selectionEnd];})).toEqual([2,8]);
 await page.getByRole('combobox',{name:'Operation',exact:true}).selectOption('Generate with Fast');await expect(page.getByRole('combobox',{name:'Operation',exact:true})).toHaveValue('Generate image');
 await page.getByRole('combobox',{name:'Request prompt type',exact:true}).selectOption('plain');await expect(page.getByRole('combobox',{name:'Request prompt type',exact:true})).toHaveValue('raw');
 const source=page.getByRole('button',{name:'Capture all visible layers',exact:true});if(await source.isEnabled())await source.click();else await expect(source).toBeDisabled();
 await expect(page.getByRole('button',{name:'Review exact request',exact:true})).toBeDisabled();await page.evaluate(()=>window.promptFixture.repaint());
 const refused=await snapshot(page);expect(refused.saved).toEqual(prior.saved);expect(refused.commands).toEqual([]);await expect(input).toHaveValue(complete);
 await retry(page,complete);const accepted=await snapshot(page);expect(accepted.saved.length).toBe(prior.saved.length+1);expect(accepted.saved.at(-1)?.mode).toBe('raw');expect(accepted.saved.at(-1)?.operation).toBe('generate');
});

test('selection replacement and deletion remain whole under pressure and refused input disposal releases owners',async({page})=>{
 const initial='s'.repeat(65534),replacement='😀short',input=prompt(page);await seed(page,initial);const prior=await snapshot(page);
 await selection(input,initial.length-12,initial.length);await page.evaluate(()=>window.promptFixture.pressure());await insert(page,replacement);
 const replaced=initial.slice(0,-12)+replacement;await expect(input).toHaveValue(replaced);await expect.poll(async()=>(await snapshot(page)).refused).toBe(true);
 await input.press('Backspace');const deleted=replaced.slice(0,-1);await expect(input).toHaveValue(deleted);await page.evaluate(()=>window.promptFixture.repaint());await expect(input).toHaveValue(deleted);
 const state=await snapshot(page);expect(state.saved).toEqual(prior.saved);expect(state.commands).toEqual([]);expect(state.events.slice(prior.events.length).filter(event=>event.type==='beforeinput'&&event.trusted).every(event=>!event.prevented)).toBe(true);
 const cleanup=await page.evaluate(()=>window.promptFixture.dispose());expect(cleanup.after).toEqual(cleanup.before);expect(cleanup.registrations).toBe(0);await expect(input).toHaveCount(0);
});

test('synthetic composition sequencing retains a noncancelable overflow and final draft until deliberate retry',async({page})=>{
 const initial='Saved before composition',complete='語'.repeat(65537)+'😀',input=prompt(page);await seed(page,initial);const prior=await snapshot(page);
 await input.focus();await page.evaluate(()=>window.promptFixture.pressure());
 await input.evaluate((element,text)=>{const native=element as HTMLTextAreaElement;native.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,composed:true}));native.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,composed:true,cancelable:false,inputType:'insertCompositionText',data:text,isComposing:true}));native.value=text;native.setSelectionRange(text.length,text.length);native.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,inputType:'insertCompositionText',data:text,isComposing:true}));},complete);
 await expect(input).toHaveValue(complete);await expect.poll(async()=>(await snapshot(page)).refused).toBe(true);await expect(page.getByRole('button',{name:'Retry saving this prompt',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'Review exact request',exact:true})).toBeDisabled();
 await page.evaluate(()=>window.promptFixture.repaint());await expect(input).toHaveValue(complete);
 await input.evaluate((element,text)=>{element.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,composed:true,data:text}));element.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,inputType:'insertCompositionText',data:text,isComposing:false}));},complete);
 await expect(page.getByRole('button',{name:'Retry saving this prompt',exact:true})).toBeEnabled();await expect(input).toHaveValue(complete);expect((await snapshot(page)).saved).toEqual(prior.saved);
 await retry(page,complete);
 // A repeated synthetic final input is the same completed value. Count only
 // completed saves; accepted composing drafts are a separate persistence state.
 await input.evaluate((element,text)=>element.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,inputType:'insertCompositionText',data:text,isComposing:false})),complete);await page.evaluate(()=>window.promptFixture.repaint());
 const final=await snapshot(page);expect(final.saved.filter(row=>row.text===complete&&!row.composing)).toHaveLength(1);expect(final.commands).toEqual([]);expect(final.events.filter(event=>event.type.startsWith('composition')).every(event=>!event.trusted)).toBe(true);
});
