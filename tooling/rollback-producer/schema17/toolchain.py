"""Read-only authentication of the exact local Node/npm inputs before use.

Importing this module does nothing. authenticate() reads, but never extracts or
executes, distribution archives. Its complete returned observation can be
compared again after a build. It intentionally excludes access times.
"""
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import posixpath
import re
import shlex
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time


class ToolchainAuthenticationError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise ToolchainAuthenticationError(message)


def identity(value):
    return {"device": value.st_dev, "inode": value.st_ino,
            "mode": stat.S_IMODE(value.st_mode), "type": stat.S_IFMT(value.st_mode),
            "links": value.st_nlink, "uid": value.st_uid, "gid": value.st_gid,
            "bytes": value.st_size, "mtimeNs": value.st_mtime_ns,
            "ctimeNs": value.st_ctime_ns}


def relative(name):
    require(isinstance(name, str) and 0 < len(name) <= 4096,
            "Invalid distribution member name")
    path = PurePosixPath(name)
    require(not path.is_absolute() and str(path) == name and
            all(part not in ("", ".", "..") for part in path.parts) and
            "\\" not in name and not any(ord(c) < 32 or ord(c) == 127 for c in name),
            "Unsafe distribution member: " + name)
    return name


def directory(value, label):
    require(stat.S_ISDIR(value.st_mode) and not stat.S_IMODE(value.st_mode) & 0o7022,
            "Toolchain directory is special or writable by other users: " + label)


def secure_stat(root, name):
    relative(name)
    directory(root.lstat(), str(root))
    current = root
    parts = PurePosixPath(name).parts
    for index, part in enumerate(parts):
        current /= part
        value = current.lstat()
        if index != len(parts) - 1:
            directory(value, str(current))
        elif stat.S_ISDIR(value.st_mode):
            directory(value, str(current))
    return value


def regular(root, name, algorithms=("sha256",)):
    """Hash one single-link regular file and retain its unchanged path identity."""
    path = root / name
    before = secure_stat(root, name)
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1,
            "Expected a single-link regular toolchain file: " + str(path))
    require(not stat.S_IMODE(before.st_mode) & 0o7000,
            "Special permission bits are unsupported: " + str(path))
    digests = {algorithm: hashlib.new(algorithm) for algorithm in algorithms}
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), "rb") as stream:
        require(identity(before) == identity(os.fstat(stream.fileno())),
                "Toolchain file was replaced before hashing: " + str(path))
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            for digest in digests.values():
                digest.update(block)
        require(identity(before) == identity(os.fstat(stream.fileno())) ==
                identity(secure_stat(root, name)), "Toolchain file changed while hashing: " + str(path))
    return {"path": str(path), "byteLength": str(before.st_size),
            "digests": {name: digest.hexdigest() for name, digest in digests.items()},
            "identity": identity(before)}


def archive_members(root, name, archive_observation, prefix, selections):
    """Read exact selected member bytes without extracting any archive entry."""
    expected, seen = {}, set()
    total = 0
    with os.fdopen(os.open(root / name, os.O_RDONLY | os.O_NOFOLLOW), "rb") as stream:
        require(identity(os.fstat(stream.fileno())) == archive_observation["identity"],
                "Distribution archive changed before member authentication")
        with tarfile.open(fileobj=stream, mode="r:*") as distribution:
            for member in distribution:
                # Tar directory spelling may have exactly one trailing slash.
                raw = member.name[:-1] if member.isdir() and member.name.endswith("/") else member.name
                relative(raw)
                require(raw not in seen, "Duplicate distribution member: " + raw)
                seen.add(raw)
                require(len(seen) <= 100000, "Distribution member limit exceeded")
                require(raw == prefix or raw.startswith(prefix + "/"),
                        "Unexpected distribution root: " + raw)
                local = raw[len(prefix) + 1:] if raw != prefix else ""
                if not any(local == item or local.startswith(item + "/") or item == "" or
                           member.isdir() and local and item.startswith(local + "/") for item in selections):
                    continue
                if local == "":
                    require(member.isdir(), "Distribution root must be a directory")
                    continue
                relative(local)
                require(not member.mode & 0o7000, "Special distribution permission bits: " + raw)
                require(member.isfile() or member.isdir() or member.issym(),
                        "Unsupported selected distribution member type: " + raw)
                record = {"mode": member.mode & 0o777, "archivePath": raw,
                          "type": "file" if member.isfile() else "directory" if member.isdir() else "symlink"}
                if member.isfile():
                    total += member.size
                    require(0 <= member.size <= 512 * 1024 ** 2 and total <= 2 * 1024 ** 3,
                            "Distribution selected-byte limit exceeded")
                    digest = hashlib.sha256()
                    count = 0
                    source = distribution.extractfile(member)
                    require(source is not None, "Missing distribution member content")
                    with source:
                        for block in iter(lambda: source.read(1024 * 1024), b""):
                            count += len(block)
                            digest.update(block)
                    require(count == member.size, "Truncated distribution member: " + raw)
                    record.update(byteLength=str(count), sha256="sha256:" + digest.hexdigest())
                elif member.issym():
                    target = member.linkname
                    require(isinstance(target, str) and target and len(target) <= 4096 and
                            not target.startswith("/") and "\\" not in target and
                            not any(ord(c) < 32 or ord(c) == 127 for c in target),
                            "Unsafe distribution symlink: " + raw)
                    resolved = posixpath.normpath(posixpath.join(posixpath.dirname(local), target))
                    relative(resolved)
                    record.update(target=target, resolvedTarget=resolved)
                expected[local] = record
        require(identity(os.fstat(stream.fileno())) == archive_observation["identity"] ==
                identity(secure_stat(root, name)), "Distribution archive changed while reading members")
    require(expected, "Selected distribution members are absent")
    # Tar producers may omit directory headers. Preserve explicit directory modes
    # when present, and infer only the required ordinary directory structure.
    for name in list(expected):
        for ancestor in PurePosixPath(name).parents:
            if str(ancestor) == ".":
                continue
            parent = str(ancestor)
            require(parent not in expected or expected[parent]["type"] == "directory",
                    "Non-directory archive ancestor: " + parent)
            expected.setdefault(parent, {"type": "directory", "mode": None, "archivePath": None})
    for name, record in expected.items():
        if record["type"] != "symlink":
            continue
        seen_links = {name}
        target = record["resolvedTarget"]
        while True:
            require(target in expected and target not in seen_links,
                    "Distribution link escapes selected closure or cycles: " + name)
            target_record = expected[target]
            if target_record["type"] != "symlink":
                require(target_record["type"] == "file", "Distribution link must resolve to a regular file: " + name)
                break
            seen_links.add(target)
            target = target_record["resolvedTarget"]
    return dict(sorted(expected.items()))


def actual_tree(root, selections):
    result = {}

    def visit(name):
        value = secure_stat(root, name)
        result[name] = identity(value)
        if stat.S_ISDIR(value.st_mode):
            for child in sorted((root / name).iterdir(), key=lambda path: path.name):
                visit(name + "/" + child.name)
            require(result[name] == identity(secure_stat(root, name)),
                    "Toolchain directory changed while reading: " + name)
        else:
            require(stat.S_ISREG(value.st_mode) or stat.S_ISLNK(value.st_mode),
                    "Special toolchain member: " + name)

    for selection in selections:
        if selection == "":
            before = root.lstat()
            require(stat.S_ISDIR(before.st_mode), "Toolchain root must be a directory")
            for child in sorted(root.iterdir(), key=lambda path: path.name):
                visit(child.name)
            require(identity(before) == identity(root.lstat()), "Toolchain root changed while reading")
        else:
            visit(selection)
    for name in list(result):
        for ancestor in PurePosixPath(name).parents:
            if str(ancestor) != ".":
                result.setdefault(str(ancestor), identity(secure_stat(root, str(ancestor))))
    return dict(sorted(result.items()))


def authenticate_members(root, expected, selections):
    require(root.is_dir() and root == root.resolve(strict=True), "Toolchain package root is not canonical")
    directory(root.lstat(), str(root))
    root_before = identity(root.lstat())
    before = actual_tree(root, selections)
    require(set(before) == set(expected), "Installed toolchain member set differs from its distribution")
    records = {}
    for name, archived in expected.items():
        observed = before[name]
        kind = {stat.S_IFREG: "file", stat.S_IFDIR: "directory", stat.S_IFLNK: "symlink"}.get(observed["type"])
        require(kind == archived["type"], "Toolchain member type differs: " + name)
        if kind != "symlink":
            require(not observed["mode"] & 0o7000 and not observed["mode"] & 0o022,
                    "Writable or special toolchain member permissions: " + name)
        if archived["mode"] is not None and kind != "symlink":
            require(observed["mode"] == archived["mode"], "Toolchain member mode differs: " + name)
        record = {"path": str(root / name), "type": kind, "archivePath": archived["archivePath"], "identity": observed}
        if kind == "file":
            hashed = regular(root, name)
            require(hashed["identity"] == observed and hashed["byteLength"] == archived["byteLength"] and
                    "sha256:" + hashed["digests"]["sha256"] == archived["sha256"],
                    "Toolchain member content differs: " + name)
            record.update(byteLength=hashed["byteLength"], sha256=archived["sha256"])
        elif kind == "symlink":
            target = os.readlink(root / name)
            require(target == archived["target"] and identity(secure_stat(root, name)) == observed,
                    "Toolchain link differs or changed: " + name)
            # Resolve actual chain too: a symlinked ancestor cannot turn an
            # archive-internal lexical target into a different installed file.
            require((root / name).resolve(strict=True) == (root / archived["resolvedTarget"]).resolve(strict=True),
                    "Toolchain symlink resolution differs: " + name)
            require((root / name).resolve(strict=True).is_relative_to(root), "Toolchain link escapes package")
            record.update(target=target, resolvedPath=str((root / name).resolve(strict=True)))
        records[name] = record
    require(before == actual_tree(root, selections) and root_before == identity(root.lstat()),
            "Installed toolchain changed during authentication")
    return {"root": str(root), "rootIdentity": root_before, "members": records}


def authenticate(repo: Path, capturedPins: dict):
    """Authenticate locally retained distribution bytes and installed inputs.

    The result contains potentially thousands of member records. Retain it as a
    separate sealed observation, hash it in compact receipts, and require exact
    equality from a second authentication after the independently fresh build.
    """
    repo = Path(repo).absolute()
    require(repo.is_dir() and repo == repo.resolve(strict=True), "Toolchain repository must be canonical")
    directory(repo.lstat(), str(repo))
    require(capturedPins.get("node") == "26.10.0" and capturedPins.get("npm") == "12.1.0",
            "Unexpected captured toolchain versions")
    machine = platform.machine()
    require(sys.platform in ("darwin", "linux") and machine in ("arm64", "aarch64", "x86_64", "AMD64"),
            "Unsupported toolchain host platform")
    arch = "arm64" if machine in ("arm64", "aarch64") else "x64"
    platform_key = sys.platform + "-" + arch
    pin = capturedPins["nodeArchives"][platform_key]
    expected_name = "node-v26.10.0-" + platform_key
    filename = pin["filename"]
    require(filename in (expected_name + ".tar.gz", expected_name + ".tar.xz") and
            isinstance(pin["sha256"], str) and re.fullmatch("[0-9a-f]{64}", pin["sha256"]),
            "Invalid captured Node distribution pin")
    node_archive_name = ".toolchain/" + filename
    npm_archive_name = ".toolchain/npm-12.1.0.tgz"
    node_archive = regular(repo, node_archive_name)
    require(node_archive["digests"]["sha256"] == pin["sha256"], "Pinned Node archive hash differs")
    npm_archive = regular(repo, npm_archive_name, ("sha256", "sha512"))
    npm_integrity = "sha512-" + base64.b64encode(bytes.fromhex(npm_archive["digests"]["sha512"])).decode("ascii")
    require(npm_integrity == capturedPins["npmArchive"]["integrity"], "Pinned npm archive integrity differs")
    node_selections = ["LICENSE", "bin/node", "include/node"]
    node_expected = archive_members(repo, node_archive_name, node_archive, expected_name, node_selections)
    npm_expected = archive_members(repo, npm_archive_name, npm_archive, "package", [""])
    node_root = repo / ".toolchain" / expected_name
    npm_root = repo / ".toolchain/npm-12.1.0/package"
    ancestor_names = [".toolchain", ".toolchain/" + expected_name,
                      ".toolchain/npm-12.1.0", ".toolchain/npm-12.1.0/package"]
    ancestor_guards = {name: identity(secure_stat(repo, name)) for name in ancestor_names}
    require(all(record["type"] == stat.S_IFDIR for record in ancestor_guards.values()),
            "Toolchain ancestor must be an ordinary directory")
    node = authenticate_members(node_root, node_expected, node_selections)
    npm = authenticate_members(npm_root, npm_expected, [""])
    required_node = ["bin/node", "include/node/config.gypi", "include/node/common.gypi", "LICENSE"]
    required_npm = ["package.json", "bin/npm-cli.js", "node_modules/node-gyp/bin/node-gyp.js"]
    for collection, names in [(node["members"], required_node), (npm["members"], required_npm)]:
        require(all(name in collection and collection[name]["type"] == "file" for name in names),
                "Required toolchain entry is missing or not a regular file")
    # Decode exactly the bytes authenticated here, not a second unchecked read.
    with os.fdopen(os.open(npm_root / "package.json", os.O_RDONLY | os.O_NOFOLLOW), "rb") as stream:
        package_bytes = stream.read(1048577)
    require(len(package_bytes) <= 1048576 and "sha256:" + hashlib.sha256(package_bytes).hexdigest() ==
            npm["members"]["package.json"]["sha256"], "npm package metadata changed")
    metadata = json.loads(package_bytes)
    require(metadata.get("name") == "npm" and metadata.get("version") == "12.1.0", "Wrong npm package metadata")
    # Cover the interval between reading archive members and inspecting installed
    # inputs, as well as same-byte replacement of the distribution files.
    require(node_archive == regular(repo, node_archive_name) and
            npm_archive == regular(repo, npm_archive_name, ("sha256", "sha512")),
            "Toolchain distribution changed during authentication")
    for observed, root, selections in [(node, node_root, node_selections), (npm, npm_root, [""])]:
        require(root == root.resolve(strict=True) and observed["rootIdentity"] == identity(root.lstat()) and
                {name: member["identity"] for name, member in observed["members"].items()} == actual_tree(root, selections),
                "Previously authenticated toolchain inputs changed during authentication")
    require(ancestor_guards == {name: identity(secure_stat(repo, name)) for name in ancestor_names},
            "Toolchain ancestry changed during authentication")
    return {"kind": "schema17-toolchain-authentication-1", "platform": platform_key,
            "nodeVersion": "26.10.0", "npmVersion": "12.1.0", "executed": False,
            "archives": {"node": node_archive, "npm": npm_archive},
            "ancestorIdentities": ancestor_guards,
            "node": node, "npm": npm,
            "nativeBuildInputs": {"nodeDirectory": str(node_root), "includeDirectory": str(node_root / "include/node"),
                                  "configGypi": node["members"]["include/node/config.gypi"],
                                  "commonGypi": node["members"]["include/node/common.gypi"],
                                  "nodeGypScript": npm["members"]["node_modules/node-gyp/bin/node-gyp.js"],
                                  "npmCLI": npm["members"]["bin/npm-cli.js"],
                                  "hostCompilerSDK": "Separate build receipt must record the selected host compiler and SDK"}}


def _host_file(path):
    """Observe host tools, allowing OS-managed links without calling them pinned."""
    requested = Path(path)
    require(requested.is_absolute(), "Host tool path must be absolute")
    requested_before = identity(requested.lstat())
    resolved = requested.resolve(strict=True)
    before = resolved.lstat()
    require(stat.S_ISREG(before.st_mode) and not stat.S_IMODE(before.st_mode) & 0o7022,
            "Unsafe host tool/settings file: " + str(resolved))
    digest = hashlib.sha256()
    with os.fdopen(os.open(resolved, os.O_RDONLY | os.O_NOFOLLOW), "rb") as stream:
        require(identity(before) == identity(os.fstat(stream.fileno())), "Host file replaced before observation")
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
        require(identity(before) == identity(os.fstat(stream.fileno())) == identity(resolved.lstat()) and
                requested.resolve(strict=True) == resolved and requested_before == identity(requested.lstat()),
                "Host file changed during observation")
    return {"requestedPath": str(requested), "path": str(resolved),
            "requestedIdentity": requested_before, "identity": identity(before),
            "byteLength": str(before.st_size), "sha256": "sha256:" + digest.hexdigest()}


def _host_command(argv, environment):
    """Bounded version/discovery command; return deterministic retained output."""
    failure = None
    child = None

    def group_alive(group):
        try:
            os.killpg(group, 0)
            return True
        except ProcessLookupError:
            return False

    with tempfile.TemporaryFile(dir=environment["TMPDIR"]) as stdout, tempfile.TemporaryFile(dir=environment["TMPDIR"]) as stderr:
        try:
            child = subprocess.Popen(argv, env=environment, cwd=environment["HOME"],
                                     stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
                                     start_new_session=True)
            child.wait(timeout=20)
        except BaseException as error:
            failure = error
        finally:
            if child is not None:
                if group_alive(child.pid):
                    failure = failure or RuntimeError("Host discovery command left a process group")
                    try:
                        os.killpg(child.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                    deadline = time.monotonic() + 2
                    while group_alive(child.pid) and time.monotonic() < deadline:
                        child.poll()
                        time.sleep(.02)
                    if group_alive(child.pid):
                        try:
                            os.killpg(child.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired as error:
                    failure = error
                deadline = time.monotonic() + 5
                while group_alive(child.pid) and time.monotonic() < deadline:
                    time.sleep(.02)
                if group_alive(child.pid):
                    failure = RuntimeError("Host discovery process group did not drain")
        stdout.seek(0); stderr.seek(0)
        out = stdout.read(131073); err = stderr.read(131073)
    require(len(out) <= 131072 and len(err) <= 131072, "Host discovery output exceeds its bound")
    observation = {"command": argv, "exitCode": child.returncode if child else None,
                   "stdout": out.decode("utf8"), "stderr": err.decode("utf8"),
                   "processGroupDrained": child is not None and not group_alive(child.pid)}
    if failure is not None or child is None or child.returncode != 0:
        error = ToolchainAuthenticationError("Host discovery failed: " + str(failure or observation))
        error.observation = observation
        raise error
    return observation


def native_host(environment: dict):
    """Observe, never pretend to archive-pin, this Darwin native-build toolchain.

    Call only after the separate distribution authentication and execution gate.
    Apply every returned environment field to npm ci and subsequent build steps.
    Repeat with the SAME original isolated environment after building and require
    exact equality. The commands contain no installation or compilation action.
    """
    require(sys.platform == "darwin", "This native-host observation is Darwin only")
    require(isinstance(environment, dict) and all(isinstance(environment.get(name), str) and environment[name]
            for name in ["PATH", "HOME", "TMPDIR"]), "An explicit isolated environment is required")
    env = {key: value for key, value in environment.items() if key in ("PATH", "HOME", "TMPDIR", "LANG", "LC_ALL")}
    for name in ["HOME", "TMPDIR"]:
        path = Path(env[name])
        require(path.is_absolute() and path == path.resolve(strict=True) and path.is_dir(),
                "Host observation requires canonical private directories")
        observed = path.stat()
        require(observed.st_uid == os.getuid() and not stat.S_IMODE(observed.st_mode) & 0o077,
                "Host observation directory must be private and owned")
    env.update(PYTHONNOUSERSITE="1", PYTHONSAFEPATH="1", PYTHONDONTWRITEBYTECODE="1")
    commands = []
    bootstrap = {name: _host_file(path) for name, path in
                 [("xcrun", "/usr/bin/xcrun"), ("xcodeSelect", "/usr/bin/xcode-select")]}

    def observe(argv):
        item = _host_command(argv, env)
        commands.append(item)
        return item["stdout"].strip()

    def absolute_output(argv):
        value = observe(argv)
        require(value and "\n" not in value and "\r" not in value and Path(value).is_absolute(),
                "Host discovery returned an invalid absolute path")
        return value

    developer = absolute_output(["/usr/bin/xcode-select", "-p"])
    developer_real = Path(developer).resolve(strict=True)
    require(developer_real.is_dir(), "Selected developer directory is absent")
    env["DEVELOPER_DIR"] = str(developer_real)
    clang = absolute_output(["/usr/bin/xcrun", "--find", "clang"])
    clangxx = absolute_output(["/usr/bin/xcrun", "--find", "clang++"])
    make = absolute_output(["/usr/bin/xcrun", "--find", "make"])
    sdk = absolute_output(["/usr/bin/xcrun", "--show-sdk-path"])
    sdk_real = Path(sdk).resolve(strict=True)
    require(sdk_real.is_dir(), "Selected SDK is absent")
    sdk_version = observe(["/usr/bin/xcrun", "--show-sdk-version"])
    require(re.fullmatch(r"[0-9]+(?:\.[0-9]+){0,3}", sdk_version), "Invalid observed SDK version")
    python = str(Path(sys.executable).resolve(strict=True))
    tools = {name: _host_file(path) for name, path in
             [("clang", clang), ("clangXX", clangxx), ("make", make), ("python", python)]}
    for name, path in [("clang", clang), ("clangXX", clangxx), ("make", make), ("python", python)]:
        version = observe([path, "--version"])
        require(version, "Host tool returned no version: " + name)
        tools[name]["versionOutput"] = version
    python_runtime = json.loads(observe([python, "-I", "-c",
        "import json,sys; print(json.dumps({'executable':sys.executable,'version':list(sys.version_info[:3]),'implementation':sys.implementation.name}))"]))
    require(python_runtime.get("implementation") == "cpython" and
            isinstance(python_runtime.get("version"), list) and len(python_runtime["version"]) == 3 and
            all(type(value) is int for value in python_runtime["version"]) and
            tuple(python_runtime["version"]) >= (3, 12, 0) and
            Path(python_runtime["executable"]).resolve(strict=True) == Path(python),
            "Native build requires the observed CPython 3.12+ executable")
    settings_path = sdk_real / "SDKSettings.json"
    settings_identity = _host_file(settings_path)
    with os.fdopen(os.open(settings_identity["path"], os.O_RDONLY | os.O_NOFOLLOW), "rb") as stream:
        settings_bytes = stream.read(4 * 1024 * 1024 + 1)
    require(len(settings_bytes) <= 4 * 1024 * 1024 and
            "sha256:" + hashlib.sha256(settings_bytes).hexdigest() == settings_identity["sha256"],
            "SDKSettings changed or exceeds its bound")
    settings = json.loads(settings_bytes)
    require(isinstance(settings, dict), "SDKSettings must be an object")
    for name, observation in {**bootstrap, **tools, "SDKSettings": settings_identity}.items():
        expected = {key: value for key, value in observation.items() if key != "versionOutput"}
        require(_host_file(observation["requestedPath"]) == expected, "Host input changed during observation: " + name)
    require(Path(developer).resolve(strict=True) == developer_real and Path(sdk).resolve(strict=True) == sdk_real,
            "Host developer or SDK selection changed during observation")
    # node-gyp uses shlex.split for compiler discovery, then inserts the same
    # value verbatim into Make variable assignments and shell recipes. Shell
    # quoting handles spaces, but Make has a separate $/#/backslash language.
    # Refuse those unusual compiler paths instead of selecting a different tool
    # or using an escape that means different bytes in the two consumers.
    require(all(not any(character in path for character in "$#\\\n\r\0") for path in (clang, clangxx)),
            "Selected compiler path is unsupported by the node-gyp Make command contract")
    return {"kind": "schema17-native-host-observation-1", "provenance": "host-native-not-archive-pinned",
            "scope": "Selected compiler, make and Python executable bytes plus SDK identity metadata; not a complete SDK/library archive",
            "environment": {"CC": shlex.quote(clang), "CXX": shlex.quote(clangxx), "SDKROOT": str(sdk_real), "PYTHON": python,
                            "NODE_GYP_FORCE_PYTHON": python, "MAKE": make, "DEVELOPER_DIR": str(developer_real),
                            "PYTHONNOUSERSITE": "1", "PYTHONSAFEPATH": "1", "PYTHONDONTWRITEBYTECODE": "1"},
            "tools": tools, "discoveryTools": bootstrap, "pythonRuntime": python_runtime,
            "SDK": {"requestedPath": sdk, "path": str(sdk_real), "version": sdk_version,
                    "developerRequestedPath": developer, "developerPath": str(developer_real),
                    "settingsIdentity": settings_identity, "settings": settings}, "commands": commands}
