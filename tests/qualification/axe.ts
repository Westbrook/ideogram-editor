import axe,{type AxeResults} from 'axe-core';
import {expect,type Page,type TestInfo} from '@playwright/test';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';

const version='4.13.0';
const tags=['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa'];
const sources=[
  'https://www.npmjs.com/package/axe-core',
  'https://github.com/dequelabs/axe-core/blob/v4.13.0/doc/API.md',
  'https://playwright.dev/docs/accessibility-testing',
];

/**
 * Whole-document scans, with no excluded panels, disabled rules, severity
 * threshold, rule overrides or automatic incomplete-result adjudication.
 * Actual product states must be opened through public controls before scan().
 */
export async function axeEvidence(page:Page,info:TestInfo,output:string,planned:readonly string[],limitations:readonly string[]){
  expect(axe.version,'Installed engine must match the reviewed exact pin').toBe(version);
  const lock=JSON.parse(await readFile('package-lock.json','utf8'));
  const entry=lock.packages['node_modules/axe-core'];
  expect(entry.version).toBe(version);
  expect(lock.packages[''].devDependencies['axe-core']).toBe(version);
  const directory=join(output,'axe');await mkdir(directory,{recursive:true});
  const identity={version,integrity:entry.integrity,sourceSha256:createHash('sha256').update(axe.source).digest('hex'),sources,tags,context:'document',excludedPanels:[],disabledRules:[]};
  await writeFile(join(directory,'engine.json'),JSON.stringify(identity,null,2));
  // Playwright's documented page evaluation API loads the pinned local engine;
  // no script tag, remote CDN, CSP bypass option or application change is used.
  await page.evaluate(axe.source);
  type State={state:string;violations:number;incomplete:number;passes:number;inapplicable:number;resultSha256:string;manualAdjudication:'required'|'no-incomplete-results';};
  const states:State[]=[],incomplete:{state:string;results:AxeResults['incomplete']}[]=[];
  let completed=false;
  const save=async()=>{
    await writeFile(join(directory,'incomplete-review.json'),JSON.stringify({status:incomplete.length?'manual-adjudication-required':'no-incomplete-results',adjudications:[],states:incomplete},null,2));
    await writeFile(join(directory,'coverage.json'),JSON.stringify({
      identity,planned,states,notScanned:planned.filter(state=>!states.some(s=>s.state===state)),
      executionCompleted:completed,automatedViolations:states.reduce((n,s)=>n+s.violations,0),
      manualAdjudicationRequired:incomplete.length>0,limitations,
      ax01Complete:false,
      disposition:'Automated scan evidence only. Full AX01 requires all specified states and manual adjudication; native AT/IME remain separate.',
    },null,2));
  };
  await save();
  return {
    async scan(state:string){
      if(!planned.includes(state)||states.some(s=>s.state===state))throw Error('Unplanned or duplicate axe scan: '+state);
      await page.evaluate(async()=>{await document.fonts.ready;});
      const results=await page.evaluate(async runTags=>{
        const engine=(window as unknown as {axe:typeof axe}).axe;
        return engine.run(document,{runOnly:{type:'tag',values:runTags},resultTypes:['violations','incomplete','passes','inapplicable']});
      },tags);
      expect(results.testEngine.version).toBe(version);
      const raw=JSON.stringify(results,null,2),file=join(directory,state+'.json');
      await writeFile(file,raw);await info.attach('axe-'+state,{path:file,contentType:'application/json'});
      await writeFile(join(directory,state+'.aria.txt'),await page.locator('body').ariaSnapshot());
      states.push({state,violations:results.violations.length,incomplete:results.incomplete.length,passes:results.passes.length,inapplicable:results.inapplicable.length,resultSha256:createHash('sha256').update(raw).digest('hex'),manualAdjudication:results.incomplete.length?'required':'no-incomplete-results'});
      if(results.incomplete.length)incomplete.push({state,results:results.incomplete});
      await save();
      expect.soft(results.violations.map(rule=>({id:rule.id,impact:rule.impact,help:rule.help,helpUrl:rule.helpUrl,nodes:rule.nodes.map(node=>({target:node.target,failureSummary:node.failureSummary}))})),state+': zero unresolved applicable WCAG A/AA violations').toEqual([]);
    },
    async finish(){completed=true;await save();expect(states.map(s=>s.state)).toEqual([...planned]);},
  };
}
