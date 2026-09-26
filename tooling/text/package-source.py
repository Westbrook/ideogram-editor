#!/usr/bin/env python3
"""Package the local build deterministically; preserve prior runtime archives."""
import gzip
import hashlib
import json
import pathlib
import shutil
import sys
import tarfile

version = sys.argv[1]
root = pathlib.Path('artifacts/p1c1/custom-source/skia-5f262bd2cbb40f78659ec32547163fe83117a38d')
package = pathlib.Path('artifacts/p1c1/custom-package/package')
archive = pathlib.Path('vendor/text/canvaskit-wasm-' + version + '.tgz')
assert not archive.exists(), 'Use a new version; preserve prior evidence'
for part in ['js', 'wasm']:
    shutil.copyfile(root / f'out/canvaskit_wasm/canvaskit.{part}', package / f'bin/canvaskit.{part}')
metadata = json.loads((package / 'package.json').read_text())
metadata['version'] = version
(package / 'package.json').write_text(json.dumps(metadata, indent=2) + '\n')
with archive.open('wb') as raw:
    with gzip.GzipFile(fileobj=raw, mode='wb', mtime=0, filename='') as zipped:
        with tarfile.open(fileobj=zipped, mode='w') as tar:
            for path in sorted(package.rglob('*')):
                if not path.is_file():
                    continue
                info = tar.gettarinfo(str(path), arcname='package/' + str(path.relative_to(package)))
                info.uid = info.gid = info.mtime = 0
                info.uname = info.gname = ''
                with path.open('rb') as data:
                    tar.addfile(info, data)
profile = json.loads(pathlib.Path('src/text/profile.json').read_text())
profile['engine']['version'] = version
profile['engine']['sourceAttribution'] = 'Locally built official source archive and exact DEPS; explicit source patch and pinned tools'
for part, path in [('js', package / 'bin/canvaskit.js'), ('wasm', package / 'bin/canvaskit.wasm'), ('tarball', archive)]:
    data = path.read_bytes()
    profile['engine'][part] = {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
                               'gzipBytes': len(gzip.compress(data, mtime=0))}
pathlib.Path('src/text/profile.json').write_text(json.dumps(profile, indent=2) + '\n')
application = json.loads(pathlib.Path('package.json').read_text())
application['dependencies']['canvaskit-wasm'] = 'file:' + str(archive)
pathlib.Path('package.json').write_text(json.dumps(application, indent=2) + '\n')
print(json.dumps(profile['engine'], indent=2))
