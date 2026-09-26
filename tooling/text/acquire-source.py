#!/usr/bin/env python3
"""Acquire exact official DEPS in an isolated root; no system installation."""
import concurrent.futures
import datetime
import json
import pathlib
import re
import subprocess

ROOT = pathlib.Path('artifacts/p1c1/custom-source').resolve()
SKIA = ROOT / 'skia-5f262bd2cbb40f78659ec32547163fe83117a38d'
NAMES = ['emsdk', 'freetype', 'harfbuzz', 'zlib', 'wuffs', 'libpng']


def acquire(name):
    match = re.search(r'"third_party/externals/' + name + r'"\s*:\s*"([^"@]+)@([a-f0-9]{40})"', (SKIA / 'DEPS').read_text())
    url, revision = match.groups()
    path = SKIA / 'third_party/externals' / name
    path.mkdir(parents=True, exist_ok=True)
    result = {'name': name, 'url': url, 'revision': revision, 'commands': [],
              'at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    for command in [['git', 'init', str(path)],
                    ['git', '-C', str(path), '-c', 'http.lowSpeedLimit=1024', '-c', 'http.lowSpeedTime=30',
                     'fetch', '--depth=1', url, revision],
                    ['git', '-C', str(path), 'checkout', '--detach', revision]]:
        try:
            run = subprocess.run(command, capture_output=True, text=True, timeout=120)
            result['commands'].append({'command': command, 'exitCode': run.returncode,
                                       'stdout': run.stdout, 'stderr': run.stderr})
            if run.returncode:
                break
        except subprocess.TimeoutExpired as error:
            result['commands'].append({'command': command, 'error': repr(error),
                                       'stdout': str(error.stdout), 'stderr': str(error.stderr)})
            break
    return result


with concurrent.futures.ThreadPoolExecutor(4) as pool:
    results = list(pool.map(acquire, NAMES))
receipt = pathlib.Path('evidence/p1c1/custom-acquisition-03.json')
assert not receipt.exists(), 'Preserve earlier acquisition receipts'
receipt.write_text(json.dumps(results, indent=2) + '\n')
print(json.dumps(results, indent=2))
