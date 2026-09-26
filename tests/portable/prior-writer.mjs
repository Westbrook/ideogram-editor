// Actual prior executable, compiled only in an isolated temporary directory.
import {execFileSync} from 'node:child_process';
import {writeFile,symlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {rootFor,command} from '../store/helpers.mjs';
import {startLocalServer} from '../../dist/local/server/http.js';
import {pair,call,cookieFrom,readHeaders,mutationHeaders} from '../session/helpers.mjs';
import {EMPTY_EXPECTED_VERSIONS} from '../../dist/local/src/protocol/store.js';
export const priorCommit='d4ed76148999978565ca8b37d27612f5b3faa591';
export async function priorWriter(t){
 const directory=await rootFor(t);execFileSync('git',['archive','--output='+join(directory,'source.tar'),priorCommit,'server','src','tests','tooling','tsconfig.server.json']);execFileSync('tar',['-xf',join(directory,'source.tar'),'-C',directory]);await symlink(resolve('node_modules'),join(directory,'node_modules'));await writeFile(join(directory,'package.json'),'{"type":"module"}');execFileSync(resolve('node_modules/.bin/tsc'),['-p',join(directory,'tsconfig.server.json')]);
 const load=path=>import(pathToFileURL(join(directory,path)).href);
 const [portable,raster,store,writer,archiveTools]=await Promise.all([load('tests/portable/helpers.mjs'),load('tests/raster/helpers.mjs'),load('tests/store/helpers.mjs'),load('dist/local/server/storage/writer.js'),load('tests/portable/archive-fixture.mjs')]);return {directory,...portable,...{importRaster:raster.importRaster,childFor:store.childFor,openWriter:writer.openWriter,archive:archiveTools}};
}
export async function reopen(t,root,cookie){const server=await startLocalServer({root});t.after(()=>server.close());const paired=cookie?await call(server.origin,'/api/v1/session/bootstrap',{method:'POST',headers:{Origin:server.origin,Cookie:cookie},body:{protocolVersion:1,pairingToken:new URL(server.issuePairingURL()).hash.slice(9)}}):await pair(server);return {root,server,paired,
 read:(path,headers={})=>call(server.origin,path,{headers:{...readHeaders(cookieFrom(paired)),...headers}}),post:(path,body,headers={})=>call(server.origin,path,{method:'POST',body,headers:{...mutationHeaders(server,paired),...headers}}),command:(patch={},body={})=>command(EMPTY_EXPECTED_VERSIONS,{clientId:paired.json.clientId,...patch},body)};}
