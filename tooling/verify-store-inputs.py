"""Verify native sources and the headers actually used by node-gyp against official archives."""
import base64
import hashlib
import io
import json
from datetime import datetime, timezone
from pathlib import Path
import tarfile
from urllib.request import urlopen

lock = json.loads(Path('package-lock.json').read_text())
toolchain = json.loads(Path('tooling/toolchain.json').read_text())
result = {'checkedAt': datetime.now(timezone.utc).isoformat(), 'packages': {}}


def download(url):
    with urlopen(url, timeout=30) as response:
        return response.read()


def compare(archive, prefix, installed):
    rows = []
    with tarfile.open(fileobj=io.BytesIO(archive)) as source:
        for member in source.getmembers():
            if not member.isfile() or not member.name.startswith(prefix):
                continue
            relative = member.name[len(prefix):]
            if not relative or '..' in Path(relative).parts or Path(relative).is_absolute():
                raise ValueError('Unexpected source path')
            data = source.extractfile(member).read()
            if (installed / relative).read_bytes() != data:
                raise ValueError(f'Installed source differs: {relative}')
            rows.append({'path': relative, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    return rows


for name in ['fs-ext', 'nan']:
    entry = lock['packages']['node_modules/' + name]
    archive = download(entry['resolved'])
    integrity = 'sha512-' + base64.b64encode(hashlib.sha512(archive).digest()).decode()
    if integrity != entry['integrity']:
        raise ValueError('Package archive integrity mismatch')
    rows = compare(archive, 'package/', Path('node_modules') / name)
    result['packages'][name] = {'version': entry['version'], 'url': entry['resolved'], 'integrity': integrity,
                                'archiveSHA256': hashlib.sha256(archive).hexdigest(), 'files': rows, 'matched': len(rows)}

version = toolchain['node']
base = f'https://nodejs.org/download/release/v{version}/'
filename = f'node-v{version}-headers.tar.gz'
checksums = download(base + 'SHASUMS256.txt').decode()
expected = next(line.split()[0] for line in checksums.splitlines() if line.endswith('  ' + filename))
archive = download(base + filename)
if hashlib.sha256(archive).hexdigest() != expected:
    raise ValueError('Node headers archive checksum mismatch')
config = json.loads(''.join(line for line in Path('node_modules/fs-ext/build/config.gypi').read_text().splitlines(True)
                            if not line.lstrip().startswith('#')))
headers = Path(config['variables']['nodedir']) / 'include/node'
rows = compare(archive, f'node-v{version}/include/node/', headers)
result['nodeHeaders'] = {'sourceURL': base + filename, 'archiveSHA256': expected, 'matched': len(rows),
                         'manifestSHA256': hashlib.sha256(json.dumps(rows, sort_keys=True).encode()).hexdigest(),
                         'comparison': 'Exact node-gyp input directory against official generic headers archive'}
Path('artifacts').mkdir(exist_ok=True)
Path('artifacts/store-source-provenance.json').write_text(json.dumps(result, indent=2) + '\n')
print('Verified fs-ext/nan installed source and', len(rows), 'Node header files; artifacts/store-source-provenance.json')
