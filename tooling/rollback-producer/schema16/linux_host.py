"""Bounded Linux native-host observations, not an SDK archive or executable pin.

Import is inert. native_host requires an explicit reviewed path selection and a
root-authorized execution window. No discovery through PATH, ldd or a shell.
"""
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import signal
import stat
import struct
import subprocess
import sys
import tempfile
import time

MAX_FILE = 268435456
MAX_TOTAL = 1073741824
MAX_LIBRARIES = 256
MAX_COMMAND_OUTPUT = 131072
ARCHITECTURES = {'x64': ('x86_64', 62, 'x86_64-linux-gnu'), 'arm64': ('aarch64', 183, 'aarch64-linux-gnu')}


class LinuxHostError(ValueError):
    pass


def require(value, message):
    if not value: raise LinuxHostError(message)


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()


def digest(value):
    return 'sha256:' + hashlib.sha256(value).hexdigest()


def keys(value, expected):
    require(isinstance(value, dict) and set(value) == set(expected), 'Unexpected selection fields')


def absolute(value):
    require(isinstance(value, str) and len(value) <= 4096 and re.fullmatch(r'/[A-Za-z0-9_+.,/=-]+', value), 'Unsupported absolute system path')
    require(str(Path(value)) == value and all(part not in ('.', '..') for part in value.split('/')[1:]), 'Noncanonical lexical path')
    return Path(value)


def pair(value):
    keys(value, ['requestedPath', 'path'])
    absolute(value['requestedPath']); absolute(value['path'])
    return value


def validate_selection(value):
    keys(value, ['kind', 'schemaVersion', 'arch', 'distro', 'glibcVersion', 'tools', 'compilerPrograms', 'osRelease', 'loaderCache', 'systemLibraries'])
    require(value['kind'] == 'linux-native-host-selection-1' and type(value['schemaVersion']) is int and value['schemaVersion'] == 1, 'Unsupported Linux host selection')
    require(value['arch'] in ARCHITECTURES, 'Unsupported Linux architecture')
    keys(value['distro'], ['id', 'versionId'])
    require(all(isinstance(value['distro'][key], str) and re.fullmatch(r'[a-zA-Z0-9_.-]{1,64}', value['distro'][key]) for key in value['distro']), 'Invalid explicit distro')
    require(isinstance(value['glibcVersion'], str) and len(value['glibcVersion']) <= 32 and re.fullmatch(r'[0-9]+\.[0-9]+', value['glibcVersion']), 'Invalid explicit glibc version')
    keys(value['tools'], ['gcc', 'gxx', 'make', 'python', 'getconf'])
    keys(value['compilerPrograms'], ['cc1', 'cc1plus', 'collect2', 'as', 'ld'])
    for item in [*value['tools'].values(), *value['compilerPrograms'].values(), value['osRelease'], value['loaderCache']]: pair(item)
    require(value['osRelease']['requestedPath'] == '/etc/os-release' and value['loaderCache']['requestedPath'] == '/etc/ld.so.cache', 'Unexpected distro or loader metadata authority')
    libraries = value['systemLibraries']
    require(isinstance(libraries, list) and 0 < len(libraries) <= MAX_LIBRARIES, 'System library selection exceeds bound')
    names, paths = set(), set()
    for item in libraries:
        keys(item, ['soname', 'requestedPath', 'path']); pair({key: item[key] for key in ['requestedPath', 'path']})
        require(isinstance(item['soname'], str) and re.fullmatch(r'[A-Za-z0-9_+.-]{1,128}', item['soname']), 'Invalid SONAME')
        require(item['soname'] not in names and item['path'] not in paths, 'Duplicate selected system library')
        names.add(item['soname']); paths.add(item['path'])
        require(Path(item['requestedPath']).name == item['soname'], 'Library request path must name its SONAME')
    require('libc.so.6' in names, 'A glibc runtime selection is required')
    return value


def identity(value):
    return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns, value.st_mode, value.st_uid, value.st_gid, value.st_nlink)


def system_file(selected, maximum=MAX_FILE):
    requested, path = absolute(selected['requestedPath']), absolute(selected['path'])
    require(requested.resolve(strict=True) == path and path.resolve(strict=True) == path, 'System path or symlink target escaped explicit selection')
    # The finite selected path is authority. A root-owned /usr prefix alone is
    # never sufficient; every final file is selected and hashed independently.
    for parent in [path.parent, *path.parent.parents]:
        s = parent.lstat()
        require(stat.S_ISDIR(s.st_mode) and s.st_uid == 0 and not stat.S_IMODE(s.st_mode) & 0o022, 'Unsafe system-file ancestor')
    aliases = []
    parts = requested.parts
    for index in range(1, len(parts)):
        component = Path(*parts[:index + 1]); observed = component.lstat()
        require(observed.st_uid == 0, 'Unowned system alias')
        if stat.S_ISLNK(observed.st_mode):
            aliases.append({'path': str(component), 'target': os.readlink(component)})
        else: require(not stat.S_IMODE(observed.st_mode) & 0o022, 'Writable system alias component')
    before = path.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_uid == 0 and not stat.S_IMODE(before.st_mode) & 0o022 and before.st_nlink >= 1 and 0 < before.st_size <= maximum, 'Unsafe or oversized selected system file')
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        require(identity(os.fstat(descriptor)) == identity(before), 'System file changed before read')
        h = hashlib.sha256(); length = 0
        while True:
            block = os.read(descriptor, 1048576)
            if not block: break
            length += len(block); require(length <= maximum, 'Growing system file exceeds bound'); h.update(block)
        require(length == before.st_size and identity(os.fstat(descriptor)) == identity(before) == identity(path.lstat()), 'System file changed during read')
    finally: os.close(descriptor)
    require(requested.resolve(strict=True) == path and all(os.readlink(item['path']) == item['target'] for item in aliases), 'System alias changed during read')
    return {'requestedPath': str(requested), 'path': str(path), 'sha256': 'sha256:' + h.hexdigest(), 'byteLength': str(length), 'mode': stat.S_IMODE(before.st_mode), 'uid': before.st_uid, 'gid': before.st_gid, 'links': aliases}


def read_elf(path, machine, page_size=None):
    """Read bounded ELF64 little-endian dependency metadata without executing it."""
    page_size = os.sysconf('SC_PAGE_SIZE') if page_size is None else page_size
    require(page_size in (4096, 16384, 65536), 'Unsupported Linux ELF mapping page size')
    path = Path(path); before = path.lstat()
    require(stat.S_ISREG(before.st_mode) and 64 <= before.st_size <= MAX_FILE, 'Invalid ELF size/type')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        require(identity(os.fstat(fd)) == identity(before), 'ELF changed before read')
        def at(offset, size):
            require(type(offset) is int and type(size) is int and 0 <= offset <= before.st_size and 0 <= size <= 1048576 and offset + size <= before.st_size, 'ELF range exceeds bound')
            data = os.pread(fd, size, offset); require(len(data) == size, 'Truncated ELF range'); return data
        header = at(0, 64)
        require(header[:7] == b'\x7fELF\x02\x01\x01', 'Only little-endian ELF64 is supported')
        fields = struct.unpack('<HHIQQQIHHHHHH', header[16:])
        elf_type, observed_machine, version, _, phoff, _, _, ehsize, phsize, phnum, _, _, _ = fields
        require(elf_type in (2, 3) and observed_machine == machine and version == 1 and ehsize == 64 and phsize == 56 and 0 < phnum <= 256, 'ELF target/header mismatch')
        segments = [struct.unpack('<IIQQQQQQ', at(phoff + index * phsize, phsize)) for index in range(phnum)]
        loads, dynamics, interpreters = [], [], []
        for kind, flags, offset, address, physical, filesz, memsz, align in segments:
            require(offset + filesz <= before.st_size and filesz <= memsz, 'Invalid ELF segment bounds')
            if kind == 1:
                require(address + memsz <= 1 << 64 and offset % page_size == address % page_size and (align in (0, 1) or align & (align - 1) == 0 and offset % align == address % align), 'Invalid ELF load alignment')
                loads.append((offset, address, filesz, memsz))
            if kind == 2: dynamics.append((offset, address, filesz))
            if kind == 3:
                raw = at(offset, filesz); require(1 < len(raw) <= 4096 and raw[-1:] == b'\0' and b'\0' not in raw[:-1], 'Invalid ELF interpreter')
                interpreters.append(raw[:-1].decode('ascii'))
        require(len(dynamics) <= 1 and len(interpreters) <= 1, 'Repeated ELF dynamic/interpreter segments')
        # Loader mappings operate on whole pages. A later segment must not
        # replace inspected bytes through a different file-page translation,
        # including bytes outside its declared non-rounded interval.
        mapped = [(index, address // page_size * page_size, (address + count + page_size - 1) // page_size * page_size, offset - address) for index, (offset, address, count, _) in enumerate(loads) if count or address % page_size]
        zeroes = [(index, address + count, (address + memory + page_size - 1) // page_size * page_size) for index, (_, address, count, memory) in enumerate(loads) if memory > count]
        overlaps = lambda left, right: max(left[0], right[0]) < min(left[1], right[1])
        for index, start, end, translation in mapped:
            for other, other_start, other_end, other_translation in mapped:
                require(index == other or not overlaps((start, end), (other_start, other_end)) or translation == other_translation, 'Conflicting ELF load page mappings')
            for other, zero_start, zero_end in zeroes:
                require(index == other or not overlaps((start, end), (zero_start, zero_end)), 'ELF zero-fill overlaps another file mapping')
        def metadata_mapping(address, size):
            require(not any(overlaps((address, address + size), (start, end)) for _, start, end in zeroes), 'ELF zero-fill overlaps inspected metadata')
            return [offset + address - start for offset, start, count, _ in loads if start <= address and address + size <= start + count]
        tags = []
        if dynamics:
            offset, address, size = dynamics[0]; require(size > 0 and size % 16 == 0 and size <= 16384, 'ELF dynamic table exceeds bound')
            mappings = metadata_mapping(address, size)
            require(mappings == [offset], 'ELF dynamic virtual/file mappings differ')
            terminated = False
            for index in range(size // 16):
                tag, value = struct.unpack('<qQ', at(offset + index * 16, 16))
                if tag == 0: terminated = True; break
                tags.append((tag, value))
            require(terminated, 'Unterminated dynamic table')
        require(not any(tag in (15, 29, 0x7fffffff, 0x7ffffffd, 0x6ffffefc, 0x6ffffefb) for tag, _ in tags), 'System ELF has unsupported loader search/filter/audit behavior')
        string_tables = [value for tag, value in tags if tag == 5]; sizes = [value for tag, value in tags if tag == 10]
        names = [value for tag, value in tags if tag in (1, 14)]
        require(len(string_tables) == len(sizes) and len(string_tables) <= 1 and (not names or len(string_tables) == 1), 'Invalid ELF string table')
        strings = b''
        if string_tables:
            address, size = string_tables[0], sizes[0]; require(0 < size <= 1048576, 'ELF string table exceeds bound')
            matches = metadata_mapping(address, size)
            require(len(matches) == 1, 'Ambiguous ELF string mapping'); strings = at(matches[0], size)
        def string(offset):
            require(offset < len(strings), 'Invalid ELF string offset'); end = strings.find(b'\0', offset)
            require(offset < end <= offset + 128, 'Unbounded ELF dependency name')
            value = strings[offset:end].decode('ascii'); require(re.fullmatch(r'[A-Za-z0-9_+.-]{1,128}', value), 'ELF dependency is not a SONAME'); return value
        needed = [string(value) for tag, value in tags if tag == 1]; sonames = [string(value) for tag, value in tags if tag == 14]
        require(len(needed) <= 128 and len(needed) == len(set(needed)) and len(sonames) <= 1, 'Invalid ELF dependency cardinality')
        require(identity(before) == identity(os.fstat(fd)) == identity(path.lstat()), 'ELF changed during inspection')
        return {'machine': machine, 'pageSize': page_size, 'needed': needed, 'interpreter': interpreters[0] if interpreters else None, 'soname': sonames[0] if sonames else None}
    finally: os.close(fd)


def dependency_closure(roots, libraries):
    """Every static dependency and interpreter resolves through the finite map."""
    by_name = {item['soname']: item for item in libraries}; by_path = {}
    for item in libraries:
        for path in [item['requestedPath'], item['path']]:
            require(path not in by_path or by_path[path] is item, 'Ambiguous system path'); by_path[path] = item
        require(item['elf']['soname'] in (None, item['soname']), 'Selected library SONAME differs from its file')
    pending, done = list(roots) + libraries, set()
    while pending:
        value = pending.pop()
        if value['path'] in done: continue
        done.add(value['path'])
        for name in value['elf']['needed']:
            require(name in by_name, 'Unselected system dependency: ' + name); pending.append(by_name[name])
        interpreter = value['elf']['interpreter']
        if interpreter:
            require(interpreter in by_path, 'Unselected ELF interpreter: ' + interpreter); pending.append(by_path[interpreter])
    return sorted(done)


def os_release(data):
    require(len(data) <= 16384, 'Distro metadata exceeds bound'); values = {}
    for line in data.decode('utf8').splitlines():
        if not line or line.startswith('#'): continue
        match = re.fullmatch(r'([A-Z_][A-Z0-9_]*)=(.*)', line); require(match, 'Malformed distro metadata')
        key, value = match.groups(); require(key not in values, 'Duplicate distro field')
        if value.startswith('"') and value.endswith('"'): value = value[1:-1]
        elif value.startswith("'") and value.endswith("'"): value = value[1:-1]
        require('\0' not in value, 'Invalid distro value'); values[key] = value
    require('ID' in values and 'VERSION_ID' in values, 'Distro identity missing')
    return values


def command(argv, environment):
    """Version/discovery only; no shell, bounded streams and drained process group."""
    child = None; failure = None
    def alive(pid):
        try: os.killpg(pid, 0); return True
        except ProcessLookupError: return False
    with tempfile.TemporaryFile(dir=environment['TMPDIR']) as stdout, tempfile.TemporaryFile(dir=environment['TMPDIR']) as stderr:
        try:
            child = subprocess.Popen(argv, env=environment, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr, start_new_session=True)
            deadline = time.monotonic() + 15
            while child.poll() is None:
                require(time.monotonic() < deadline and os.fstat(stdout.fileno()).st_size <= MAX_COMMAND_OUTPUT and os.fstat(stderr.fileno()).st_size <= MAX_COMMAND_OUTPUT, 'Host command exceeded time/output bound')
                time.sleep(.01)
        except BaseException as error: failure = error
        finally:
            if child and alive(child.pid):
                if failure is None: failure = LinuxHostError('Host discovery left an owned process group')
                try: os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError: pass
            if child: child.wait(timeout=5)
            deadline = time.monotonic() + 5
            while child and alive(child.pid) and time.monotonic() < deadline: time.sleep(.01)
        require(child is not None and not alive(child.pid), 'Host command process group did not drain')
        stdout.seek(0); stderr.seek(0); out = stdout.read(MAX_COMMAND_OUTPUT + 1); err = stderr.read(MAX_COMMAND_OUTPUT + 1)
    require(failure is None and child.returncode == 0 and max(len(out), len(err)) <= MAX_COMMAND_OUTPUT, 'Host discovery failed: ' + str(failure))
    return {'command': argv, 'exitCode': child.returncode, 'stdout': out.decode('utf8'), 'stderr': err.decode('utf8'), 'processGroupDrained': True}


def native_host(environment, selection):
    """Run only under the separately authorized Linux qualification window.

    Repeat with the SAME original isolated environment after native build and
    require exact equality. The finite dependency observation is not a complete
    compiler header/runtime/SDK archive and is not hardware timing qualification.
    """
    validate_selection(selection)
    require(sys.platform == 'linux', 'Linux host observation cannot run on another OS')
    machine, elf_machine, triplet = ARCHITECTURES[selection['arch']]
    require(platform.machine() == machine, 'Linux machine differs from explicit architecture')
    require(isinstance(environment, dict) and all(isinstance(environment.get(key), str) and environment[key] for key in ['PATH', 'HOME', 'TMPDIR']), 'Explicit isolated environment required')
    require(not any(key.startswith(('LD_', 'DYLD_')) or key in ['PYTHONPATH', 'PYTHONHOME', 'GCC_EXEC_PREFIX', 'COMPILER_PATH', 'BASH_ENV', 'ENV', 'CC', 'CXX', 'MAKE'] for key in environment), 'Original host environment contains native search or execution overrides')
    env = {key: environment[key] for key in ['PATH', 'HOME', 'TMPDIR']}; env.update(LANG='C', LC_ALL='C', PYTHONNOUSERSITE='1', PYTHONSAFEPATH='1', PYTHONDONTWRITEBYTECODE='1')
    for key in ['HOME', 'TMPDIR']:
        path = Path(env[key]); require(path.is_absolute() and path.resolve(strict=True) == path, 'Noncanonical private host directory'); s = path.lstat()
        require(stat.S_ISDIR(s.st_mode) and s.st_uid == os.getuid() and not stat.S_IMODE(s.st_mode) & 0o077, 'Host environment directory is not private')
    require(not os.path.lexists('/etc/ld.so.preload'), 'Unselected global loader preload')
    files = {}
    def observe_file(item, maximum=MAX_FILE):
        value = system_file(item, maximum); old = files.get(value['path']); require(old is None or old['sha256'] == value['sha256'], 'Inconsistent repeated host file')
        files[value['path']] = value; require(sum(int(row['byteLength']) for row in files.values()) <= MAX_TOTAL, 'Native host selected bytes exceed bound'); return value
    tools = {name: observe_file(item) for name, item in selection['tools'].items()}
    programs = {name: observe_file(item) for name, item in selection['compilerPrograms'].items()}
    require(all(row['mode'] & 0o111 for row in [*tools.values(), *programs.values()]), 'Selected native tool is not executable')
    libraries = [{**observe_file(item), 'soname': item['soname']} for item in selection['systemLibraries']]
    for value in [*tools.values(), *programs.values(), *libraries]: value['elf'] = read_elf(value['path'], elf_machine)
    closure = dependency_closure([*tools.values(), *programs.values()], libraries)
    distro_file = observe_file(selection['osRelease'], 16384); cache_file = observe_file(selection['loaderCache'], 16777216)
    fd = os.open(distro_file['path'], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try: data = os.read(fd, 16385)
    finally: os.close(fd)
    require(len(data) <= 16384 and digest(data) == distro_file['sha256'], 'Distro metadata changed'); distro = os_release(data)
    require({key: distro[field] for key, field in [('id', 'ID'), ('versionId', 'VERSION_ID')]} == selection['distro'], 'Distro differs from explicit selection')
    commands = []
    def observe(argv):
        result = command(argv, env); commands.append(result); return result['stdout'].strip()
    for name in ['gcc', 'gxx', 'make', 'python']:
        output = observe([tools[name]['path'], '--version']); require(output, 'Empty tool version'); tools[name]['versionOutput'] = output
    require(observe([tools['gcc']['path'], '-dumpmachine']) == triplet and observe([tools['gxx']['path'], '-dumpmachine']) == triplet, 'Compiler architecture differs')
    program_directories = sorted({str(Path(row['path']).parent) for row in programs.values()})
    for name, executable in [('cc1', 'cc1'), ('cc1plus', 'cc1plus'), ('collect2', 'collect2'), ('as', 'as'), ('ld', 'ld')]:
        for directory in program_directories:
            candidate = Path(directory) / executable
            if os.path.lexists(candidate): require(candidate.resolve(strict=True) == Path(programs[name]['path']), 'COMPILER_PATH would select an undeclared program')
        found = observe([tools['gxx' if name == 'cc1plus' else 'gcc']['path'], '-print-prog-name=' + executable])
        if not found.startswith('/'):
            # GCC's literal "as"/"ld" means PATH lookup. The returned build
            # environment explicitly fixes COMPILER_PATH to the selected dirs.
            require(found == executable and name in ['as', 'ld'], 'Unexpected compiler program lookup')
        else: require(Path(found).resolve(strict=True) == Path(programs[name]['path']), 'Compiler program escaped selected bytes')
    runtime = json.loads(observe([tools['python']['path'], '-I', '-c', "import json,sys;print(json.dumps({'executable':sys.executable,'version':list(sys.version_info[:3]),'implementation':sys.implementation.name}))"]))
    require(runtime.get('implementation') == 'cpython' and isinstance(runtime.get('version'), list) and len(runtime['version']) == 3 and all(type(n) is int for n in runtime['version']) and tuple(runtime['version']) >= (3, 12, 0) and Path(runtime['executable']).resolve(strict=True) == Path(tools['python']['path']), 'Expected exact CPython3.12+ executable')
    glibc = observe([tools['getconf']['path'], 'GNU_LIBC_VERSION']); require(glibc == 'glibc ' + selection['glibcVersion'], 'glibc differs from selected version')
    # Re-prove every selection and alias after discovery; no pathname trust or
    # observed --version string substitutes for exact executable/library bytes.
    for group in [selection['tools'].values(), selection['compilerPrograms'].values(), selection['systemLibraries'], [selection['osRelease'], selection['loaderCache']]]:
        for item in group:
            current = system_file(item); before = files[current['path']]
            require(all(current[key] == before[key] for key in current), 'Host input changed during observation')
    require(not os.path.lexists('/etc/ld.so.preload'), 'Loader preload appeared during observation')
    build_env = {'CC': tools['gcc']['path'], 'CXX': tools['gxx']['path'], 'MAKE': tools['make']['path'], 'PYTHON': tools['python']['path'], 'NODE_GYP_FORCE_PYTHON': tools['python']['path'], 'COMPILER_PATH': ':'.join(program_directories), 'PYTHONNOUSERSITE': '1', 'PYTHONSAFEPATH': '1', 'PYTHONDONTWRITEBYTECODE': '1'}
    return {'kind': 'linux-native-host-observation-1', 'schemaVersion': 1, 'platform': {'os': 'linux', 'arch': selection['arch'], 'machine': machine}, 'selectionHash': digest(canonical(selection)), 'provenance': 'host-native-not-archive-pinned', 'scope': 'Exact selected tool files and static ELF system dependencies, distro and loader-cache metadata; not a complete SDK/compiler/header/Python-stdlib archive, dynamic dependency discovery, or Linux C hardware/timing qualification.', 'environment': build_env, 'tools': tools, 'compilerPrograms': programs, 'pythonRuntime': runtime, 'distro': {'identity': distro_file, 'fields': distro}, 'glibc': {'version': selection['glibcVersion'], 'observation': glibc}, 'loaderCache': cache_file, 'systemLibraries': libraries, 'dependencyClosure': closure, 'commands': commands}
