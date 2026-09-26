#!/usr/bin/env python3
"""Install the pinned public toolchain into ignored, project-owned storage."""
import base64
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
config = json.loads((ROOT / 'tooling/toolchain.json').read_text())
arch = {'aarch64': 'arm64', 'arm64': 'arm64', 'x86_64': 'x64'}.get(platform.machine())
target = f'{platform.system().lower()}-{arch}'
archive = config['nodeArchives'][target]
cache = ROOT / '.toolchain'
cache.mkdir(exist_ok=True)

def download(url, path, algorithm, expected):
    if not path.exists():
        temporary = path.with_suffix('.download')
        with urllib.request.urlopen(url, timeout=60) as response, temporary.open('wb') as output:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
        temporary.rename(path)
    digest = hashlib.new(algorithm, path.read_bytes()).digest()
    actual = digest.hex() if algorithm == 'sha256' else base64.b64encode(digest).decode()
    if actual != expected:
        raise SystemExit(f'Checksum mismatch: {path}; remove it and retry from the official source')

node_archive = cache / archive['filename']
download(f"https://nodejs.org/dist/v{config['node']}/{archive['filename']}", node_archive,
         'sha256', archive['sha256'])
node_root = cache / f"node-v{config['node']}-{target}"
if not node_root.exists():
    with tarfile.open(node_archive) as source:
        source.extractall(cache, filter='data')
npm_archive = cache / f"npm-{config['npm']}.tgz"
download(config['npmArchive']['url'], npm_archive, 'sha512',
         config['npmArchive']['integrity'].removeprefix('sha512-'))
npm_root = cache / f"npm-{config['npm']}"
if not npm_root.exists():
    npm_root.mkdir()
    with tarfile.open(npm_archive) as source:
        source.extractall(npm_root, filter='data')
bin_dir = cache / 'bin'
bin_dir.mkdir(exist_ok=True)
for name, source in [('node', node_root / 'bin/node'),
                     ('npm', npm_root / 'package/bin/npm-cli.js'),
                     ('npx', npm_root / 'package/bin/npx-cli.js')]:
    destination = bin_dir / name
    destination.unlink(missing_ok=True)
    destination.symlink_to(os.path.relpath(source, bin_dir))
env = {**os.environ, 'PATH': f"{bin_dir}{os.pathsep}{os.environ['PATH']}"}
for name, expected in [('node', f"v{config['node']}"), ('npm', config['npm'])]:
    actual = subprocess.check_output([str(bin_dir / name), '--version'], env=env, text=True).strip()
    if actual != expected:
        raise SystemExit(f'{name}: expected {expected}, got {actual}')
print(f"Toolchain verified: Node {config['node']}, npm {config['npm']} ({target})")
print('Use: PATH="$PWD/.toolchain/bin:$PATH" npm ci')
