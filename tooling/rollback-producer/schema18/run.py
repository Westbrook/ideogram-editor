#!/usr/bin/env python3
"""Run the separately sealed Linux producer with controlled imports.
The operator must retain/check this launcher's identity before executing it.
No neighboring directory is added to sys.path, including for imported stdlib.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys

NAMES = ['packet.py','transport.py','linux_transport_exact.py','owned_process.py','metadata_policy.py','toolchain.py','linux_host.py','linux_build.py','linux_build_evidence.py',
         'source_reconstitution.py','prepare_source_input.py','foreign_source.py','runtime-selection.mjs','proof.mjs',
         'proof-library-policy.mjs','test_evidence.py','run.py']
ORDER = ['linux_transport_exact','owned_process','transport','toolchain','linux_host','source_reconstitution','prepare_source_input','foreign_source','linux_build','linux_build_evidence','metadata_policy','packet']

def require(value,message):
    if not value:raise ValueError(message)

def read(path,maximum):
    require(path.is_absolute() and path==path.resolve(strict=True),'Canonical producer path required')
    require(all(p.is_dir() and not p.is_symlink() for p in path.parents),'Linked producer ancestor')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        before=os.fstat(fd);require(stat.S_ISREG(before.st_mode) and before.st_nlink==1 and 0<=before.st_size<=maximum,'Producer member shape/bound')
        data=bytearray()
        while chunk:=os.read(fd,min(1048576,maximum+1-len(data))):
            data.extend(chunk);require(len(data)<=maximum,'Producer member grew')
        identity=lambda s:(s.st_dev,s.st_ino,s.st_mode,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
        require(len(data)==before.st_size and identity(before)==identity(os.fstat(fd))==identity(path.lstat()),'Producer member changed')
        return bytes(data)
    finally:os.close(fd)

def pairs(values):
    result={}
    for key,value in values:
        require(key not in result,'Duplicate producer seal key');result[key]=value
    return result

def main():
    require(sys.flags.isolated and sys.flags.no_site and sys.dont_write_bytecode and sys.flags.optimize==0,
            'Use isolated unoptimized python3 -I -S -B')
    args=sys.argv[1:];require(len(args)>=3 and args[0]=='--seal-sha256','Explicit reviewed seal SHA-256 required')
    root=Path(__file__).resolve().parent;seal_bytes=read(root/'producer-seal.json',1048576)
    require(args[1]=='sha256:'+hashlib.sha256(seal_bytes).hexdigest(),'Producer seal differs')
    seal=json.loads(seal_bytes,object_pairs_hook=pairs)
    require(set(seal)=={'kind','storageVersion','status','files'} and seal['kind']=='linux-rollback-producer-source-seal-1' and seal['storageVersion'] in (17,18) and seal['status']=='source-only-unexecuted' and set(seal['files'])==set(NAMES),'Unsupported source seal')
    sources={}
    for name in NAMES:
        row=seal['files'][name];require(set(row)=={'hash','byteLength'},'Unexpected seal fields')
        data=read(root/name,2*1024**2)
        require(row=={'hash':'sha256:'+hashlib.sha256(data).hexdigest(),'byteLength':str(len(data))},'Producer source differs: '+name)
        sources[name]=data
    # Use captured bytes only after all files pass; adjacent modules are never
    # discoverable. Only these explicit imports enter the module registry.
    for name in ORDER:
        require(name not in sys.modules,'Unexpected preloaded producer module')
        path=root/(name+'.py');spec=importlib.util.spec_from_file_location(name,path)
        module=importlib.util.module_from_spec(spec);sys.modules[name]=module
        exec(compile(sources[name+'.py'],str(path),'exec',dont_inherit=True),module.__dict__)
    def stable_sources():
        require(read(root/'producer-seal.json',1048576)==seal_bytes,'Producer seal changed during execution')
        for name,data in sources.items():
            require(read(root/name,2*1024**2)==data,'Producer helper changed during execution: '+name)
    sys.modules['packet'].assert_producer_sources = stable_sources
    sys.argv=[str(root/'packet.py'),*args[2:]]
    stable_sources()
    sys.modules['packet'].main()
    stable_sources()

if __name__=='__main__':main()
