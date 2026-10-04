#!/usr/bin/env python3
"""Standalone hosted capability experiment; never imports or runs a producer.

Only a newly created child cgroup is modified. Source, native allocations,
observers, deadlines and producer profiles are untouched. Every outcome is
unqualified. Missing support or uncertain cleanup cannot report availability.
"""
import errno
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import pwd
import grp
import re
import signal
import stat
import sys
import time
import uuid

UID = GID = 20000
MAX_READ = 131072
MAX_RECORD = 65536
MAX_PROCESSES = 4096
PROBE_SECONDS = 20
CLEANUP_SECONDS = 5

class Refusal(Exception):
    def __init__(self, code, number=None):
        self.code, self.number = code, number
        super().__init__(code)

def require(ok, code):
    if not ok: raise Refusal(code)

def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)+'\n').encode('ascii')

def read_bytes(path, limit=MAX_READ):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        chunks=[];count=0
        while True:
            chunk=os.read(fd,min(16384,limit+1-count))
            if not chunk:break
            chunks.append(chunk);count+=len(chunk);require(count<=limit,'READ_BOUND')
        return b''.join(chunks)
    finally: os.close(fd)

def safe_absolute(value):
    return isinstance(value, str) and value.startswith('/') and not value.startswith('//') and '\\' not in value and '\x00' not in value and str(PurePosixPath(value)) == value and all(x not in ('.','..') for x in value.split('/'))

def locate_cgroup(membership, mountinfo):
    rows = membership.splitlines()
    require(len(rows) == 1 and rows[0].startswith('0::'), 'UNIFIED_CGROUP_REQUIRED')
    current = rows[0][3:]
    require(safe_absolute(current), 'CGROUP_PATH_REFUSED')
    candidates = []
    for line in mountinfo.splitlines():
        parts = line.split(' ')
        if '-' not in parts: continue
        sep = parts.index('-')
        if len(parts) < sep+4 or parts[sep+1] != 'cgroup2': continue
        require(len(parts) >= 6, 'MOUNT_SHAPE')
        root, mount = parts[3:5]
        require(safe_absolute(root) and safe_absolute(mount), 'MOUNT_PATH_REFUSED')
        if current != root and not current.startswith(root.rstrip('/')+'/'): continue
        require('rw' in parts[5].split(',') and 'rw' in parts[sep+3].split(','), 'CGROUP_READ_ONLY')
        relative = current[len(root):].lstrip('/')
        candidates.append(str(Path(mount) / relative))
    require(len(candidates) == 1, 'CGROUP_MOUNT_AMBIGUOUS')
    return candidates[0]

def immutable_directory(path):
    path = Path(path)
    require(path.is_absolute() and path.resolve(strict=True) == path, 'ANCESTRY_CANONICAL')
    for item in [path, *path.parents]:
        value = item.lstat()
        require(stat.S_ISDIR(value.st_mode) and value.st_uid == 0 and not stat.S_IMODE(value.st_mode) & 0o022, 'ANCESTRY_OWNER_MODE')

def process_status(pid):
    try:
        data = read_bytes('/proc/'+str(pid)+'/status')
        fields = {}
        for key in ('Uid','Gid','Groups','CapInh','CapPrm','CapEff','CapBnd','CapAmb','NoNewPrivs'):
            prefix=(key+':').encode('ascii')
            matches=[line[len(prefix):].strip(b' \t') for line in data.splitlines() if line.startswith(prefix)]
            require(len(matches) == 1, 'PROCESS_STATUS_SHAPE')
            fields[key] = matches[0].decode('ascii')
        raw = read_bytes('/proc/'+str(pid)+'/stat')
        require(b') ' in raw,'PROCESS_STAT_SHAPE')
        tail = raw[raw.rfind(b') ')+2:].decode('ascii').split()
        require(len(tail) >= 20 and tail[19].isdecimal(), 'PROCESS_STAT_SHAPE')
        return {'pid':pid,'start':tail[19],'parent':int(tail[1]),'session':int(tail[3]),'state':tail[0],
                'uids':[int(x) for x in fields['Uid'].split()], 'gids':[int(x) for x in fields['Gid'].split()],
                'groups':[int(x) for x in fields['Groups'].split()],
                'capabilities':{k:int(fields[k],16) for k in ('CapInh','CapPrm','CapEff','CapBnd','CapAmb')},
                'noNewPrivs':int(fields['NoNewPrivs'])}
    except OSError as error:
        if error.errno in (errno.ENOENT, errno.ESRCH): return None
        raise

def owned_identity(value):
    require(value is not None and value['uids'] == [UID]*4 and value['gids'] == [GID]*4 and value['groups'] == [] and all(x == 0 for x in value['capabilities'].values()) and value['noNewPrivs'] == 1, 'NONROOT_IDENTITY')
    return value

def uid_processes():
    found=set();numeric=0;entries_seen=0
    with os.scandir('/proc') as entries:
        for entry in entries:
            entries_seen+=1
            require(entries_seen<=MAX_PROCESSES+256,'PROCESS_DIRECTORY_BOUND')
            if not entry.name.isdecimal():continue
            numeric+=1
            require(numeric<=MAX_PROCESSES,'PROCESS_CENSUS_BOUND')
            value=process_status(int(entry.name))
            if value and UID in value['uids']:found.add(int(entry.name))
    return found

def event_values(text):
    result = {}
    for line in text.splitlines():
        parts = line.split()
        require(len(parts) == 2 and re.fullmatch('[a-z_]+',parts[0]) and parts[0] not in result and parts[1] in ('0','1'), 'CGROUP_EVENT_SHAPE')
        result[parts[0]] = int(parts[1])
    require('frozen' in result and 'populated' in result, 'CGROUP_EVENT_FIELDS')
    return result

class PrivateGroup:
    def __init__(self, parent, name):
        require(re.fullmatch(r'ideogram-probe-[0-9]+-[0-9]+-[a-f0-9]{32}', name), 'PRIVATE_GROUP_NAME')
        immutable_directory(parent)
        self.parent, self.name, self.fd, self.created = Path(parent), name, None, False
        self.path = self.parent / name
        # No exists()/reuse branch: a collision is an unconditional refusal.
        os.mkdir(self.path, 0o755); self.created = True
        try:
            self.fd = os.open(self.path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
            self.identity = os.fstat(self.fd)
            require(self.identity.st_uid == 0 and not stat.S_IMODE(self.identity.st_mode)&0o022, 'PRIVATE_GROUP_OWNER')
            for item in ('cgroup.procs','cgroup.freeze','cgroup.kill'):
                value = os.stat(item, dir_fd=self.fd, follow_symlinks=False)
                require(stat.S_ISREG(value.st_mode) and value.st_uid == 0 and not stat.S_IMODE(value.st_mode)&0o022, 'PRIVATE_CONTROL_OWNER')
            require(self.read('cgroup.type').strip() == 'domain' and self.members() == [] and self.events() == {'populated':0,'frozen':0}, 'PRIVATE_GROUP_INITIAL')
        except BaseException as error:
            try:
                os.rmdir(self.path);self.created=False
                if self.fd is not None:os.close(self.fd);self.fd=None
            except OSError as cleanup_error:
                error.probe_group=self
                error.probe_cleanup_errno=cleanup_error.errno
            raise
    def check(self):
        value = self.path.lstat()
        require((value.st_dev,value.st_ino)==(self.identity.st_dev,self.identity.st_ino), 'PRIVATE_GROUP_REPLACED')
    def read(self, name):
        require(name in ('cgroup.procs','cgroup.type','cgroup.events','cgroup.freeze'), 'CONTROL_READ_NAME')
        self.check(); fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=self.fd)
        try:
            value=os.read(fd,16385);require(len(value)<=16384,'CONTROL_READ_BOUND');return value.decode('ascii')
        finally:os.close(fd)
    def write(self, name, value):
        require(name in ('cgroup.procs','cgroup.freeze','cgroup.kill'), 'CONTROL_WRITE_NAME')
        require((name=='cgroup.procs' and type(value) is int and value>0) or (name=='cgroup.freeze' and value in ('0','1')) or (name=='cgroup.kill' and value=='1'),'CONTROL_WRITE_VALUE')
        self.check(); fd=os.open(name,os.O_WRONLY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=self.fd)
        try:
            raw=(str(value)+'\n').encode();require(os.write(fd,raw)==len(raw),'CONTROL_SHORT_WRITE')
        finally:os.close(fd)
    def members(self):
        values=self.read('cgroup.procs').split();require(len(values)<=4 and all(x.isdecimal() for x in values),'PRIVATE_MEMBERS_BOUND');return sorted(int(x) for x in values)
    def events(self):return event_values(self.read('cgroup.events'))
    def remove(self):
        require(self.members()==[] and self.events()['populated']==0,'PRIVATE_GROUP_NOT_EMPTY');self.check();os.close(self.fd);self.fd=None;os.rmdir(self.path);self.created=False

class Progress:
    def __init__(self, descriptor):self.fd=descriptor;self.buffer=b'';self.total=0;self.registrations={};self.ticks={};os.set_blocking(descriptor,False)
    def drain(self):
        while True:
            try:chunk=os.read(self.fd,4096)
            except BlockingIOError:break
            if not chunk:break
            self.total+=len(chunk);require(self.total<=MAX_RECORD,'CHILD_OUTPUT_BOUND');self.buffer+=chunk
            while b'\n' in self.buffer:
                raw,self.buffer=self.buffer.split(b'\n',1);require(len(raw)<=2048,'CHILD_LINE_BOUND');row=json.loads(raw)
                require(type(row) is dict and row.get('role') in ('writer','descendant'),'CHILD_ROW_ROLE')
                role=row['role']
                if row.get('type')=='ready':
                    require(set(row)=={'type','role','pid','escapeErrno'} and role not in self.registrations and type(row['pid']) is int and row['pid']>0 and type(row['escapeErrno']) is int and row['escapeErrno'] in (errno.EACCES,errno.EPERM),'MIGRATION_DENIAL_REQUIRED');self.registrations[role]=row
                else:
                    require(set(row)=={'type','role'} and row['type']=='tick' and role in self.registrations,'CHILD_TICK_ORDER');self.ticks[role]=self.ticks.get(role,0)+1
        return self

def wait_for(predicate, deadline, code):
    while not predicate():
        require(time.monotonic()<deadline,code);time.sleep(0.005)

def child(parent_control):
    owned_identity(process_status(os.getpid()))
    role='writer'
    descendant=os.fork()
    if descendant==0:role='descendant';os.setsid()
    try:
        fd=os.open(parent_control,os.O_WRONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
    except OSError as error:denied=error.errno
    else:os.close(fd);denied=0
    os.write(1,encoded({'type':'ready','role':role,'pid':os.getpid(),'escapeErrno':denied}))
    if denied not in (errno.EACCES,errno.EPERM):return 2
    end=time.monotonic()+10
    while time.monotonic()<end:
        os.write(1,encoded({'type':'tick','role':role}));time.sleep(0.01)
    return 0

def save(path, value):
    raw=encoded(value);require(len(raw)<=MAX_RECORD,'REPORT_BOUND')
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o644)
    with os.fdopen(fd,'wb') as stream:stream.write(raw);stream.flush();os.fsync(stream.fileno())

def experiment(source, output, run, attempt, head):
    report={'kind':'hosted-freezer-capability-probe-1','run':run,'attempt':attempt,'head':head,'qualification':False,'productionCampaignExecuted':False,'producerInputsChanged':False,'nativeAllocationsTouched':False,'sourceSHA256':hashlib.sha256(source).hexdigest(),'status':'UNAVAILABLE','observations':[],'failure':None,'cleanup':{'complete':False,'errors':[]},'limits':['A sacrificial capability experiment only; no producer scan, timing or physical qualification.','Actual future writer containment and unchanged observation budgets still require separately reviewed integration.','No assertion that a root payload is unable to escape: the trusted root launch stub is blocked until attachment, then execs the fixed privilege drop before sacrificial code.']}
    stage='admission';group=None;pid=None;gate=None;reader=None;readfd=None;owned=[];deadline=time.monotonic()+PROBE_SECONDS
    def alarm(signum, frame):raise Refusal('PROBE_INTERRUPTED' if signum!=signal.SIGALRM else 'PROBE_DEADLINE')
    previous={sig:signal.signal(sig,alarm) for sig in (signal.SIGALRM,signal.SIGTERM,signal.SIGINT)}
    signal.setitimer(signal.ITIMER_REAL,PROBE_SECONDS)
    try:
        require(sys.platform=='linux' and os.getuid()==os.geteuid()==0,'ROOT_LINUX_ONLY')
        kernel=os.uname();require(all(re.fullmatch('[A-Za-z0-9_.+-]{1,128}',v) for v in (kernel.sysname,kernel.release,kernel.machine)),'KERNEL_IDENTITY')
        namespaces={}
        for kind in ('cgroup','pid','mnt'):
            value=os.readlink('/proc/self/ns/'+kind);require(re.fullmatch(kind+r':\[[0-9]+\]',value),'NAMESPACE_IDENTITY');namespaces[kind]=value
        report['host']={'kernel':kernel.release,'machine':kernel.machine,'python':list(sys.version_info[:3]),'namespaces':namespaces}
        for lookup,key in ((pwd.getpwuid,UID),(grp.getgrgid,GID)):
            try:lookup(key)
            except KeyError:continue
            raise Refusal('PROBE_ID_ALREADY_REGISTERED')
        require(uid_processes()==set(),'PROBE_UID_IN_USE')
        stage='discovery'
        parent=locate_cgroup(read_bytes('/proc/self/cgroup').decode('ascii'),read_bytes('/proc/self/mountinfo').decode('ascii'))
        immutable_directory(parent)
        control=Path(parent)/'cgroup.procs';v=control.lstat();require(stat.S_ISREG(v.st_mode) and v.st_uid==0 and not stat.S_IMODE(v.st_mode)&0o022,'PARENT_CONTROL_OWNER')
        # Root-owned system tools only. Record identity without claiming native ELF qualification.
        tools=[]
        for name in ('/usr/bin/setpriv',str(Path(sys.executable).resolve(strict=True))):
            tool=Path(name);immutable_directory(tool.parent);v=tool.lstat();require(stat.S_ISREG(v.st_mode) and v.st_uid==0 and not stat.S_IMODE(v.st_mode)&0o022,'SYSTEM_TOOL_OWNER');tools.append({'role':'setpriv' if name.endswith('setpriv') else 'python','bytes':v.st_size,'dev':v.st_dev,'ino':v.st_ino})
        stage='private-group-create'
        group=PrivateGroup(parent,'ideogram-probe-'+str(run)+'-'+str(attempt)+'-'+uuid.uuid4().hex)
        report['observations'].append({'phase':'private-empty','events':group.events(),'members':group.members(),'parentLocatorSHA256':hashlib.sha256(parent.encode()).hexdigest(),'tools':tools})
        stage='child-launch'
        gate_r,gate=os.pipe();readfd,writefd=os.pipe();pid=os.fork()
        if pid==0:
            try:
                os.close(gate);os.close(readfd);os.setsid();null=os.open('/dev/null',os.O_RDONLY);os.dup2(null,0);os.close(null);os.dup2(writefd,1);os.dup2(writefd,2);os.close(writefd)
                token=os.read(gate_r,1);os.close(gate_r)
                if token!=b'1':os._exit(2)
                argv=['/usr/bin/setpriv','--reuid='+str(UID),'--regid='+str(GID),'--clear-groups','--inh-caps=-all','--ambient-caps=-all','--bounding-set=-all','--no-new-privs','--',str(Path(sys.executable).resolve(strict=True)),'-I','-S','-B',str(output/'probe.py'),'--child',str(control)]
                os.execve(argv[0],argv,{'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C','PYTHONDONTWRITEBYTECODE':'1'})
            except BaseException:os._exit(2)
        os.close(gate_r);os.close(writefd);group.write('cgroup.procs',pid);require(group.members()==[pid],'INITIAL_CHILD_BINDING');os.write(gate,b'1');os.close(gate);gate=None
        reader=Progress(readfd);stage='running-admission'
        wait_for(lambda:len(reader.drain().registrations)==2 and all(reader.ticks.get(x,0)>0 for x in ('writer','descendant')),min(deadline,time.monotonic()+3),'CHILD_READY_DEADLINE')
        expected=sorted(v['pid'] for v in reader.registrations.values());require(reader.registrations['writer']['pid']==pid and len(set(expected))==2,'CHILD_PID_BINDING')
        owned=[owned_identity(process_status(p)) for p in expected]
        descendant=next(x for x in owned if x['pid']!=pid);require(descendant['parent']==pid and descendant['session']==descendant['pid'],'DESCENDANT_SESSION_BINDING')
        require(group.members()==expected and uid_processes()==set(expected),'WRITER_MEMBERSHIP')
        report['observations'].append({'phase':'running','identities':owned,'registrations':reader.registrations,'ticks':dict(reader.ticks)})
        stage='freeze'
        group.write('cgroup.freeze','1');wait_for(lambda:group.events()['frozen']==1,min(deadline,time.monotonic()+1),'FREEZE_DEADLINE')
        require(group.events()['populated']==1 and group.members()==expected and uid_processes()==set(expected),'FROZEN_MEMBERSHIP')
        stage='frozen-hold'
        reader.drain();before=dict(reader.ticks);start=time.monotonic();wait_for(lambda:time.monotonic()-start>=0.15,min(deadline,start+0.3),'FROZEN_HOLD_DEADLINE');reader.drain()
        require(reader.ticks==before and group.events()['frozen']==1,'FROZEN_PROGRESS')
        report['observations'].append({'phase':'frozen','events':group.events(),'members':group.members(),'ticks':dict(reader.ticks),'holdSeconds':time.monotonic()-start})
        stage='resume'
        group.write('cgroup.freeze','0');wait_for(lambda:group.events()['frozen']==0,min(deadline,time.monotonic()+1),'THAW_DEADLINE')
        wait_for(lambda:all(reader.drain().ticks.get(role,0)>before[role] for role in ('writer','descendant')),min(deadline,time.monotonic()+1),'RESUME_PROGRESS_DEADLINE')
        require(group.members()==expected and uid_processes()==set(expected),'RESUMED_MEMBERSHIP')
        report['observations'].append({'phase':'resumed','events':group.events(),'members':group.members(),'ticks':dict(reader.ticks)})
        report['status']='CAPABILITY_OBSERVED_PENDING_CLEANUP'
    except BaseException as error:
        if hasattr(error,'probe_group'):
            group=error.probe_group;report['cleanup']['errors'].append({'operation':'initial-group-remove','errno':error.probe_cleanup_errno})
        report['failure']={'stage':stage,'code':error.code if isinstance(error,Refusal) else 'SYSTEM_ERROR','errno':error.errno if isinstance(error,OSError) else None}
    finally:
        signal.setitimer(signal.ITIMER_REAL,0)
        end=time.monotonic()+CLEANUP_SECONDS
        if gate is not None:
            try:os.close(gate)
            except OSError as error:report['cleanup']['errors'].append({'operation':'launch-gate-close','errno':error.errno})
        if group is not None:
            for control,value in [('cgroup.freeze','0'),('cgroup.kill','1')]:
                try:group.write(control,value)
                except BaseException as error:report['cleanup']['errors'].append({'operation':control,'errno':error.errno if isinstance(error,OSError) else None})
        # Only the directly forked root is signaled if attachment failed. A real
        # detached descendant is covered by the private kernel kill operation.
        if pid is not None:
            try:os.kill(pid,signal.SIGKILL)
            except ProcessLookupError:pass
            except OSError as error:report['cleanup']['errors'].append({'operation':'root-kill','errno':error.errno})
            try:
                def reaped():
                    result=os.waitpid(pid,os.WNOHANG);return result[0]==pid
                wait_for(reaped,end,'ROOT_DRAIN_DEADLINE')
            except BaseException as error:report['cleanup']['errors'].append({'operation':'root-drain','code':error.code if isinstance(error,Refusal) else 'SYSTEM_ERROR'})
        if group is not None:
            try:
                wait_for(lambda:group.members()==[] and group.events()['populated']==0,end,'GROUP_DRAIN_DEADLINE');group.remove()
            except BaseException as error:report['cleanup']['errors'].append({'operation':'group-remove','code':error.code if isinstance(error,Refusal) else 'SYSTEM_ERROR','errno':error.errno if isinstance(error,OSError) else None})
        if readfd is not None:
            try:os.close(readfd)
            except OSError as error:report['cleanup']['errors'].append({'operation':'progress-pipe-close','errno':error.errno})
        try:
            remaining=[process_status(p) for p in uid_processes()] if pid is not None else []
            live=[v for v in remaining if v and v['state']!='Z']
            if live:report['cleanup']['errors'].append({'operation':'dedicated-uid-live','count':len(live)})
        except BaseException:report['cleanup']['errors'].append({'operation':'dedicated-uid-census-unavailable'})
        for sig,handler in previous.items():signal.signal(sig,handler)
        report['cleanup']['complete']=not report['cleanup']['errors']
        if report['status']=='CAPABILITY_OBSERVED_PENDING_CLEANUP' and report['cleanup']['complete']:report['status']='CAPABILITY_OBSERVED'
        elif not report['cleanup']['complete']:report['status']='CLEANUP_UNCERTAIN'
    return report

def main(args):
    require(len(args)==8 and args[::2]==['--run','--attempt','--head','--source-sha256'],'ARGUMENTS')
    run,attempt,head,expected=args[1::2]
    require(re.fullmatch('[1-9][0-9]{0,19}',run) and re.fullmatch('[1-9][0-9]{0,5}',attempt) and re.fullmatch('[a-f0-9]{40}',head) and re.fullmatch('[a-f0-9]{64}',expected),'IDENTITY')
    require(sys.platform=='linux' and os.getuid()==os.geteuid()==0,'ROOT_LINUX_ONLY')
    raw=read_bytes(__file__);require(hashlib.sha256(raw).hexdigest()==expected,'SOURCE_IDENTITY')
    os.umask(0o022)
    parent=Path('/var/lib');immutable_directory(parent);output=parent/('ideogram-freezer-probe-'+run+'-'+attempt);output.mkdir(mode=0o755)
    fd=os.open(output/'probe.py',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o644)
    with os.fdopen(fd,'wb') as stream:stream.write(raw);stream.flush();os.fsync(stream.fileno())
    report=experiment(raw,output,int(run),int(attempt),head);save(output/'report.json',report)
    require(sorted(p.name for p in output.iterdir())==['probe.py','report.json'],'EXPORT_MEMBERSHIP')
    for p in output.iterdir():
        value=p.lstat();require(stat.S_ISREG(value.st_mode) and value.st_uid==0 and value.st_nlink==1 and not stat.S_IMODE(value.st_mode)&0o022,'EXPORT_OWNER')
    require(sum(p.stat().st_size for p in output.iterdir())<=MAX_READ+MAX_RECORD,'EXPORT_BOUND')
    print('safe_output='+str(output),flush=True)
    return 0 if report['status']=='CAPABILITY_OBSERVED' else 2

if __name__=='__main__':
    try:
        if len(sys.argv)==3 and sys.argv[1]=='--child':sys.exit(child(sys.argv[2]))
        sys.exit(main(sys.argv[1:]))
    except Refusal as error:
        print(json.dumps({'kind':'freezer-probe-refusal','code':error.code,'errno':error.number}),file=sys.stderr);sys.exit(2)
    except Exception as error:
        print(json.dumps({'kind':'freezer-probe-refusal','code':'SYSTEM_ERROR','errno':error.errno if isinstance(error,OSError) else None}),file=sys.stderr);sys.exit(2)
