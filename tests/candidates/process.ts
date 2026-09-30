import{fork}from'node:child_process';import{resolve}from'node:path';
// @ts-ignore Shared owned process lifecycle, with retained failures and finite shutdown.
import{ownServerProcess}from'../editor/completion/owned-process.mjs';
export function serverProcess(root:string){const child=fork(resolve('tests/candidates/process-fixture.mjs'),[root,resolve('dist/app')],{execArgv:['--import',resolve('tests/provider/no-egress.mjs')],env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR},stdio:['ignore','ignore','pipe','ipc']});return ownServerProcess(child,{});}
