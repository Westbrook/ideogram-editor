import test from 'node:test';
import assert from 'node:assert/strict';
import {storageEnvironment} from '../../tooling/qualification/development-environment.mjs';
test('macOS prerequisite checks the temporary device using read-only commands',()=>{
 const calls=[];const value=storageEnvironment({platform:'darwin',temporary:'/private/tmp',run:(command,args)=>{calls.push([command,args]);return {status:0,stdout:command==='/bin/df'?'Filesystem blocks\n/dev/disk3s5 123 12 111 /System/Volumes/Data\n':'<key>FilesystemType</key><string>apfs</string>'};}});
 assert.equal(value.probe,'PASS');assert.deepEqual(calls,[['/bin/df',['-P','/private/tmp']],['/usr/sbin/diskutil',['info','-plist','/dev/disk3s5']]]);
});
test('a blocked framework or unsupported temporary root fails at the prerequisite',()=>{
 assert.throws(()=>storageEnvironment({platform:'darwin',run:()=>({status:1,stderr:'DiskManagement unavailable'})}),/Storage environment prerequisite failed/);
 assert.throws(()=>storageEnvironment({platform:'darwin',run:()=>({status:0,stdout:'remote:/share 1 1 1 /tmp'})}),/local disk/);
});
test('other platforms do not invoke macOS tooling',()=>{
 assert.equal(storageEnvironment({platform:'linux',run:()=>{throw Error('must not run');}}).probe,'not-applicable');
});
