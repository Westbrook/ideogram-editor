"""Explicit source preparation for a NEW schema16 Linux maintenance build.

Reads authenticated Git objects, never the dirty checkout or a historical
executable. No action occurs on import. A source input is not an executable pin.
"""
from pathlib import Path, PurePosixPath
import gzip
import hashlib
import io
import json
import os
import re
import selectors
import subprocess
import tarfile
import time

HISTORICAL_BASE = '5650326b623d4aa2080772307708aa9f1854aa52'
CONTRACT = 'schema16-linux-raster-maintenance-1'
PATCH = 'sha256:77f7fddc26a02bc9c4e613de72f47d213fa58bee9846ff84717cdece58214958'
TARGETS = {
 'server/raster/engine.ts': ('3453dc5831defa1f46dd28deac8be49170f82957bf73aef6f296e53edda00d55','1778f080717fb42a48989ce1126dafba199cc8cdbf4732d960d89e9d38e69bc7'),
 'server/raster/codec-platform.ts': (None,'d111879687cb3042a75a0d09d6a26a75ca2a5ba6260a9870e15538c0e7a7cc42'),
 'server/raster/identities/linux-arm64-v1.ts': (None,'332f5b9bbf0303e8bf51e8fb80d94d92d07b3a380a74708bda47d89d0adbd83a'),
 'server/raster/identities/linux-x64-v1.ts': (None,'1fbfa42737140036261b0e4f55d0321a2cc2306a073a2ea59e202b836eeb3ec2'),
}
MAX_FILE = 128 * 1024**2
MAX_TOTAL = 8 * 1024**3

def git_bytes(git, repo, args, maximum, require):
    """Finite raw object reads; no filters, hooks, replacements, or shell."""
    argv=[str(git),'--no-pager','--no-replace-objects','--no-optional-locks','-C',str(repo),*args]
    env={'PATH':'/usr/bin:/bin','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_TERMINAL_PROMPT':'0','LC_ALL':'C'}
    child=subprocess.Popen(argv,env=env,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
    result=bytearray(); deadline=time.monotonic()+60
    try:
        with selectors.DefaultSelector() as ready:
            ready.register(child.stdout,selectors.EVENT_READ)
            while ready.get_map():
                require(time.monotonic()<deadline,'Git source read timeout')
                for key,_ in ready.select(min(1,max(0,deadline-time.monotonic()))):
                    block=os.read(key.fd,min(1024**2,maximum+1-len(result)))
                    if not block: ready.unregister(key.fileobj); continue
                    result.extend(block);require(len(result)<=maximum,'Git source read bound')
        require(child.wait(timeout=max(.01,deadline-time.monotonic()))==0,'Git source read failed')
        return bytes(result)
    finally:
        if child.poll() is None: child.kill()
        child.wait(timeout=5);child.stdout.close()

def selected(name):
    return bool(re.match(r'^(src|server|tests|tooling|vendor|docs|\.github)/',name) or
       re.fullmatch(r'(package(?:-lock)?\.json|tsconfig(?:\.[\w-]+)?\.json|vite(?:\.[\w-]+)?\.config\.ts|index\.html|\.npmrc|\.progress-report/project\.json|AGENTS\.md|README(?:\.md)?|LICENSE(?:\.txt)?)',name))

def source_selection_observation(ref):
    """Original capture tools are inert provenance, not Linux executable inputs.

    Exact tool bytes were authenticated before/after Git object extraction. The
    reviewed source input retains their identity without reopening foreign paths.
    The patch itself is also retained as an exact sealed producer/runtime member.
    """
    return {'originalPath':ref['path'],'hash':ref['hash'],'byteLength':ref['byteLength'],
            'authority':'source-selection-observation-only'}

def prepare(args, api, version=16):
    a=api['archive'];require=a.require;ref=api['file_ref'];save=api['save'];cid=api['content_id']
    require(type(version) is int and version==16,'Maintenance schema16 only')
    repo=a.canonical(args.repo);git=a.canonical(args.git);git_ref=ref(git)
    output=api['fresh'](Path(args.output));here=api['HERE'];rows={};git_rows={};total=0
    require(ref(here/'maintenance.patch')['hash']==PATCH,'Maintenance patch differs')
    commit=git_bytes(git,repo,['cat-file','commit',HISTORICAL_BASE],1024**2,require)
    require(hashlib.sha1(b'commit '+str(len(commit)).encode()+b'\0'+commit).hexdigest()==HISTORICAL_BASE,'Historical Git commit differs')
    listing=git_bytes(git,repo,['ls-tree','-rz','--full-tree',HISTORICAL_BASE],32*1024**2,require)
    for line in listing.split(b'\0'):
        if not line:continue
        meta,name=line.split(b'\t',1);mode,kind,blob=meta.decode('ascii').split();name=name.decode('utf-8')
        if not selected(name):continue
        a.relative(name);require(name not in git_rows and len(git_rows)<200000,'Duplicate/large Git source selection')
        require(kind=='blob' and mode in ('100644','100755') and re.fullmatch('[0-9a-f]{40}',blob),'Nonregular historical source refused')
        git_rows[name]={'mode':int(mode,8)&0o777,'gitBlob':blob}
    require('server/storage/database.ts' in git_rows and 'package-lock.json' in git_rows,'Historical source incomplete')
    for name,(before,_) in TARGETS.items():require((name in git_rows)==(before is not None),'Maintenance target presence differs')
    destination=output/'source.tar.gz'
    with destination.open('xb') as raw, gzip.GzipFile(fileobj=raw,mode='wb',mtime=0,filename='') as compressed, tarfile.open(fileobj=compressed,mode='w|',format=tarfile.USTAR_FORMAT) as bundle:
        directories=set()
        for name in set(git_rows)|set(TARGETS):
            directories.update(str(parent) for parent in PurePosixPath(name).parents if str(parent)!='.')
        for name in sorted(directories):
            row={'type':'directory','mode':0o755};rows[name]=row
            entry=tarfile.TarInfo(name);entry.type=tarfile.DIRTYPE;entry.mode=row['mode'];bundle.addfile(entry)
        for name in sorted(set(git_rows)|set(TARGETS)):
            old=git_rows.get(name);data=None
            if old:
                data=git_bytes(git,repo,['cat-file','blob',old['gitBlob']],MAX_FILE,require)
                require(hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()==old['gitBlob'],'Historical Git blob differs')
                old['sha256']=hashlib.sha256(data).hexdigest();old['bytes']=len(data)
            if name in TARGETS:
                before,after=TARGETS[name]
                require(before is None or old['sha256']==before,'Maintenance source base differs')
                candidate=here/'maintenance-files'/name
                require(ref(candidate)['hash']=='sha256:'+after,'Maintenance payload differs')
                data=candidate.read_bytes();require(len(data)<=MAX_FILE,'Maintenance payload bound')
            total+=len(data);require(total<=MAX_TOTAL,'Maintenance source total bound')
            row={'type':'file','mode':old['mode'] if old else 0o644,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'nlink':1};rows[name]=row
            entry=tarfile.TarInfo(name);entry.mode=row['mode'];entry.size=len(data);bundle.addfile(entry,io.BytesIO(data))
    os.chmod(destination,0o600)
    with destination.open('rb') as stream:os.fsync(stream.fileno())
    archive_ref=ref(destination)
    source_identity=cid({name:{key:value for key,value in row.items() if key!='nlink'} for name,row in rows.items()})
    save(output/'manifest.json',{'kind':'schema16-maintenance-source-transport-1','metadataPolicy':'git-bytes-modes-maintenance-1','storageVersion':16,
      'historicalBase':HISTORICAL_BASE,'compatibilityContract':CONTRACT,'maintenancePatchHash':PATCH,'archive':archive_ref,'entries':rows,
      'originalsUnchanged':True,'status':'copied-restore-pending','metadataEquivalent':False})
    save(output/'lineage.json',{'kind':'schema16-maintenance-source-lineage-2','historicalBase':HISTORICAL_BASE,'historicalCommitSha256':cid(commit.hex()),
      'compatibilityContract':CONTRACT,'maintenancePatch':source_selection_observation(ref(here/'maintenance.patch')),'gitExecutable':source_selection_observation(git_ref),'gitObjects':git_rows,
      'sourceIdentity':source_identity,'historicalExecutableClaim':False,'linuxExecutableQualified':False})
    require(ref(git)==git_ref,'Git executable changed during source capture')
    spec={'kind':'linux-rollback-source-input-1','storageVersion':16,'originArchive':archive_ref,'originManifest':ref(output/'manifest.json'),
      'sourceBytesModesIdentity':source_identity,'lineage':ref(output/'lineage.json'),'historicalBase':HISTORICAL_BASE,'compatibilityContract':CONTRACT,'maintenancePatchHash':PATCH}
    save(output/'source-input.json',spec)
    print(json.dumps({'sourceInput':ref(output/'source-input.json'),'reviewRequired':True,'linuxExecutableQualified':False}))

def foreign_source_manifest(spec, read, require, version):
    require(version==16 and spec.get('storageVersion')==16 and spec.get('historicalBase')==HISTORICAL_BASE and
       spec.get('compatibilityContract')==CONTRACT and spec.get('maintenancePatchHash')==PATCH,'Maintenance source family differs')
    manifest=read(spec['originManifest'])
    require(manifest.get('kind')=='schema16-maintenance-source-transport-1' and manifest.get('metadataPolicy')=='git-bytes-modes-maintenance-1','Maintenance source manifest differs')
    require(manifest['historicalBase']==HISTORICAL_BASE and manifest['compatibilityContract']==CONTRACT and manifest['maintenancePatchHash']==PATCH,'Maintenance origin differs')
    require(all(manifest['archive'][key]==spec['originArchive'][key] for key in ('hash','byteLength')),'Maintenance archive binding differs')
    lineage=read(spec['lineage'])
    require(lineage.get('kind')=='schema16-maintenance-source-lineage-2' and lineage.get('historicalBase')==HISTORICAL_BASE and
       lineage.get('compatibilityContract')==CONTRACT and lineage.get('sourceIdentity')==spec['sourceBytesModesIdentity'] and
       lineage.get('historicalExecutableClaim') is False and lineage.get('linuxExecutableQualified') is False,'Maintenance source lineage differs')
    for name in ('maintenancePatch','gitExecutable'):
        observation=lineage.get(name)
        require(isinstance(observation,dict) and set(observation)=={'originalPath','hash','byteLength','authority'} and
           observation['authority']=='source-selection-observation-only' and isinstance(observation['originalPath'],str) and
           os.path.isabs(observation['originalPath']) and os.path.normpath(observation['originalPath'])==observation['originalPath'] and
           isinstance(observation['hash'],str) and re.fullmatch('sha256:[0-9a-f]{64}',observation['hash']) and
           isinstance(observation['byteLength'],str) and re.fullmatch('0|[1-9][0-9]*',observation['byteLength']) and
           int(observation['byteLength'])<=2**53-1,'Foreign tool observation must not be an executable file reference')
    require(lineage['maintenancePatch']['hash']==PATCH,'Maintenance lineage patch differs')
    return None  # Remaining file refs are local; original tools are inert observations.
