#!/usr/bin/env python3
"""Explicitly unmeasured controller-host selection; never payload preparation.

Only root-owned existing system tools/libraries are selected. The sealed host
parser performs the final complete validation/observation. No ldd or shell is used.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import types

def require(value, message):
    if not value: raise ValueError(message)

def read(path, maximum):
    path = Path(path); require(path.is_absolute() and path.resolve(strict=True) == path, 'Canonical immutable helper path required')
    for p in [path, *path.parents]:
        s = p.lstat(); require(s.st_uid == 0 and not stat.S_IMODE(s.st_mode) & 0o022, 'Root-owned immutable source required')
    before = path.lstat(); require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= maximum, 'Bounded single-link helper required')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        raw = bytearray()
        while block := os.read(fd, 65536): raw.extend(block); require(len(raw) <= maximum, 'Helper bound')
        stamp = lambda s: (s.st_dev, s.st_ino, s.st_mode, s.st_nlink, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        require(len(raw) == before.st_size and stamp(before) == stamp(os.fstat(fd)) == stamp(path.lstat()), 'Helper changed')
        return bytes(raw)
    finally: os.close(fd)

def select(host, environment):
    def pair(path): return {'requestedPath': str(path), 'path': str(Path(path).resolve(strict=True))}
    def command(argv): return host.command(argv, environment)['stdout'].strip()
    tools = {name: pair('/usr/bin/' + executable) for name, executable in {'gcc':'gcc','gxx':'g++','make':'make','python':'python3','getconf':'getconf'}.items()}
    # Authenticate discovery programs by the same root-owned finite-file policy.
    for value in tools.values(): host.system_file(value)
    loader = pair('/usr/sbin/ldconfig'); host.system_file(loader)
    programs = {}
    for name in ('cc1','cc1plus','collect2','as','ld'):
        value = command([tools['gxx' if name == 'cc1plus' else 'gcc']['path'], '-print-prog-name=' + name])
        if not value.startswith('/'):
            require(name in ('as','ld') and value == name, 'Unexpected compiler search'); value = '/usr/bin/' + name
        programs[name] = pair(value)
    for value in programs.values(): host.system_file(value)
    cache = {}
    for line in command([loader['path'], '-p']).splitlines():
        match = re.fullmatch(r'\s*([A-Za-z0-9_+.-]+)\s+\(([^)]+)\)\s+=>\s+(/[A-Za-z0-9_+.,/=-]+)', line)
        if not match: continue
        name, attributes, path = match.groups()
        if 'x86-64' not in attributes: continue
        cache.setdefault(name, set()).add(path)
    libraries = {}; pending = list(tools.values()) + list(programs.values()); seen = set()
    while pending:
        value = pending.pop(); path = value['path']
        if path in seen: continue
        seen.add(path); require(len(seen) <= 266, 'Host closure bound')
        elf = host.read_elf(path, 62)
        needs = [(name, None) for name in elf['needed']]
        if elf['interpreter']: needs.append((Path(elf['interpreter']).name, elf['interpreter']))
        for name, direct in needs:
            if name in libraries:
                if direct: require(libraries[name]['path'] == str(Path(direct).resolve(strict=True)), 'Interpreter alias differs')
                continue
            choices = {str(Path(x).resolve(strict=True)) for x in cache.get(name, ())}
            if direct: choices.add(str(Path(direct).resolve(strict=True)))
            require(len(choices) == 1, 'Missing/ambiguous selected ELF dependency: ' + name)
            selected = pair(direct if direct else sorted(cache[name])[0]); selected['soname'] = name
            host.system_file({k:selected[k] for k in ('requestedPath','path')}); libraries[name] = selected; pending.append(selected)
    distro_path = pair('/etc/os-release'); info = host.system_file(distro_path, 16384)
    distro_bytes = Path(distro_path['path']).read_bytes(); require(host.digest(distro_bytes) == info['sha256'], 'Distro changed'); distro = host.os_release(distro_bytes)
    glibc = command([tools['getconf']['path'], 'GNU_LIBC_VERSION']); require(re.fullmatch(r'glibc [0-9]+\.[0-9]+', glibc), 'glibc admission')
    selection = {'kind':'linux-native-host-selection-1','schemaVersion':1,'arch':'x64','distro':{'id':distro['ID'],'versionId':distro['VERSION_ID']},'glibcVersion':glibc.split()[1],'tools':tools,'compilerPrograms':programs,'osRelease':distro_path,'loaderCache':pair('/etc/ld.so.cache'),'systemLibraries':sorted(libraries.values(),key=lambda x:x['soname'])}
    host.validate_selection(selection); return selection

def elf_failure_context(host, error):
    """Read only fixed fields from the actual sealed parser's refusal frame."""
    cursor = error.__traceback__; values = None
    for _ in range(32):
        if cursor is None: break
        if cursor.tb_frame.f_code is host.read_elf.__code__:
            values = cursor.tb_frame.f_locals; break
        cursor = cursor.tb_next
    if values is None: return None
    path = host.absolute(str(values['path'])); before = values['before']
    require(isinstance(before, os.stat_result), 'Actual parser file observation required')
    number = lambda name: values.get(name) if type(values.get(name)) is int and 0 <= values[name] < 2**64 else None
    tags = values.get('tags'); sizes = values.get('sizes')
    require(tags is None or isinstance(tags,list) and len(tags)<=1024 and all(isinstance(t,tuple) and len(t)==2 and all(type(n) is int for n in t) for t in tags), 'Diagnostic dynamic metadata bound')
    require(sizes is None or isinstance(sizes,list) and len(sizes)<=1 and all(type(n) is int and 0<=n<2**64 for n in sizes), 'Diagnostic string-size metadata bound')
    result = {'path':str(path),'parserFileStat':{key:getattr(before,'st_'+key) for key in ('dev','ino','mode','uid','gid','nlink','size','mtime_ns','ctime_ns')},'elf':{'expectedMachine':number('machine'),'observedMachine':number('observed_machine'),'type':number('elf_type'),'programHeaderCount':number('phnum'),'stringTableBytes':sizes,'neededEntryCount':None if tags is None else sum(tag==1 for tag,_ in tags),'dependencyNamesReported':False},'reauthenticatedFile':None,'reauthenticationErrorType':None}
    try:
        current = path.lstat()
        # Failure-only reauthentication uses the original selected-file policy
        # and its unchanged MAX_FILE; it does not retry or admit the ELF parser.
        observed = host.system_file({'requestedPath':str(path),'path':str(path)})
        after = path.lstat()
        result['reauthenticatedFile'] = {'sha256':observed['sha256'],'byteLength':observed['byteLength'],'sameFileStatAsRefusedRead':host.identity(before)==host.identity(current)==host.identity(after)}
    except BaseException as secondary:
        result['reauthenticationErrorType'] = re.sub('[^A-Za-z0-9_.]','?',type(secondary).__name__)[:80]
    return result

def preserve_host_failure(host, primary, stage, producer_seal, parser_hash):
    value = {'kind':'hosted-native-elf-refusal-context-1','stage':stage,'producerSealSHA256':producer_seal,'parserSHA256':parser_hash,'primaryExceptionPreserved':True,'setupMeasured':False,'qualification':False,'elfContext':None,'diagnosticErrorType':None}
    try:
        value['elfContext'] = elf_failure_context(host, primary)
        raw = json.dumps(value,separators=(',',':'))
        require(len(raw.encode())<=8192, 'Diagnostic output bound')
    except BaseException as secondary:
        value['elfContext'] = None
        value['diagnosticErrorType'] = re.sub('[^A-Za-z0-9_.]','?',type(secondary).__name__)[:80]
        raw = json.dumps(value,separators=(',',':'))
    try: sys.stderr.write(raw+'\n')
    except BaseException: pass
    raise primary

def main():
    require(sys.flags.isolated and sys.flags.no_site and sys.dont_write_bytecode and not sys.flags.optimize, 'Use Python -I -S -B')
    require(sys.platform == 'linux' and os.getuid() == os.geteuid() != 0, 'Selected nonroot Linux setup observer required')
    parser = argparse.ArgumentParser(); parser.add_argument('--producer-root', required=True); parser.add_argument('--producer-seal', required=True); parser.add_argument('--output', required=True)
    args = parser.parse_args(); root = Path(args.producer_root); seal_raw = read(root / 'producer-seal.json', 1048576)
    require(hashlib.sha256(seal_raw).hexdigest() == args.producer_seal, 'Explicit producer seal differs'); seal = json.loads(seal_raw)
    row = seal['files']['linux_host.py']; raw = read(root / 'linux_host.py', 1048576)
    require(row == {'hash':'sha256:' + hashlib.sha256(raw).hexdigest(),'byteLength':str(len(raw))}, 'Sealed host parser differs')
    host = types.ModuleType('selected_linux_host'); exec(compile(raw,str(root/'linux_host.py'),'exec',dont_inherit=True),host.__dict__)
    environment = {key:os.environ[key] for key in ('PATH','HOME','TMPDIR')}; stage = 'dependency-selection'
    try:
        selection = select(host, environment)
        stage = 'native-host-observation'; observed = host.native_host(environment,selection)
    except Exception as primary:
        preserve_host_failure(host, primary, stage, args.producer_seal, row['hash'])
    out = Path(args.output); require(out.is_absolute() and out.parent.resolve(strict=True) == out.parent, 'Canonical setup output required'); out.mkdir(mode=0o700)
    refs = {}
    for name,value in [('selection.json',selection),('observation.json',observed)]:
        data = (json.dumps(value,sort_keys=True,indent=2)+'\n').encode(); fd=os.open(out/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,'wb') as stream: stream.write(data);stream.flush();os.fsync(stream.fileno())
        refs[name]={'path':str(out/name),'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
    print(json.dumps({'setupMeasured':False,'physicalQualification':False,'files':refs}))

if __name__ == '__main__':
    try: main()
    except Exception as error: sys.stderr.write(type(error).__name__+': '+str(error)[:2048]+'\n');sys.exit(1)
