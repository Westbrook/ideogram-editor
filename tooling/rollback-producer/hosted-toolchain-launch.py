#!/usr/bin/env python3
"""Fixed root bootstrap stub: authenticate, attach, then exec original setpriv.

No producer code runs as root. No build, restore, arbitrary action, shell or
caller-selected executable is admitted. The inherited stdout handshake is sent
only after the actual cgroup membership has been read back.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys

MAX_CONFIG=4*1024*1024

def require(ok,code):
    if not ok:raise ValueError(code)

def read(path,maximum,immutable=False):
    path=Path(path);require(path.is_absolute() and path.resolve(strict=True)==path,'LAUNCH_CANONICAL')
    if immutable:
        for item in [path,*path.parents]:
            value=item.lstat();require(value.st_uid==0 and not stat.S_IMODE(value.st_mode)&0o022,'LAUNCH_IMMUTABLE')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC|os.O_NONBLOCK)
    try:
        before=os.fstat(fd);chunks=[];total=0
        if immutable:require(stat.S_ISREG(before.st_mode) and before.st_nlink==1 and before.st_size<=maximum,'LAUNCH_FILE')
        while True:
            chunk=os.read(fd,min(16384,maximum+1-total))
            if not chunk:break
            total+=len(chunk);require(total<=maximum,'LAUNCH_READ_BOUND');chunks.append(chunk)
        if immutable:
            require(stat.S_ISREG(before.st_mode) and before.st_nlink==1,'LAUNCH_FILE')
            stamp=lambda s:(s.st_dev,s.st_ino,s.st_mode,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
            require(stamp(before)==stamp(os.fstat(fd))==stamp(path.lstat()) and total==before.st_size,'LAUNCH_DRIFT')
        return b''.join(chunks)
    finally:os.close(fd)

def read_process(name,maximum):
    require(sys.platform=='linux','LAUNCH_PROCESS_PLATFORM')
    require(isinstance(name,str) and name in ('cgroup','mountinfo','stat'),'LAUNCH_PROCESS_FILE')
    # /proc/self is a kernel symlink. Address only this live process by its
    # kernel PID; preserve canonical-path, O_NOFOLLOW and bounded read checks.
    return read(Path('/proc')/str(os.getpid())/name,maximum)

def decode(raw):
    def pairs(rows):
        value={}
        for key,item in rows:require(key not in value,'LAUNCH_DUPLICATE');value[key]=item
        return value
    def invalid(_):raise ValueError('LAUNCH_NUMBER')
    return json.loads(raw,object_pairs_hook=pairs,parse_constant=invalid)

def plan(config,config_path,grant,group,device,inode):
    require(config.get('kind')=='hosted-native-controller-config-1' and re.fullmatch('ie-native-[a-f0-9]{32}',config.get('runId','')),'LAUNCH_CONFIG')
    root=Path(config['controlRoot']);require(root.is_absolute() and root.resolve(strict=True)==root,'LAUNCH_ROOT')
    owner=config['owner'];require(set(owner)=={'uid','gid','groups'} and type(owner['uid']) is int and type(owner['gid']) is int and 0<owner['uid']<2**32-1 and 0<owner['gid']<2**32-1 and owner['groups']==[],'LAUNCH_OWNER')
    require(re.fullmatch('ideogram-toolchain-'+config['runId'][10:]+'-[a-f0-9]{32}',group.name) and type(device) is int and device>=0 and type(inode) is int and inode>0,'LAUNCH_GROUP')
    args=['--reuid='+str(owner['uid']),'--regid='+str(owner['gid']),'--clear-groups','--inh-caps=-all','--ambient-caps=-all','--bounding-set=-all','--no-new-privs','--',config['tools']['python']['path'],'-I','-S','-B',str(root/'tooling/rollback-producer/hosted-worker.py'),'--config',str(config_path),'--grant',grant,'--action','toolchain']
    return config['tools']['setpriv']['path'],args

def hierarchy(membership,mountinfo):
    def canonical(value):
        return isinstance(value,str) and len(value)<=4096 and value.startswith('/') and not value.startswith('//') and '\\' not in value and not re.search('[\x00-\x20\x7f]',value) and str(Path(value))==value and '..' not in Path(value).parts
    rows=membership.splitlines();require(len(rows)==1 and rows[0].startswith('0::'),'LAUNCH_UNIFIED');current=rows[0][3:];require(canonical(current),'LAUNCH_MEMBERSHIP')
    mounts=[]
    for line in mountinfo.splitlines():
        fields=line.split(' ')
        if '-' not in fields:continue
        sep=fields.index('-')
        if len(fields)<=sep+1 or fields[sep+1]!='cgroup2':continue
        require(len(fields)>sep+3 and canonical(fields[3]) and canonical(fields[4]),'LAUNCH_MOUNT_SHAPE');mounts.append((fields,sep))
    require(len(mounts)==1,'LAUNCH_MOUNT_AMBIGUOUS');fields,sep=mounts[0]
    require(fields[3]=='/','LAUNCH_HIDDEN_ANCESTRY');require('rw' in fields[5].split(',') and 'rw' in fields[sep+3].split(','),'LAUNCH_READ_ONLY')
    mount=Path(fields[4]);parent=mount/current.lstrip('/');ancestors=[];item=parent
    while True:
        require(len(ancestors)<128 and (item==mount or mount in item.parents),'LAUNCH_ANCESTOR_BOUND');ancestors.append(item)
        if item==mount:break
        item=item.parent
    return {'parent':parent,'mount':mount,'ancestors':ancestors,'membership':current}

def authenticate_hierarchy(layout):
    for path in layout['ancestors']:
        info=path.lstat();require(path.resolve(strict=True)==path and stat.S_ISDIR(info.st_mode) and info.st_uid==0 and not stat.S_IMODE(info.st_mode)&0o022,'LAUNCH_ANCESTOR_OWNER')
        info=(path/'cgroup.procs').lstat();require(stat.S_ISREG(info.st_mode) and info.st_uid==0 and not stat.S_IMODE(info.st_mode)&0o022,'LAUNCH_ANCESTOR_CONTROL')

def main(argv):
    require(sys.platform=='linux' and os.getuid()==os.geteuid()==0 and sys.flags.isolated and sys.flags.no_site and sys.dont_write_bytecode and not sys.flags.optimize,'LAUNCH_ROOT_RUNTIME')
    parser=argparse.ArgumentParser(add_help=False);parser.add_argument('--config',required=True);parser.add_argument('--grant',required=True);parser.add_argument('--group',required=True);parser.add_argument('--group-dev',required=True);parser.add_argument('--group-ino',required=True)
    args=parser.parse_args(argv);require(re.fullmatch('[a-f0-9]{64}',args.grant) and re.fullmatch('[0-9]+',args.group_dev) and re.fullmatch('[1-9][0-9]*',args.group_ino),'LAUNCH_ARGUMENT')
    raw=read(args.config,MAX_CONFIG,True);require(hashlib.sha256(raw).hexdigest()==args.grant,'LAUNCH_GRANT');config=decode(raw)
    group=Path(args.group);device,inode=int(args.group_dev),int(args.group_ino)
    executable,arguments=plan(config,args.config,args.grant,group,device,inode)
    source=Path(__file__).resolve(strict=True);require(source==Path(config['controlRoot'])/'tooling/rollback-producer/hosted-toolchain-launch.py' and isinstance(config['sources'],list) and len(config['sources'])<=256,'LAUNCH_SOURCE_ROOT');rows=[row for row in config['sources'] if row['path']==str(source)];require(len(rows)==1,'LAUNCH_SOURCE')
    body=read(source,131072,True);require(len(body)==rows[0]['bytes'] and hashlib.sha256(body).hexdigest()==rows[0]['sha256'],'LAUNCH_SOURCE_PIN')
    # Immutable selected tools were authenticated by the root controller before
    # this launch; re-read their exact pins before the privileged exec transition.
    for name in ('setpriv','python'):
        row=config['tools'][name];body=read(row['path'],256*1024**2,True);require(len(body)==row['bytes'] and hashlib.sha256(body).hexdigest()==row['sha256'],'LAUNCH_TOOL_PIN')
    for item in [group,*group.parents]:
        value=item.lstat();require(item.resolve(strict=True)==item and stat.S_ISDIR(value.st_mode) and value.st_uid==0 and not stat.S_IMODE(value.st_mode)&0o022,'LAUNCH_GROUP_ANCESTRY')
    value=group.lstat();require((value.st_dev,value.st_ino)==(device,inode),'LAUNCH_GROUP_IDENTITY')
    layout=hierarchy(read_process('cgroup',131072).decode('ascii'),read_process('mountinfo',131072).decode('ascii'));require(layout['parent']==group.parent,'LAUNCH_PARENT_BINDING');authenticate_hierarchy(layout);parent_membership=layout['membership']
    control=group/'cgroup.procs';value=control.lstat();require(stat.S_ISREG(value.st_mode) and value.st_uid==0 and not stat.S_IMODE(value.st_mode)&0o022,'LAUNCH_CONTROL')
    fd=os.open(control,os.O_WRONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        raw=(str(os.getpid())+'\n').encode('ascii');require(os.write(fd,raw)==len(raw),'LAUNCH_ATTACH_WRITE')
    finally:os.close(fd)
    require((group.lstat().st_dev,group.lstat().st_ino)==(device,inode),'LAUNCH_GROUP_REPLACED')
    members=read(control,65536).decode('ascii').split();require(len(members)<=4096 and str(os.getpid()) in members,'LAUNCH_ATTACH_READBACK')
    after=read_process('cgroup',131072).decode('ascii').splitlines();require(after==['0::'+parent_membership.rstrip('/')+'/'+group.name],'LAUNCH_ACTUAL_MEMBERSHIP')
    rawstat=read_process('stat',131072);require(b') ' in rawstat,'LAUNCH_STAT');tail=rawstat[rawstat.rfind(b') ')+2:].split();require(len(tail)>=20 and tail[19].isdigit(),'LAUNCH_START')
    ready={'kind':'hosted-toolchain-writer-ready-1','pid':os.getpid(),'start':tail[19].decode('ascii'),'groupIdentity':{'dev':device,'ino':inode},'attached':True,'privilegeDropPending':True}
    sys.stdout.write(json.dumps(ready,separators=(',',':'))+'\n');sys.stdout.flush()
    os.execve(executable,[executable,*arguments],dict(os.environ))

if __name__=='__main__':
    try:main(sys.argv[1:])
    except BaseException as error:
        code=str(error) if isinstance(error,ValueError) and re.fullmatch('[A-Z][A-Z0-9_]{0,79}',str(error)) else 'LAUNCH_SYSTEM_ERROR'
        sys.stderr.write(code+'\n');sys.exit(1)
