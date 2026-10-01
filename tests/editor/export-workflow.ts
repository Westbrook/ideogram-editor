import {expect,type Page} from '@playwright/test';

/** Public J6 controls, including the actual decoded preview before approval. */
export async function prepareNativePNG(page:Page){
 await page.getByRole('button',{name:'Export image',exact:true}).click();
 await expect(page.getByRole('dialog',{name:'Export image',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Prepare export preview',exact:true}).click();
 await expect(page.locator('#export-preview')).toBeVisible();
 await page.getByRole('button',{name:'Confirm reviewed export',exact:true}).click();
 await expect(page.getByRole('dialog',{name:'Export image',exact:true})).toBeHidden();
 await expect(page.getByRole('region',{name:'Prepared file'})).toContainText('PNG');
}
