import {expect,type Page} from '@playwright/test';
export async function alignment(page:Page){
 const group=page.locator('.pan-fields');
 const button=group.locator('en-button');
 await expect(group.getByRole('button',{name:'Apply view',exact:true})).toBeVisible();
 await expect(button).toHaveCSS('align-self','end');
 const boxes=await group.evaluate(node=>{
  const rect=(el:Element)=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
  return {group:rect(node),button:rect(node.querySelector('en-button')!),fields:[...node.querySelectorAll('en-number-field')].map(rect),viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth,alignSelf:getComputedStyle(node.querySelector('en-button')!).alignSelf};
 });
 expect(boxes.scrollWidth).toBeLessThanOrEqual(boxes.viewport);
 expect(boxes.button.width).toBeGreaterThan(20);expect(boxes.button.height).toBeGreaterThan(20);
 expect(boxes.button.x).toBeGreaterThanOrEqual(0);expect(boxes.button.right).toBeLessThanOrEqual(boxes.viewport+1);
 const sameRow=boxes.fields.filter(f=>f.y<boxes.button.bottom&&f.bottom>boxes.button.y);
 for(const f of sameRow){
  expect(Math.abs(f.bottom-boxes.button.bottom),'same-row field and button bottoms align').toBeLessThanOrEqual(1);
  expect(boxes.button.x>=f.right-1||boxes.button.right<=f.x+1,'button does not overlap a field').toBe(true);
 }
 return boxes;
}
