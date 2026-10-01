import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';

// Read-only probe for the same macOS volume-information service used by store
// admission. A blocked service should fail once before builds, not time out in
// each transaction/crash fixture. This is not a filesystem durability claim.
export function storageEnvironment({platform=process.platform,temporary=tmpdir(),run=spawnSync}={}){
 if(platform!=='darwin')return {kind:'storage-environment-1',platform,probe:'not-applicable',qualification:false};
 function read(command,args){
  const result=run(command,args,{encoding:'utf8',timeout:5000,env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LC_ALL:'C'}});
  if(result.error||result.status!==0)throw Error(`Storage environment prerequisite failed: ${command}: ${result.error?.message??result.stderr}`);
  return result.stdout;
 }
 const device=read('/bin/df',['-P',temporary]).trim().split('\n').at(-1).split(/\s+/)[0];
 if(!/^\/dev\/disk[0-9]+(?:s[0-9]+)*$/.test(device))throw Error('Storage environment prerequisite: temporary directory must use a local disk');
 const info=read('/usr/sbin/diskutil',['info','-plist',device]);
 if(!/<key>FilesystemType<\/key>\s*<string>(apfs|hfs)<\/string>/.test(info))throw Error('Storage environment prerequisite: unsupported temporary filesystem');
 return {kind:'storage-environment-1',platform,device,probe:'PASS',qualification:false};
}
if(import.meta.main)console.log(JSON.stringify(storageEnvironment()));
