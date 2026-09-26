import{spawnSync}from'node:child_process';import{writeFileSync}from'node:fs';
const gates=['verify:raster','typecheck','build','verify:vendor','test:vendor','test:raster','test:assets','test:protocol','test:session','test:store','test:recovery','test:shell','test:raster:browser','test:assets:volume','test:store:volume','test:consumer'];
const tag=process.argv[2]??'sealed';
const result={startedAt:new Date().toISOString(),qualification:false,gates:[]};
for(const gate of gates){const start=performance.now(),at=new Date().toISOString();const r=spawnSync('npm',['run',gate],{encoding:'utf8',env:process.env,maxBuffer:64*1024*1024});const log='evidence/p1b4/logs/'+tag+'-'+gate.replaceAll(':','-')+'.txt';writeFileSync(log,(r.stdout??'')+(r.stderr??''));result.gates.push({command:'npm run '+gate,at,elapsedMs:performance.now()-start,exit:r.status,log});writeFileSync('evidence/p1b4/gates-'+tag+'.json',JSON.stringify(result,null,2)+'\n');console.log(gate,r.status);if(r.status!==0){process.exitCode=1;break;}}
result.finishedAt=new Date().toISOString();writeFileSync('evidence/p1b4/gates-'+tag+'.json',JSON.stringify(result,null,2)+'\n');
