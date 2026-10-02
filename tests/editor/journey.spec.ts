import {specReceipt} from './receipt-path.js';
import {confirmImageImports} from './image-import-flow.js';
import {test,expect} from '@playwright/test';
import {mkdtemp,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const {startLocalServer}=await import(pathToFileURL(resolve('dist/local/server/http.js')).href);
test('E1 real reviewed import, edit and undo',async({page,context})=>{
 const directory=await mkdtemp(join(await realpath(tmpdir()),'ie-integrated-'));
 const server=await startLocalServer({root:join(directory,'private'),staticDirectory:resolve('dist/app'),credentialConfigured:false});
 const commands:string[]=[];page.on('request',r=>{if(new URL(r.url()).pathname==='/api/v1/commands'&&r.method()==='POST')commands.push(JSON.parse(r.postData()!).command.body.type);});
 await page.addInitScript(()=>document.addEventListener('securitypolicyviolation',e=>console.log('CSP diagnostic',JSON.stringify({blocked:e.blockedURI,directive:e.effectiveDirective,line:e.lineNumber,column:e.columnNumber,source:e.sourceFile,sample:e.sample}))));
 page.on('console',m=>{if(m.text().startsWith('CSP diagnostic'))console.log(m.text());});
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 page.on('request',request=>{const url=new URL(request.url());expect(url.protocol==='blob:'||url.hostname==='127.0.0.1').toBe(true);});
 try{
 await page.goto(server.issuePairingURL());await expect(page.getByText('Local recovery complete. Accepted edits are saved locally.',{exact:true})).toBeVisible();
 await page.locator('en-file-upload input[type=file]').setInputFiles('tests/raster/fixtures/hidden-alpha.png');
 await expect(page.getByRole('dialog',{name:'Import image',exact:true})).toBeVisible();
 await expect(page.getByText('No document open',{exact:true})).toBeVisible();
 await confirmImageImports(page,{names:['hidden-alpha.png'],destination:'new',close:false});
 await expect(page.getByText('ImportAsset accepted and saved locally.',{exact:true})).toBeVisible();
 const importDialog=page.getByRole('dialog',{name:'Import image',exact:true});await expect(importDialog).toBeVisible();await page.locator('en-dialog#editor-dialog').getByRole('button',{name:'Open imported document',exact:true}).click();await expect(importDialog).toBeVisible();await page.locator('en-dialog#editor-dialog').getByRole('button',{name:'Cancel',exact:true}).click();await expect(importDialog).toBeHidden();
 await expect(page.locator('canvas')).not.toHaveAttribute('data-asset','');
 await page.getByRole('treeitem').first().click();
 await expect(page.getByRole('textbox',{name:'Layer name',exact:true})).toHaveValue('hidden-alpha.png');
 await page.getByRole('spinbutton',{name:'Opacity (0–1)',exact:true}).fill('0.5');
 await page.getByRole('button',{name:'Apply properties',exact:true}).click();
 await expect(page.getByText('SetLayerProperties accepted and saved locally.',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Undo',exact:true}).click();
 await expect(page.getByText('Undo accepted and saved locally.',{exact:true})).toBeVisible();
 await expect(page.getByText(/Updates interrupted/)).toHaveCount(0);
 expect(errors).toEqual([]);
 // WebKit screenshot synchronization injects body {} as an inline style in Playwright.
 // Assert the actual workflow first; retain screenshot-tool CSP diagnostics separately.
 const before=errors.length;await page.screenshot({caret:'initial',path:(specReceipt(import.meta.url,'artifacts/p1b7/current'))+'/editor.png'});
 console.log('screenshot-only diagnostics',errors.slice(before));
 }finally{console.log('journey action diagnostics',commands,await page.evaluate(()=>performance.getEntriesByType('mark').filter(x=>x.name.startsWith('ie.intent.')).map(x=>x.name)));await server.close();}
});
