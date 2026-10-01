// Test-only preload: inject failures at actual output descriptor boundaries.
import fs from 'node:fs';
import{syncBuiltinESMExports}from'node:module';
const code=process.env.IE_TEST_OUTPUT_CODE,boundary=process.env.IE_TEST_OUTPUT_BOUNDARY;
if(!['ENOSPC','EDQUOT','EIO'].includes(code)||!['open','fsync'].includes(boundary))throw Error('Invalid output fault fixture');
const open=fs.openSync,fsync=fs.fsyncSync,owned=new Set();
fs.openSync=function(path,flags,...rest){const output=typeof path==='string'&&path.endsWith('/pixels.rgba')&&typeof flags==='number'&&(flags&fs.constants.O_CREAT);
 if(output&&boundary==='open')throw Object.assign(Error(code+' injected output open'),{code,syscall:'open'});
 const fd=Reflect.apply(open,fs,[path,flags,...rest]);if(output)owned.add(fd);return fd;
};
fs.fsyncSync=function(fd){if(boundary==='fsync'&&owned.has(fd))throw Object.assign(Error(code+' injected output fsync'),{code,syscall:'fsync'});return Reflect.apply(fsync,fs,[fd]);};
syncBuiltinESMExports();
