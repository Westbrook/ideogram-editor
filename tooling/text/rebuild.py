#!/usr/bin/env python3
"""Rebuild on macOS arm64 in a NEW caller-chosen local directory. No global setup."""
import hashlib
import json
import pathlib
import platform
import re
import subprocess
import sys
import tarfile
import urllib.request
import zipfile

assert sys.platform == 'darwin' and platform.machine() == 'arm64', 'This tool closure is macOS arm64 only'
recipe = pathlib.Path(__file__).resolve().parent
app = recipe.parent.parent
closure = json.loads((recipe / 'source-closure.json').read_text())
root = pathlib.Path(sys.argv[1]).resolve()
root.mkdir(parents=True, exist_ok=False)
downloads = root / 'downloads'
downloads.mkdir()
log = (root / 'build.txt').open('w')


def run(command, cwd=None):
    log.write(json.dumps([str(c) for c in command]) + '\n'); log.flush()
    subprocess.run([str(c) for c in command], cwd=cwd, stdout=log, stderr=subprocess.STDOUT, check=True)


def download(url, name, expected):
    path = downloads / name
    with urllib.request.urlopen(url, timeout=60) as source, path.open('wb') as target:
        while block := source.read(1024 * 1024):
            target.write(block)
    assert hashlib.sha256(path.read_bytes()).hexdigest() == expected, name
    return path


archive = download(closure['archive']['url'], 'skia.tar.gz', closure['archive']['sha256'])
with tarfile.open(archive) as source:
    source.extractall(root, filter='data')
skia = root / ('skia-' + closure['skiaCommit'])
deps = (skia / 'DEPS').read_text()
for dep in closure['deps']:
    url, revision = re.search(r'"third_party/externals/' + dep['name'] + r'"\s*:\s*"([^"@]+)@([a-f0-9]{40})"', deps).groups()
    assert revision == dep['revision']
    directory = skia / 'third_party/externals' / dep['name']
    directory.mkdir(parents=True, exist_ok=True)
    run(['git', 'init', directory])
    run(['git', '-C', directory, '-c', 'http.lowSpeedLimit=1024', '-c', 'http.lowSpeedTime=30', 'fetch', '--depth=1', url, revision])
    run(['git', '-C', directory, 'checkout', '--detach', revision])
    assert subprocess.check_output(['git', '-C', directory, 'rev-parse', 'HEAD^{tree}'], text=True).strip() == dep['tree']
for tool in closure['buildTools']:
    archive = download(tool['url'], tool['name'], tool['sha256'])
    name = tool['name'].replace('.zip', '')
    directory = skia / ('bin' if name == 'gn' else 'third_party/ninja')
    directory.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as zipped:
        zipped.extract(name, directory)
    (directory / name).chmod(0o755)
emsdk = skia / 'third_party/externals/emsdk'
run([sys.executable, emsdk / 'emsdk.py', 'install', '3.1.44'])
for item in closure['tools']['files']:
    if '/downloads/' in item['path']:
        path = emsdk / 'downloads' / pathlib.Path(item['path']).name
        assert hashlib.sha256(path.read_bytes()).hexdigest() == item['sha256'], str(path)
run([sys.executable, emsdk / 'emsdk.py', 'activate', '3.1.44'])
run([sys.executable, recipe / 'configure-source.py', skia], app)
run(['bash', 'modules/canvaskit/compile.sh', *closure['recipeArguments']], skia)
profile = json.loads((app / 'src/text/profile.json').read_text())
for part in ['js', 'wasm']:
    path = skia / f'out/canvaskit_wasm/canvaskit.{part}'
    actual = hashlib.sha256(path.read_bytes()).hexdigest()
    assert actual == profile['engine'][part]['sha256'], f'{part} output differs: {actual}'
print('Exact JS/WASM rebuild matches sealed artifacts. Log: ' + str(root / 'build.txt'))
