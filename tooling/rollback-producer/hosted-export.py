#!/usr/bin/env python3
"""Post-drain diagnostic/packet copies. Never changes originals or grants credit."""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import stat
import sys

# The fixed caller authenticates this module and hosted-worker.py in the same
# root-owned immutable source closure. Import performs no payload work.
import importlib.util
_spec = importlib.util.spec_from_file_location('hosted_worker_export', Path(__file__).with_name('hosted-worker.py'))
worker = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(worker)
require = worker.require
PHASES = ('inputs','toolchain','build16','build17','build18','verify16','verify17','verify18')
MAX_BYTES = 4 * 1024**3
MAX_FILES = 100000


def document_refs(value):
    """Exact inert file references only; no path-only host/workspace traversal."""
    found=[]; pending=[(value,())]; count=0
    while pending:
        item,pointer=pending.pop();count+=1;require(count<=1000000,'Reference document bound')
        if isinstance(item,dict):
            if set(item)==set(('path','hash','byteLength')):
                require(isinstance(item['path'],str) and isinstance(item['hash'],str) and re.fullmatch(r'sha256:[0-9a-f]{64}',item['hash']) and isinstance(item['byteLength'],str) and re.fullmatch(r'0|[1-9][0-9]*',item['byteLength']) and int(item['byteLength'])<=2**53-1,'Malformed referenced file')
                if os.path.isabs(item['path']):
                    require(os.path.normpath(item['path'])==item['path'],'Noncanonical reference')
                    found.append({'path':item['path'],'bytes':int(item['byteLength']),'sha256':item['hash'][7:]})
                else:
                    # Sealed packet.reference_kind's sole relative content
                    # schema is inside the seed archive, not a host file path.
                    require(len(pointer)==3 and pointer[:2]==('retained','objects') and type(pointer[2]) is int and item['path']=='sha256/'+item['hash'][7:9]+'/'+item['hash'][7:],'Unknown relative content reference')
            else:pending.extend((child,(*pointer,key)) for key,child in item.items())
        elif isinstance(item,list):pending.extend((child,(*pointer,index)) for index,child in enumerate(item))
    return found


def carried_draft_refs(receipt):
    values=receipt.get('carried',{}).get('drafts',{})
    require(set(values)<=set(('16','17','18')),'Unexpected draft family')
    return list(values.values())

def diagnostic_members(base,phase):
    """Fixed output metadata/log locations, including unsuccessful commands."""
    if not base.exists():return []
    require(base.resolve(strict=True)==base,'Diagnostic output alias')
    result=[]
    metadata={'draft.json','linux-build.json','native-host.json','native-host-after.json','toolchain-authentication.json','toolchain-after.json','runtime-selection.json','packet.json','fresh-restore.json','verifier.json'}
    def failure(name):return re.fullmatch(r'failure-[0-9a-f]{32}\.json',name) is not None
    for path in base.iterdir():
        if path.name in metadata or failure(path.name):result.append(path)
    logs=base/'logs'
    if logs.exists():
        require(logs.resolve(strict=True)==logs and logs.is_dir(),'Diagnostic logs alias')
        for path in logs.iterdir():
            require(re.fullmatch(r'[a-z][a-z0-9-]*\.log(?:\.(?:control|receipt)\.json)?',path.name),'Unexpected producer log member')
            result.append(path)
    for name in (('source','application','seed') if phase.startswith('build') else ('evidence',)):
        directory=base/name
        if directory.exists():
            require(directory.resolve(strict=True)==directory and directory.is_dir(),'Diagnostic archive directory alias')
            result.extend(path for path in directory.iterdir() if path.name in ('payload.tar.gz','manifest.json') or failure(path.name))
    require(len(result)<=10000 and all(path.is_file() and not path.is_symlink() for path in result),'Diagnostic file membership/type bound')
    return sorted(result)

SETUP_METADATA = ('first-step.json','github-jobs.json','source-selection.json','host-selection.json','host-observation.json','setup.json','evidence-allocation.json','data-allocation.json','config.json')
SETUP_LABELS = ('apt-update','apt-install','control-toolchain','control-node-version','control-npm-version','control-python-version','producer-group','producer-account','native-host-selection')

def setup_export_entries(inventory,setup,config):
    """Bind the separate, explicitly unmeasured setup export to this exact job."""
    require(inventory.get('kind')=='hosted-native-unmeasured-setup-export-1' and inventory.get('run')==setup['run'] and inventory.get('attempt')==setup['attempt'] and inventory.get('head')==setup['controlHead'],'Setup export job identity differs')
    require(inventory.get('setupSuccessful') is True and inventory.get('setupOwnedProcessGroupsAbsent') is True and all(inventory.get(key) is False for key in ('setupMeasured','qualification','payloadFilesCopied','originalsChanged')) and inventory.get('maximumBytes')==64*1024**2,'Setup export claims differ')
    parent=worker.absolute(config['exportRoot']).parent
    require(parent==Path(f"/opt/ideogram-native-export-{setup['run']}-{setup['attempt']}"),'Fixed setup export parent differs')
    meta=Path(config['controlRoot'])/'meta'
    allowed={'first-step-original.json':Path(f"/opt/ideogram-native-job-{setup['run']}-{setup['attempt']}.json"),**{name:meta/name for name in SETUP_METADATA},**{'commands/'+label+suffix:meta/'setup-commands'/(label+suffix) for label in SETUP_LABELS for suffix in ('.json','.stdout','.stderr')}}
    rows=inventory.get('files');omitted=inventory.get('omitted')
    require(isinstance(rows,list) and isinstance(omitted,list) and len(rows)+len(omitted)==len(allowed),'Exact finite setup membership required')
    seen=set();total=0
    for row in rows:
        require(isinstance(row,dict) and set(row)=={'source','copy'},'Setup copy row differs')
        source,copy=row['source'],row['copy']
        for ref in (source,copy):require(isinstance(ref,dict) and set(ref)=={'path','bytes','sha256'} and type(ref['bytes']) is int and 0<=ref['bytes']<=64*1024**2 and re.fullmatch('[0-9a-f]{64}',ref['sha256']) and isinstance(ref['path'],str),'Malformed setup copy pin')
        path=worker.absolute(copy['path']);rel=path.relative_to(parent/'setup').as_posix()
        require(rel in allowed and rel not in seen and source['path']==str(allowed[rel]) and (source['bytes'],source['sha256'])==(copy['bytes'],copy['sha256']),'Setup copy authority differs');seen.add(rel);total+=copy['bytes']
    for row in omitted:
        require(isinstance(row,dict) and set(row)=={'name','reason'} and row['reason']=='Fixed setup diagnostic byte bound' and row['name'] in allowed and row['name'] not in seen,'Unbound setup omission');seen.add(row['name'])
    require(seen==set(allowed) and total==inventory.get('regularBytes') and total<=64*1024**2,'Setup byte/membership total differs')
    return rows

def setup_export_snapshot(config,allow_run=False):
    parent=worker.absolute(config['exportRoot']).parent;target=parent/'setup';state=[];members=set();total=0
    require(parent.resolve(strict=True)==parent and {p.name for p in parent.iterdir()}==({'setup',config['runId']} if allow_run else {'setup'}),'Unexpected aggregate export member')
    def scan(directory):
        info=directory.lstat();require(directory.resolve(strict=True)==directory and stat.S_ISDIR(info.st_mode) and info.st_uid==0 and stat.S_IMODE(info.st_mode)==0o755,'Setup export directory identity differs');state.append((str(directory),worker.stamp(info)))
        for member in sorted(directory.iterdir()):
            info=member.lstat()
            if stat.S_ISDIR(info.st_mode):require(member==target/'commands','Unexpected setup directory');scan(member)
            else:require(stat.S_ISREG(info.st_mode) and info.st_nlink==1 and info.st_uid==0 and stat.S_IMODE(info.st_mode)==0o644,'Setup export file identity differs');members.add(member)
    scan(target)
    raw=worker.read(target/'inventory.json',worker.MAX_JSON,True);inventory=worker.decode(raw);setup=worker.decode(worker.verify_ref(config['setup'],True));rows=setup_export_entries(inventory,setup,config)
    require(members=={target/'inventory.json',*[Path(row['copy']['path']) for row in rows]},'Extra or missing setup export member')
    for ref in [worker.reference(target/'inventory.json'),*[row['copy'] for row in rows]]:
        value=worker.verify_ref(ref,True);total+=len(value);state.append((ref['path'],worker.stamp(Path(ref['path']).lstat()),ref['sha256']))
    for row in rows:worker.verify_ref(row['source'],True)
    require(total<=64*1024**2+worker.MAX_JSON,'Setup snapshot including inventory bound')
    return {'bytes':total,'inventory':worker.reference(target/'inventory.json'),'state':state}

def export(config, through):
    require(sys.platform == 'linux' and os.getuid() == os.geteuid() == 0, 'Root-owned post-drain export required')
    evidence = worker.decode(worker.verify_ref(config['evidenceAllocation'], True))
    os.umask(0o022)
    data = worker.data_root(config); run = Path(evidence['root']) / config['runId']
    setup_snapshot=setup_export_snapshot(config)
    end = PHASES.index(through); files = {}; finals = []; followed=set()
    def add(path, destination, expected=None):
        path = worker.absolute(str(path)); require(path.resolve(strict=True) == path, 'Export source alias')
        require(destination not in files or files[destination][0] == path, 'Export destination collision')
        old=files.get(destination);require(old is None or old[1] is None or expected is None or old[1]==expected,'Conflicting export reference');files[destination] = (path, expected if expected is not None else old[1] if old else None); require(len(files) <= MAX_FILES, 'Export membership bound')
    def tree(directory, prefix, depth=0):
        require(depth <= 128, 'Export depth bound'); before = directory.lstat()
        require(stat.S_ISDIR(before.st_mode) and before.st_uid == 0, 'Only root-owned controller evidence tree can be copied')
        for member in sorted(directory.iterdir()):
            s = member.lstat(); name = prefix + '/' + member.name
            if stat.S_ISDIR(s.st_mode): tree(member, name, depth + 1)
            else:
                require(stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and s.st_uid == 0, 'Linked/special control evidence refused')
                add(member, name)
        require(worker.stamp(before) == worker.stamp(directory.lstat()), 'Closed evidence membership changed')
    def referenced_closure(ref):
        path=worker.absolute(ref['path']);require(path.resolve(strict=True)==path,'Referenced closure alias')
        if data in path.parents:
            rel=path.relative_to(data);require(rel.parts[0] in ('inputs','prepared','outputs','workspaces'),'Referenced data path outside fixed producer scopes')
            destination='data/'+str(rel)
        else:
            allowed=[config['_config'],config['setup'],config['hostSelection'],config['hostObservation'],*config['sources']]
            require(ref in allowed,'External reference is not admitted controller source/metadata')
            destination='control-references/'+ref['sha256']+'-'+path.name
        add(path,destination,ref)
        key=(str(path),ref['sha256'],ref['bytes'])
        # Raw admitted foreign inputs preserve historical path strings. They
        # are sealed leaves, not authority to open their old host locations.
        descend=data in path.parents and path.relative_to(data).parts[0] in ('prepared','outputs','workspaces')
        if descend and key not in followed and path.suffix=='.json':
            followed.add(key);require(len(followed)<=10000 and ref['bytes']<=worker.MAX_JSON,'Referenced JSON closure bound')
            document=worker.decode(worker.verify_ref(ref))
            for child in document_refs(document):referenced_closure(child)
    for phase in PHASES[:end + 1]:
        final = worker.decode(worker.read(run / phase / 'finalization.json'))
        require(final['kind'] == 'hosted-native-phase-finalization-1' and final['phase'] == phase and final['timingLockReleased'] is True, 'Phase lacks actual closed lease boundary')
        require(final['config']['sha256'] == config['_grant'], 'Phase configuration differs')
        if phase != through: require(final['effectiveOutcome'] == 'PASS', 'Failed predecessor prevents later phase export')
        finals.append({'phase': phase, 'effectiveOutcome': final['effectiveOutcome']}); tree(run / phase, 'evidence/' + phase)
        if final.get('receipt'):
            receipt = worker.decode(worker.verify_ref(final['receipt']))
            for draft_ref in carried_draft_refs(receipt):referenced_closure(draft_ref)
            # Only explicit output archive/manifest/restore references are copied.
            # Mutable workspaces and restored source/runtime trees are excluded.
            for version, item in receipt.get('carried', {}).get('packets', {}).items():
                require(version in ('16','17','18'), 'Unexpected packet family')
                ident = item['identity']; path = Path(ident['path']); expected = {'path': str(path), 'bytes': int(ident['byteLength']), 'sha256': ident['hash'][7:]}
                packet = worker.decode(worker.verify_ref(expected)); add(path, 'data/' + str(path.relative_to(data)), expected)
                require({value['name'] for value in packet['compiledClosures']} == {'application-runtime','qualification-evidence'}, 'Actual packet lacks complete executable qualification closure')
                refs = [packet['sourceArchive'], packet['sourceManifest'], packet['verifiedFreshRestore']['receipt']]
                refs += [value[key] for value in packet['compiledClosures'] for key in ('archive','manifest')]
                for ref in refs:
                    p = worker.absolute(ref['path']); rel = p.relative_to(data)
                    require(rel.parts[0] in ('inputs','outputs') and ref['hash'].startswith('sha256:'), 'Packet reference escapes admitted data closure')
                    add(p, 'data/' + str(rel), {'path':str(p),'bytes':int(ref['byteLength']),'sha256':ref['hash'][7:]})
                verifier = data / ('outputs/verified' + version + '/verifier.json')
                add(verifier, 'data/' + str(verifier.relative_to(data)))
    # A failed build can stop before publishing a draft. Retain its fixed
    # producer diagnostics and partial archives as diagnostics, never qualification.
    for phase in PHASES[:end+1]:
        if phase.startswith(('build','verify')):
            base=data/('outputs/'+('build' if phase.startswith('build') else 'verified')+phase[-2:])
            for path in diagnostic_members(base,phase):add(path,'data/'+str(path.relative_to(data)))
    for ref in [config['_config'],config['evidenceAllocation'],config['dataAllocation'],config['setup'],config['hostSelection'],config['hostObservation'],*config['sources']]:
        # Stable ordinal avoids rewriting absolute paths or reference identities.
        add(Path(ref['path']), 'control/' + str(len(files)).zfill(6) + '-' + Path(ref['path']).name, ref)
    for name in ('inputs/INPUTS.json','prepared/prepared.json','prepared/schema16/source-input.json','prepared/schema17/source-input.json','prepared/schema18/source-input.json'):
        path = data / name
        if path.exists(): add(path, 'data/' + name)
    # No file is opened for payload execution. Actual size is checked before
    # creating the fresh destination, then every copy is streamed and rehashed.
    total = sum(path.lstat().st_size for path, _ in files.values())
    require(total+setup_snapshot['bytes'] <= MAX_BYTES, 'Aggregate export exceeds 4GiB; originals retained')
    target = worker.absolute(config['exportRoot']); require(target.parent.resolve(strict=True) == target.parent, 'Export parent alias')
    require(target != data and target != run and data not in target.parents and Path(evidence['root']) not in target.parents, 'Export must be outside both allocations')
    for parent in [target.parent, *target.parent.parents]:
        info = parent.lstat(); require(info.st_uid == 0 and not stat.S_IMODE(info.st_mode) & 0o022 and stat.S_IMODE(info.st_mode) & 0o001, 'Export parent must be root-owned immutable and traversable for upload')
    target.mkdir(mode=0o755); rows = []; copied = 0
    for name, (path, expected) in sorted(files.items()):
        before = path.lstat(); require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1, 'Export ordinary source required')
        destination = target / name; destination.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
        source = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        output = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
        count = 0; digest = hashlib.sha256()
        try:
            require(worker.stamp(before) == worker.stamp(os.fstat(source)), 'Export source changed before copy')
            while block := os.read(source, 1048576):
                count += len(block); copied += len(block); require(count <= before.st_size and copied+setup_snapshot['bytes'] <= MAX_BYTES, 'Export source grew beyond aggregate bound'); digest.update(block)
                view = memoryview(block)
                while view:
                    written = os.write(output, view); require(written > 0, 'Export short write'); view = view[written:]
            os.fsync(output)
            require(count == before.st_size and worker.stamp(before) == worker.stamp(os.fstat(source)) == worker.stamp(path.lstat()), 'Export source changed')
        finally: os.close(source); os.close(output)
        observed = {'path':str(path),'bytes':count,'sha256':digest.hexdigest()}
        require(expected is None or expected == observed, 'Export source pin differs')
        verify = hashlib.sha256()
        with destination.open('rb') as handle:
            while block := handle.read(1048576): verify.update(block)
        require(verify.hexdigest() == observed['sha256'] and destination.stat().st_size == count, 'Export copy readback differs')
        rows.append({'source':observed,'destination':name})
    inventory = {'kind':'hosted-native-export-1','runId':config['runId'],'through':through,'phases':finals,'regularBytes':copied,'maximumBytes':MAX_BYTES,'setupExport':{'inventory':setup_snapshot['inventory'],'actualRegularBytesIncludingInventory':setup_snapshot['bytes']},'files':rows,'originalsChanged':False,'qualification':False,'setupMeasured':False,'copyPathsAreNotExecutableAdmission':True,'consumerRequiresReviewedInstallRebinding':True}
    require(setup_export_snapshot(config,True)==setup_snapshot,'Setup export changed during copies')
    inventory_bytes=(json.dumps(inventory,sort_keys=True,indent=2,allow_nan=False)+'\n').encode()
    require(len(inventory_bytes)<=worker.MAX_JSON and copied+setup_snapshot['bytes']+len(inventory_bytes)<=MAX_BYTES,'Final aggregate export inventory exceeds cap; partial export retained')
    ref = worker.save(target / 'inventory.json', inventory); os.chmod(target / 'inventory.json',0o644)
    return {'inventory':ref,'qualification':False,'originalsChanged':False}

def main():
    require(sys.flags.isolated and sys.flags.no_site and sys.dont_write_bytecode and not sys.flags.optimize, 'Use Python -I -S -B')
    parser=argparse.ArgumentParser(); parser.add_argument('--config',required=True); parser.add_argument('--grant',required=True); parser.add_argument('--through',required=True,choices=PHASES)
    args=parser.parse_args(); config=worker.config_at(args.config,args.grant,'export'); config['_grant']=args.grant; config['_config']=worker.reference(Path(args.config))
    print(json.dumps(export(config,args.through),separators=(',',':')))
if __name__ == '__main__':
    try: main()
    except Exception as error: sys.stderr.write(type(error).__name__+': '+str(error)[:2048]+'\n');sys.exit(1)
