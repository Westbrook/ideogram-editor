import {expect,type Locator,type Page} from '@playwright/test';
import {createHash} from 'node:crypto';
import type {AdapterLibraryEntry,AdapterLibraryPage} from '../../src/protocol/adapters.js';
import {test} from './fixture.js';

const hash=(bytes:Buffer)=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
// Deliberately small and structurally valid. This fixture must never claim V4 eligibility.
const weights=(byte:number)=>{
 const header=Buffer.from(JSON.stringify({__metadata__:{family:'ideogram-v4',fixture:'browser-only'},w:{dtype:'U8',shape:[8],data_offsets:[0,8]}}));
 const prefix=Buffer.alloc(8);prefix.writeBigUInt64LE(BigInt(header.length));
 return Buffer.concat([prefix,header,Buffer.alloc(8,byte)]);
};
const click=(scope:Page|Locator,name:string)=>scope.getByRole('button',{name,exact:true}).click();
const field=async(scope:Page|Locator,name:string,value:string)=>{const input=scope.getByRole('textbox',{name,exact:true});await input.fill(value);await input.press('Tab');};
const file=(scope:Locator,label:string,name:string,buffer:Buffer)=>scope.locator('en-file-upload[label="'+label+'"] input[type=file]').setInputFiles({name,mimeType:'application/octet-stream',buffer});

test('local adapter files are reviewed, versioned, searched and explicitly deleted without acquiring compatibility',async({adapter:{page,commands,read,record}})=>{
 await click(page,'New');
 for(const name of ['Width (px)','Height (px)']){const input=page.getByRole('spinbutton',{name,exact:true});await input.fill('4');await input.press('Tab');}
 await click(page,'Create');await expect(page.getByRole('dialog',{name:'New document',exact:true})).toBeHidden();
 await click(page,'Adapter library');const library=page.getByRole('region',{name:'Local adapter library',exact:true});
 await expect(library).toBeVisible();
 const original=weights(1),replacement=weights(2),config=Buffer.from('{"note":"synthetic browser config; no compatibility assertion"}');
 const provenance=Buffer.from('{"source":"https://example.invalid/local-fixture","license":"synthetic fixture"}');
 await file(library,'Adapter weights','local-original.safetensors',original);
 await file(library,'Optional adapter config','config.json',config);
 await file(library,'Optional adapter provenance','provenance.json',provenance);
 await field(library,'Adapter name','Browser local adapter');
 await field(library,'Import provenance (text only)','Browser fixture. https://example.invalid/reference remains inert text.');
 await expect(library.getByRole('textbox',{name:'Declared model family',exact:true})).toHaveValue('ideogram-v4');
 await expect(library.getByRole('textbox',{name:'Declared naming format',exact:true})).toHaveValue('fal');
 await click(library,'Review local adapter import');
 const registration=library.locator('en-card[aria-label="Adapter registration review"]');
 await expect(registration).toBeVisible();
 for(const text of [hash(original),hash(config),hash(provenance),'local-original.safetensors','config.json','provenance.json','https://example.invalid/reference'])await expect(registration).toContainText(text);
 expect(commands.filter(command=>command.body.type==='RegisterAdapterVersion'),'Review must retain files without registering them').toHaveLength(0);
 await click(registration,'Register these exact local files');
 await expect(library.getByRole('status')).toHaveText('Immutable adapter version registered. Inspect its compatibility status before attachment.');
 await expect(registration).toHaveCount(0);
 const cards=library.locator('en-card').filter({has:page.getByRole('heading',{name:'Browser local adapter',exact:true})});
 await expect(cards).toHaveCount(1);await expect(cards.first()).toContainText('Stored — compatibility unverified');await expect(cards.first()).toContainText(hash(original));
 await expect(cards.first().getByRole('button',{name:'Attach exact version 1',exact:true})).toBeDisabled();
 const first=(await read<AdapterLibraryPage>('/api/v1/adapters')).items[0]!;
 expect(first).toMatchObject({name:'Browser local adapter',version:'1',qualification:'structurally-valid',locallyEligible:false,runtimeVerified:false,profileId:null,weights:{hash:hash(original)},config:{hash:hash(config)}});
 await click(cards.first(),'Import a new version');
 await expect(library).toContainText('previous '+first.versionId+'. Existing requests keep their exact versions.');
 await file(library,'Adapter weights','local-replacement.safetensors',replacement);
 await click(library,'Review local adapter import');await expect(registration).toContainText(hash(replacement));await expect(registration).toContainText('Config not supplied');
 await click(registration,'Register these exact local files');
 await expect(cards).toHaveCount(2);
 const second=(await read<AdapterLibraryPage>('/api/v1/adapters')).items.find(item=>item.version==='2')!;
 expect(second).toMatchObject({adapterId:first.adapterId,version:'2',weights:{hash:hash(replacement)},config:null,locallyEligible:false,runtimeVerified:false});
 expect(second.versionId).not.toBe(first.versionId);
 expect(await read<AdapterLibraryEntry>('/api/v1/adapters/'+first.versionId),'Version replacement must preserve the exact original metadata').toEqual(first);
 await field(library,'Search adapter names','does-not-match');await click(library,'Search local library');
 await expect(library.getByText('No matching stored adapters. Import a V4 adapter or adjust the filters.',{exact:true})).toBeVisible();await expect(cards).toHaveCount(0);
 await field(library,'Search adapter names','Browser local');await library.getByRole('combobox',{name:'Filter by validation status',exact:true}).selectOption('structurally-valid');await click(library,'Search local library');
 await expect(cards).toHaveCount(2);
 await expect(library.getByRole('button',{name:'Attach exact version 1',exact:true})).toBeDisabled();await expect(library.getByRole('button',{name:'Attach exact version 2',exact:true})).toBeDisabled();
 await click(library,'Review deletion of version 2');const deletion=library.locator('en-card[aria-label="Adapter deletion review"]');
 await expect(deletion).toContainText(second.versionId);await expect(deletion).toContainText(hash(replacement));await expect(deletion).toContainText('0 retained dependencies');await expect(deletion).toContainText('No disk space will be freed.');
 expect(commands.filter(command=>command.body.type==='DeleteAdapterVersion'),'Preview must not delete the library version').toHaveLength(0);
 await click(deletion,'Keep library version');await expect(deletion).toHaveCount(0);expect(await read<AdapterLibraryEntry>('/api/v1/adapters/'+second.versionId)).toEqual(second);
 await click(library,'Review deletion of version 2');await expect(deletion).toContainText(second.versionId);await click(deletion,'Confirm deletion of this library version');
 await expect(library.getByRole('status')).toHaveText('Library version deleted. Original bytes and retained provenance remain; no disk space was freed.');await expect(cards).toHaveCount(1);await expect(cards.first()).toContainText(hash(original));
 const remaining=await read<AdapterLibraryPage>('/api/v1/adapters');expect(remaining.items).toEqual([first]);
 expect(commands.filter(command=>command.body.type==='RegisterAdapterVersion')).toHaveLength(2);expect(commands.filter(command=>command.body.type==='DeleteAdapterVersion')).toHaveLength(1);
 await record('version-witness',{first,second,remaining,hashes:{original:hash(original),replacement:hash(replacement),config:hash(config),provenance:hash(provenance)}});
});

test('adapter library pagination supports keyboard return, stable focus and retained filtered drafts',async({adapter:{page,commands,read,record}})=>{
 test.setTimeout(120_000);
 await click(page,'New');for(const name of ['Width (px)','Height (px)']){const input=page.getByRole('spinbutton',{name,exact:true});await input.fill('4');await input.press('Tab');}
 await click(page,'Create');await expect(page.getByRole('dialog',{name:'New document',exact:true})).toBeHidden();await click(page,'Adapter library');
 const library=page.getByRole('region',{name:'Local adapter library',exact:true}),registration=library.locator('en-card[aria-label="Adapter registration review"]');
 // Twenty is the public backend page size. These 21 real local registrations
 // cross that boundary without response substitution or application-state hooks.
 for(let index=1;index<=21;index++){
  await file(library,'Adapter weights','paging-'+index+'.safetensors',weights(index));await field(library,'Adapter name','Paging study '+String(index).padStart(2,'0'));
  await click(library,'Review local adapter import');await expect(registration).toBeVisible();await click(registration,'Register these exact local files');await expect(registration).toHaveCount(0);
  await expect(library.getByRole('textbox',{name:'Adapter name',exact:true})).toBeEnabled();
  await expect(library.getByRole('button',{name:'Review local adapter import',exact:true})).toBeDisabled();
 }
 expect(commands.filter(command=>command.body.type==='RegisterAdapterVersion')).toHaveLength(21);
 const prompt=page.getByRole('textbox',{name:'Prompt',exact:true});await prompt.fill('Keep this request while browsing adapters');await prompt.press('Tab');
 await file(library,'Adapter weights','pending-import.safetensors',weights(99));await field(library,'Adapter name','Unregistered local draft');
 await field(library,'Search adapter names','Paging study');await field(library,'Filter by declared family','ideogram-v4');
 await library.getByRole('combobox',{name:'Filter by origin',exact:true}).selectOption('import');await library.getByRole('combobox',{name:'Filter by validation status',exact:true}).selectOption('structurally-valid');
 const anchor=library.locator('#adapter-library-results'),cards=library.locator('en-card').filter({has:page.getByRole('heading',{name:/^Paging study \d+$/})});
 const query=new URLSearchParams({search:'Paging study',family:'ideogram-v4',origin:'import',status:'structurally-valid'});
 const first=await read<AdapterLibraryPage>('/api/v1/adapters?'+query);expect(first.items).toHaveLength(20);expect(first.nextAfter).toBeTruthy();
 query.set('after',first.nextAfter!);const second=await read<AdapterLibraryPage>('/api/v1/adapters?'+query);expect(second.items).toHaveLength(1);expect(second.nextAfter).toBeNull();
 const navigate=async(name:string,expected:AdapterLibraryPage,pageNumber:number)=>{
  const button=library.getByRole('button',{name,exact:true});await expect(button).toBeEnabled();await button.focus();await button.press('Enter');
  await expect(cards).toHaveCount(expected.items.length);await expect(library.getByText('Adapter library page '+pageNumber+' · '+expected.items.length+' stored versions shown.',{exact:true})).toBeVisible();await expect(anchor).toBeFocused();
  expect(await cards.locator('h4').allTextContents()).toEqual(expected.items.map(item=>item.name));
  await expect(library.getByRole('textbox',{name:'Search adapter names',exact:true})).toHaveValue('Paging study');await expect(library.getByRole('textbox',{name:'Filter by declared family',exact:true})).toHaveValue('ideogram-v4');
  await expect(library.getByRole('combobox',{name:'Filter by origin',exact:true})).toHaveValue('import');await expect(library.getByRole('combobox',{name:'Filter by validation status',exact:true})).toHaveValue('structurally-valid');
  await expect(library.getByRole('textbox',{name:'Adapter name',exact:true})).toHaveValue('Unregistered local draft');await expect(library.getByText(/^pending-import\.safetensors · \d+ bytes · local file$/)).toBeVisible();await expect(prompt).toHaveValue('Keep this request while browsing adapters');
 };
 await navigate('Search local library',first,1);await expect(library.getByRole('button',{name:'First adapter page',exact:true})).toBeDisabled();await expect(library.getByRole('button',{name:'Previous adapter page',exact:true})).toBeDisabled();
 await navigate('Next adapter page',second,2);await expect(library.getByRole('button',{name:'Next adapter page',exact:true})).toBeDisabled();
 await navigate('Previous adapter page',first,1);await navigate('Next adapter page',second,2);await navigate('First adapter page',first,1);
 expect(commands.filter(command=>command.body.type==='RegisterAdapterVersion')).toHaveLength(21);
 await record('pagination-witness',{first,second,keyboardActions:['Search local library','Next adapter page','Previous adapter page','Next adapter page','First adapter page'],focusAnchor:'#adapter-library-results',draftPreserved:true});
});
