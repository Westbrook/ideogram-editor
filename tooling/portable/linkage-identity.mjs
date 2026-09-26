import {execFileSync} from 'node:child_process';
import {readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
export const base='5dab27df7555606d6ee09c21bad62015f0ed8d96';
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export const entry=path=>{const bytes=readFileSync(path);return {path,bytes:bytes.length,sha256:sha(bytes)};};
export const walk=path=>readdirSync(path,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path+'/'+e.name):[path+'/'+e.name]);
export function source(){
 const files=[...new Set([...execFileSync('git',['diff','--name-only',base],{encoding:'utf8'}).trim().split('\n'),...execFileSync('git',['ls-files','--others','--exclude-standard'],{encoding:'utf8'}).trim().split('\n')])].filter(p=>p&&!p.startsWith('evidence/')).sort().map(entry);
 return {base,branch:execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim(),sourceIdentity:'sha256:'+sha(JSON.stringify(files)),files};
}
