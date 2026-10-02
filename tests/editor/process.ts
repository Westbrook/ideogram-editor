import {fork} from 'node:child_process';
import {resolve} from 'node:path';
// @ts-ignore Test-owned process lifecycle shared with non-product controls.
import {ownServerProcess} from './completion/owned-process.mjs';
export async function serverProcess(root:string,maxPageCount?:number,completionLedger?:string){
 // Forward only the two runner-owned receipt paths. A supplied invalid value
 // must still reach the strict loader; never silently fall back to old identity.
 const completionEnvironment=completionLedger?Object.fromEntries(['COMPLETION_APPLICATION_IDENTITY','COMPLETION_ISSUER_MANIFEST'].filter(name=>Object.hasOwn(globalThis.process.env,name)).map(name=>[name,globalThis.process.env[name]])):{};
 const process=fork(resolve(completionLedger?'tests/editor/process-completion-fixture.mjs':'tests/editor/process-fixture.mjs'),[root,resolve('dist/app'),maxPageCount?String(maxPageCount):'',completionLedger??''],{execArgv:['--import',resolve('tests/protocol/no-effects.mjs')],env:{PATH:globalThis.process.env.PATH,TMPDIR:globalThis.process.env.TMPDIR,...completionEnvironment},stdio:['ignore','ignore','pipe','ipc']});
 return ownServerProcess(process,{completion:!!completionLedger});
}
