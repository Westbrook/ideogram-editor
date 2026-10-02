import {expect,type Page,type Locator} from '@playwright/test';

/** Public J3 controls shared by browser campaigns. Every selected row must have
 * completed its actual preview load before the component enables its switch. */
export async function confirmImageImports(page:Page,options:{names:string[];destination?:'current'|'new';openIndex?:number;close?:boolean}) {
 const dialog=page.getByRole('dialog',{name:'Import image',exact:true});await expect(dialog).toBeVisible();
 // The public component owns the slotted body/footer; the native surface owns modal visibility.
 const controls=page.locator('en-dialog#editor-dialog');
 if(options.destination)await controls.getByRole('combobox',{name:'Import destination',exact:true}).selectOption(options.destination);
 const rows:Locator[]=[],seen=new Map<string,number>();
 for(const name of options.names){
  const occurrence=seen.get(name)??0;seen.set(name,occurrence+1);
  const row=controls.getByRole('listitem').filter({has:page.getByRole('heading',{name,exact:true})}).nth(occurrence);
  const toggle=row.getByRole('switch',{name:'Import '+name,exact:true});await expect(toggle).toBeEnabled();await toggle.check();rows.push(row);
 }
 const confirm=controls.getByRole('button',{name:'Import selected images ('+options.names.length+')',exact:true});await expect(confirm).toBeEnabled();await confirm.click();
 for(const row of rows)await expect(row.getByText(/^Saved in .+ at revision [0-9]+\.$/)).toBeVisible();
 if(options.openIndex!==undefined){const row=rows[options.openIndex];if(!row)throw Error('Choose an imported row to open.');await row.getByRole('button',{name:'Open imported document',exact:true}).click();await expect(page.locator('canvas[data-asset]')).not.toHaveAttribute('data-asset','');}
 if(options.close!==false){await controls.getByRole('button',{name:'Cancel',exact:true}).click();await expect(dialog).toBeHidden();}
}

export async function importReviewedImage(page:Page,path:string,name=path.split('/').at(-1)!,destination:'current'|'new'='new') {
 await page.getByRole('button',{name:'Import image',exact:true}).click();
 await expect(page.getByRole('dialog',{name:'Import image',exact:true})).toBeVisible();
 await page.locator('en-dialog#editor-dialog').locator('en-file-upload input[type=file]').setInputFiles(path);
 await confirmImageImports(page,{names:[name],destination,openIndex:0});
}
