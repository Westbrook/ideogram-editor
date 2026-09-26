"""Verify the additive provenance package without ignored original observations."""
import argparse
import hashlib
import json
import pathlib
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--git', action='store_true', help='Also compare with HEAD blobs and restrict the successor delta')
args = parser.parse_args()
root = pathlib.Path(__file__).resolve().parents[2]
addition = pathlib.Path('evidence/p1b7-provenance')
original = pathlib.Path('evidence/p1b7')
checked = {}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read(relative):
    path = pathlib.Path(relative)
    assert not path.is_absolute() and '..' not in path.parts, 'Path escapes repository'
    data = (root / path).read_bytes()
    key = path.as_posix()
    if args.git and key not in checked:
        blob = subprocess.check_output(['git', 'show', 'HEAD:' + key], cwd=root)
        assert blob == data, 'Disk/Git mismatch: ' + key
    checked[key] = digest(data)
    return data


def document(relative):
    return json.loads(read(relative))


def seals(directory):
    result = {}
    for line in read(directory / 'SHA256SUMS').decode().splitlines():
        expected, name = line.split('  ', 1)
        assert name not in result, 'Duplicate seal: ' + name
        assert digest(read(directory / name)) == expected, 'Seal mismatch: ' + name
        result[name] = expected
    return result


old_seals = seals(original)
new_seals = seals(addition)
assert len(old_seals) == 368
provenance = document(addition / 'provenance.json')
assert digest(read(original / 'SHA256SUMS')) == provenance['preservedEvidenceManifestSHA256']
assert digest(read(original / 'HANDOFF.txt')) == provenance['preservedHandoffSHA256']
assert digest(read(original / 'test-source.json')) == provenance['preservedMixedManifestSHA256']
legacy = document(original / 'test-source.json')
code = document(addition / 'verification-code.json')['files']
observations = document(addition / 'browser-observations.json')['observations']
assert len(legacy) == 62 and len(code) == 14 and len(observations) == 48
accounted = {}
for path, expected in code.items():
    assert '/artifacts/' not in path and legacy[path] == expected
    assert digest(read(path)) == expected, 'Verification input changed: ' + path
    accounted[path] = expected
attachment_count = 0
for observation in observations:
    path = observation['originalManifestPath']
    assert path not in accounted and '/artifacts/' in path
    assert legacy[path] == observation['originalManifestSHA256']
    target = pathlib.Path(observation['committedPath'])
    assert target.is_relative_to(addition / 'observations')
    copy = read(target)
    assert digest(copy) == observation['committedSHA256'] == legacy[path]
    assert new_seals[str(target.relative_to(addition))] == legacy[path]
    assert len(copy) == observation['originalBytes']
    assert json.loads(copy)['stats'] == observation['stats']
    for attachment in observation['attachments']:
        committed = pathlib.Path(attachment['committedPath'])
        assert committed.is_relative_to(original)
        expected = attachment['committedSHA256']
        assert old_seals[str(committed.relative_to(original))] == expected
        assert digest(read(committed)) == expected
        attachment_count += 1
    accounted[path] = legacy[path]
assert accounted == legacy and attachment_count == 76
assert sum(x['originalBytes'] for x in observations) == 627679
if args.git:
    changes = subprocess.check_output(
        ['git', 'diff', '--name-only', provenance['preservedCommit'], 'HEAD'], cwd=root, text=True
    ).splitlines()
    assert changes and all(p.startswith(str(addition) + '/') for p in changes), 'Non-addendum successor change'
    assert subprocess.check_output(['git', 'diff', '--name-only', 'HEAD'], cwd=root, text=True) == '', 'Tracked worktree changes'
print(json.dumps({'status': 'PASS', 'preservedSeals': len(old_seals), 'addendumSeals': len(new_seals),
                  'codeInputs': len(code), 'byteIdenticalObservations': len(observations),
                  'attachmentMappings': attachment_count, 'gitBytesChecked': args.git,
                  'requiresIgnoredOriginals': False, 'appTestsBuildsTimingRun': False}))
