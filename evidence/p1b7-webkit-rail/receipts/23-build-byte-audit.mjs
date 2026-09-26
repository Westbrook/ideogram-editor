import {readFile,readdir,writeFile} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
const files=[];for(const name of await readdir('dist/app/assets')){if(!/\.(js|css)$/.test(name))continue;const path='dist/app/assets/'+name,bytes=await readFile(path);files.push({path,bytes:bytes.length,gzipBytes:gzipSync(bytes).length,sha256:createHash('sha256').update(bytes).digest('hex'),group:name.startsWith('editor-panels-')?'explicit lazy panel':name.endsWith('.css')?'css':'startup JavaScript'});}
const sum=group=>({raw:files.filter(x=>x.group===group).reduce((n,x)=>n+x.bytes,0),gzip:files.filter(x=>x.group===group).reduce((n,x)=>n+x.gzipBytes,0)});
const result={method:'Actual emitted filesystem bytes; Node gzipSync defaults, per-file sum. Single artifact only; no evaluated-module/resource/timing campaign.',node:process.version,zlib:process.versions.zlib,startup:sum('startup JavaScript'),lazy:sum('explicit lazy panel'),css:sum('css'),files};await writeFile(new URL('./23-build-byte-audit.json',import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
