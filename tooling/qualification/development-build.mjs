import {spawnSync} from 'node:child_process';
import {versions} from './manifest.mjs';

// Internal producers: the owning development plan has already verified vendor
// and public imports. Standalone npm build commands retain their own guards.
if(process.versions.node!==versions.node)throw Error(`Use Node ${versions.node}`);
const kind=process.argv[2];
const steps=kind==='app'?[['tooling/theme/density.mjs'],['node_modules/vite/bin/vite.js','build','--config','vite.app.config.ts']]
 :kind==='consumer'?[['node_modules/vite/bin/vite.js','build']]:null;
if(!steps||process.argv.length!==3)throw Error('Choose internal app or consumer producer');
for(const args of steps){
 // npm supplies its real user-agent/toolchain identity to the build receipt.
 // --no refuses an implicit package download; the verified install owns Vite.
 const vite=args[0]==='node_modules/vite/bin/vite.js';
 const result=spawnSync(vite?'npm':process.execPath,vite?['exec','--no','--','vite',...args.slice(1)]:args,{stdio:'inherit',env:process.env});
 if(result.error)throw result.error;
 if(result.status!==0){process.exitCode=result.status??1;break;}
}
