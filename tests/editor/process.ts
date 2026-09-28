import {fork} from 'node:child_process';
import {resolve} from 'node:path';
// @ts-ignore Test-owned process lifecycle shared with non-product controls.
import {ownServerProcess} from './completion/owned-process.mjs';
export async function serverProcess(root:string,maxPageCount?:number,completionLedger?:string){
 const process=fork(resolve(completionLedger?'tests/editor/process-completion-fixture.mjs':'tests/editor/process-fixture.mjs'),[root,resolve('dist/app'),maxPageCount?String(maxPageCount):'',completionLedger??''],{execArgv:['--import',resolve('tests/protocol/no-effects.mjs')],env:{PATH:globalThis.process.env.PATH,TMPDIR:globalThis.process.env.TMPDIR},stdio:['ignore','ignore','pipe','ipc']});
 return ownServerProcess(process,{completion:!!completionLedger});
}
