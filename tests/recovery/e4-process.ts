import {fork} from 'node:child_process';import {resolve} from 'node:path';
// @ts-ignore Test-only owned process lifecycle.
import {ownServerProcess} from '../editor/completion/owned-process.mjs';
export function serverProcess(root:string,onChild?:(child:ReturnType<typeof fork>)=>void){const child=fork(resolve('tests/recovery/e4-process.mjs'),[root,resolve('dist/app')],{execArgv:['--import',resolve('tests/provider/no-egress.mjs')],env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR},stdio:['ignore','ignore','pipe','ipc']});onChild?.(child);return ownServerProcess(child,{});}
