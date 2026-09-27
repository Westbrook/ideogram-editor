import {execFileSync} from 'node:child_process';
import {readFileSync,lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
export const base='d3b8e5f5ec4568547f21a2826792450367144a17';
export const sha=b=>createHash('sha256').update(b).digest('hex');
export const entry=path=>{const b=readFileSync(path);return {path,bytes:b.length,sha256:sha(b)};};
export function source(){const paths=execFileSync('git',['ls-files','-z','--cached','--others','--exclude-standard','src','server','tests','tooling','package.json','package-lock.json','tsconfig*.json','vite*.ts'],{encoding:'utf8'}).split('\0').filter(p=>p&&!p.includes('/evidence/')&&!p.includes('/artifacts/')&&lstatSync(p).isFile());const files=[...new Set(paths)].sort().map(entry);return {at:new Date().toISOString(),base,head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),files,identity:sha(JSON.stringify(files))};}
