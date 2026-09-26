"""Verify this additive evidence package from a checkout or git archive, offline."""
import hashlib
import json
from pathlib import Path

bundle = Path(__file__).resolve().parent
checkout = bundle.parent.parent
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
load = lambda name: json.loads((bundle / name).read_text())
sealed = {}
for line in (bundle / 'SHA256SUMS').read_text().splitlines():
    digest, name = line.split('  ', 1)
    assert name not in sealed and not Path(name).is_absolute() and '..' not in Path(name).parts
    assert sha(bundle / name) == digest, name
    sealed[name] = digest
actual = {p.relative_to(bundle).as_posix() for p in bundle.rglob('*') if p.is_file() and p.name != 'SHA256SUMS' and '__pycache__' not in p.parts}
assert actual == set(sealed), ('unsealed/missing', actual ^ set(sealed))
code = load('CODE-INPUTS.json')
for group in ['runtimeSource', 'verificationCode']:
    for path, digest in code[group].items():
        assert sha(checkout / path) == digest, (group, path)
assert all(not p.endswith('browser.json') for p in code['verificationCode'])
assert hashlib.sha256(json.dumps(code['runtimeSource'], sort_keys=True, separators=(',', ':')).encode()).hexdigest() == code['runtimeSourceSHA256']
for manifest in ['OBSERVATION-MAPPING.json', 'BUILD-MAPPING.json']:
    for entry in load(manifest)['entries']:
        assert sealed[entry['packagePath']] == entry['sha256'], (manifest, entry)
control = bundle / 'receipts/prior-independent-control'
old_seal = dict((line.split('  ', 1)[1], line.split('  ', 1)[0]) for line in (control/'SHA256SUMS').read_text().splitlines())
for name in ['analyze-history.py', 'history-analysis.json', 'VERDICT.txt', 'full-action/paint-trace.json', 'full-action/action-steps.json']:
    assert sha(control/name) == old_seal[name], name
for label, output in [('22-full-action', '34-history-v2-bef.json'), ('75-full-action', '77-history-v2.json')]:
    analysis = load('receipts/' + output)
    for name, digest in analysis['inputSha256'].items():
        assert sha(bundle/'receipts'/label/name) == digest, (label, name)
    assert analysis['analyzerSha256'] == code['verificationCode']['tests/editor/analyze-history-v2.py']
print(json.dumps({'sealedFiles':len(sealed), 'runtimeInputs':len(code['runtimeSource']), 'verificationCodeInputs':len(code['verificationCode']), 'observationsAndCopies':len(load('OBSERVATION-MAPPING.json')['entries']), 'buildCopies':len(load('BUILD-MAPPING.json')['entries']), 'runtimeSourceSHA256':code['runtimeSourceSHA256'], 'result':'AUTHOR offline integrity PASS; not independent acceptance'}, indent=2))
