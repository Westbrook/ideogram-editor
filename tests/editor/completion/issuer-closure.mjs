import assert from 'node:assert/strict';
import {posix} from 'node:path';

const local=(from,value)=>{
 const clean=value.trim().replace(/^(['"])(.*)\1$/,'$2');
 assert(clean&&!/^(?:[a-z]+:|\/\/|#)/i.test(clean),'Only closed local document/CSS assets: '+clean);
 assert(!clean.includes('?')&&!clean.includes('#'),'Exact asset reference without suffix');
 const path=clean.startsWith('/')?'dist/app'+clean:posix.normalize(posix.join(posix.dirname(from),clean));
 assert(path.startsWith('dist/app/'),'Asset stays inside application output');return path;
};
export function emittedClosure({read,pins}){
 const files=new Set(pins.map(p=>p.path)),html='dist/app/index.html';
 const documentEdges=[...read(html).toString().matchAll(/(?:src|href)="([^"]+)"/g)].map(m=>m[1]).filter(Boolean);
 for(const edge of documentEdges)assert(files.has(local(html,edge)),'Closed HTML asset '+edge);
 const css=pins.filter(p=>p.path.startsWith('dist/app/')&&p.path.endsWith('.css')).map(p=>p.path).sort();
 const cssEdges=css.flatMap(path=>[...read(path).toString().matchAll(/url\(([^)]+)\)|@import\s+(['"])([^'"]+)\2/g)].map(m=>({path,value:m[1]??m[3]})));
 for(const edge of cssEdges)assert(files.has(local(edge.path,edge.value)),'Closed CSS asset '+edge.value);
 const scripts=documentEdges.filter(edge=>edge.endsWith('.js')).map(edge=>local(html,edge));
 const manifest=JSON.parse(read('dist/app/.vite/manifest.json'));
 const entry=manifest['index.html'];assert(entry?.isEntry&&entry.src==='index.html','Authoritative Vite HTML entry');
 const entryPath=local(html,'/'+entry.file);assert(scripts.includes(entryPath),'Vite entry is a real HTML script');
 for(const row of Object.values(manifest))for(const path of [row.file,...row.css??[],...row.assets??[]])assert(files.has(local(html,'/'+path)),'Closed Vite manifest output '+path);
 for(const path of entry.css??[])assert(css.includes(local(html,'/'+path)),'Entry stylesheet is inventoried');
 return {documentEdges,cssEdges,css,entryPath};
}
