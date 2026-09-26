import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {source,sha,entry,walk} from './identity.mjs';
const directory='evidence/p1b5',current=source();
if(process.argv.includes('--verify')){
 const saved=JSON.parse(readFileSync(directory+'/source-manifest.json'));
 assert.deepEqual(current,saved,'Final source identity changed');
 const gates=JSON.parse(readFileSync(directory+'/final-gates.json'));assert.equal(gates.source.sourceIdentity,saved.sourceIdentity);assert.equal(gates.finalSource.sourceIdentity,saved.sourceIdentity);assert(gates.gates.every(g=>g.exit===0));
 const lines=readFileSync(directory+'/SHA256SUMS','utf8').trim().split('\n');for(const line of lines){const [hash,path]=line.split('  ');assert.equal(sha(readFileSync(directory+'/'+path)),hash,path);}
 console.log(JSON.stringify({sourceIdentity:saved.sourceIdentity,sourceFiles:saved.files.length,seals:lines.length,gates:gates.gates.length,status:'verified'}));
}else{
 writeFileSync(directory+'/source-manifest.json',JSON.stringify(current,null,2)+'\n');
 if(!process.argv.includes('--source')){
  writeFileSync(directory+'/build-manifest.json',JSON.stringify({at:new Date().toISOString(),sourceIdentity:current.sourceIdentity,node:entry(process.execPath),versions:process.versions,outputs:walk('dist/local').sort().map(entry)},null,2)+'\n');
  const paths=walk(directory).filter(p=>!p.endsWith('/SHA256SUMS')).sort();writeFileSync(directory+'/SHA256SUMS',paths.map(p=>sha(readFileSync(p))+'  '+p.slice(directory.length+1)).join('\n')+'\n');
 }
 console.log(JSON.stringify({sourceIdentity:current.sourceIdentity,sourceFiles:current.files.length}));
}
