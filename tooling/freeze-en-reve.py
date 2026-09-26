#!/usr/bin/env python3
"""Read-only source capture. No live dist, dependencies, results, or credentials."""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
from datetime import datetime, timezone

ROOTS = ['packages', 'apps', 'tooling', 'plans', 'probes']
ROOT_FILES = ['package.json', 'package-lock.json', 'tsconfig.base.json', 'LICENSE',
              'README.md', '.gitignore', '.editorconfig', '.node-version', '.nvmrc', '.python-version']
EXCLUDED = {'node_modules', 'dist', 'results', 'test-results', 'playwright-report', '.vite',
            '.toolchains', '.progress-report', 'artifacts'}

def sha(data):
    return hashlib.sha256(data).hexdigest()

def git(source, *args):
    return subprocess.check_output(['git', '-C', str(source), *args])

def capture(source):
    names = git(source, 'ls-files', '--cached', '--others', '--exclude-standard', '-z',
                '--', *ROOTS, *ROOT_FILES).decode().split('\0')
    records, contents = [], {}
    for name in sorted(set(filter(None, names))):
        path = Path(name)
        if EXCLUDED.intersection(path.parts) or name.endswith('.tsbuildinfo'):
            continue
        if path.is_absolute() or '..' in path.parts:
            raise ValueError(f'Unsafe source path: {name}')
        location = source / name
        if location.is_symlink():
            raise ValueError(f'Source symlink rejected: {name}')
        if not location.exists():
            continue  # Tracked deletion is recorded by status and patch.
        data = location.read_bytes()
        mode = 0o755 if location.stat().st_mode & 0o111 else 0o644
        records.append({'path': name, 'bytes': len(data), 'sha256': sha(data), 'mode': mode})
        contents[name] = data
    return records, contents

def identity(records):
    return sha(json.dumps(records, separators=(',', ':'), ensure_ascii=False).encode())

def freeze(source, destination):
    started = datetime.now(timezone.utc).isoformat()
    head = git(source, 'rev-parse', 'HEAD').decode().strip()
    status = git(source, 'status', '--porcelain=v1', '-z', '--', *ROOTS, *ROOT_FILES)
    patch = git(source, 'diff', '--binary', 'HEAD', '--', *ROOTS, *ROOT_FILES)
    records, contents = capture(source)
    again, _ = capture(source)
    if records != again or head != git(source, 'rev-parse', 'HEAD').decode().strip() or status != git(source, 'status', '--porcelain=v1', '-z', '--', *ROOTS, *ROOT_FILES) or patch != git(source, 'diff', '--binary', 'HEAD', '--', *ROOTS, *ROOT_FILES):
        raise RuntimeError('Concurrent source drift: capture rejected; retry with stable inputs')
    digest = identity(records)
    target = destination / digest
    if target.exists():
        raise FileExistsError(f'Immutable snapshot already exists: {target}')
    destination.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=destination, prefix='.capture-') as temporary:
        staging = Path(temporary)
        archive = staging / 'source.tar.gz'
        with archive.open('wb') as output, gzip.GzipFile(fileobj=output, mode='wb', mtime=0, filename='') as compressed, tarfile.open(fileobj=compressed, mode='w') as tar:
            for entry in records:
                info = tarfile.TarInfo(entry['path'])
                info.size = entry['bytes']
                info.mode = entry['mode']
                info.mtime = 0
                tar.addfile(info, io.BytesIO(contents[entry['path']]))
        (staging / 'source.patch').write_bytes(patch)
        (staging / 'source-status.z').write_bytes(status)
        manifest = {'schema': 1, 'sourceIdentity': digest, 'head': head,
                    'captureStarted': started, 'captureFinished': datetime.now(timezone.utc).isoformat(),
                    'selection': {'roots': ROOTS, 'rootFiles': ROOT_FILES, 'excludedSegments': sorted(EXCLUDED),
                                  'policy': 'Complete package/build/test source graph plus plans; tracked and nonignored new files. Unrelated showcases, generated evidence, caches and credentials excluded.'},
                    'files': records, 'sourceArchive': {'path': archive.name, 'bytes': archive.stat().st_size, 'sha256': sha(archive.read_bytes())},
                    'provenance': {name: {'bytes': (staging / name).stat().st_size, 'sha256': sha((staging / name).read_bytes())} for name in ['source.patch', 'source-status.z']}}
        (staging / 'source-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        staging.rename(target)
    print(target)

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path)
    parser.add_argument('--destination', type=Path, default=Path('artifacts/en-reve-freezes'))
    parser.add_argument('--check', type=Path, help='Check live source against this existing manifest without writing')
    args = parser.parse_args()
    if args.check:
        manifest = json.loads(args.check.read_text())
        records, _ = capture(args.source)
        if records != manifest['files'] or git(args.source, 'rev-parse', 'HEAD').decode().strip() != manifest['head']:
            raise SystemExit('Concurrent source drift: producer result rejected')
        print(f"Live source still matches {identity(records)}")
    else:
        freeze(args.source.resolve(), args.destination.resolve())
