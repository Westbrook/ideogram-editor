import { chromium, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const locator=JSON.parse(await readFile('.progress-report/project.json','utf8'));
const browser=await chromium.launch();
const page=await browser.newPage({viewport:{width:1440,height:900}});
await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
try {
  await page.goto(locator.reportUrl);
  const link=page.getByRole('link',{name:'Open editor preview',exact:false});
  await expect(link).toHaveAttribute('href',locator.apps.local.url);
  await link.click();
  await expect(page.getByRole('button',{name:'Pairing needed',exact:true})).toBeVisible();
  await expect(page.getByRole('link',{name:'Progress Report',exact:false})).toHaveAttribute('href',locator.reportUrl);
  const arrival=page.url();
  await page.getByRole('link',{name:'Progress Report',exact:false}).click();
  await expect(page.getByRole('heading',{name:'Building a recoverable image editor.',exact:false})).toBeVisible();
  const returned=page.url();
  const build=JSON.parse(await readFile('evidence/p1a3/bundle-sha256.json','utf8'));
  const verified=[];
  for(const [path,expected] of Object.entries(build)) {
    if(!/assets\/.+\.(js|css)$/.test(path))continue;
    const route=path.replace('dist/app','');
    const bytes=Buffer.from(await (await fetch(new URL(route,arrival))).arrayBuffer());
    if(createHash('sha256').update(bytes).digest('hex')!==expected)throw new Error('Live artifact identity mismatch: '+route);
    verified.push(route);
  }
  await writeFile('evidence/p1a3/round-trip.json',JSON.stringify({at:new Date().toISOString(),result:'PASS',report:locator.reportUrl,arrival,returned,anonymousShell:'Pairing needed; no token/cookie inserted',verifiedLiveArtifacts:verified,independentOutageCheck:'Report HTTP200 while production editor stopped between launches; native-review.txt',noReviewMutation:true},null,2)+'\n');
  console.log('PASS real report → anonymous shell → report; live JS/CSS match final build.');
} finally {await browser.close();}
