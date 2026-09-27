from pathlib import Path
import json,shutil,hashlib,datetime,subprocess
packet=Path(__file__).resolve().parent
repo=packet.parent/'ideogram-edit'
target=repo/'evidence/p1c3-input-authority'
assert not target.exists()
target.mkdir()
rootFiles=['gate.py','suite-plan.json','browser-plan.json','browser-resume-plan.json','run-browser.py','native-output-correction.json','helper-origins.json','independent-late-baseline-v1.mjs','review-fixture-v2.mjs','independent-mask-authority-v1.mjs','author-retained-grid-combined-v1.mjs','start-preview.py','author-preview-v1.mjs','preview-helper-origin.json','source-inputs.json','build-files.json','reuse.json','native-inputs.json','public-adoption.json','source-whitespace.json','source-whitespace.txt','preservation.json','report-preservation-before.json','report-preservation-first-failure.json','report-preservation-after.json','REPRODUCE.txt','ADMINISTRATIVE.txt','card.json','FINAL.json','FIRST_FAILURES.txt','source-build-integrity.json','gates-and-reuse.json','browser-cleanup-summary.json','visual-inspection.json','collect-evidence.py']
for name in rootFiles:shutil.copyfile(packet/name,target/name)
for name in ['gates','sealed-build','current-native-complete','authoring-chromium','authoring-firefox','authoring-webkit','preview-service','author-preview-v1']:
 shutil.copytree(packet/name,target/name)
for name in ['independent-late-baseline-v1','independent-mask-authority-v1','author-retained-grid-combined-v1']:
 (target/name).mkdir()
 for p in (packet/name).glob('*.json'):shutil.copyfile(p,target/name/p.name)
assert not any(p.is_symlink() for p in target.rglob('*'))
files={p.relative_to(target).as_posix():{'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(target.rglob('*')) if p.is_file()}
manifest={'sealedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceCommit':'1888c6a04d43b1991b539ddd60511b7619036cf6','scope':'Exact declared AUTHOR evidence only; self FILES.json excluded. Private root stores, pairing tokens, npm cache, installed dependencies and unused helper copies excluded. Full final evidence commit is bound in task/PR notes.','files':files}
(target/'FILES.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'root':str(target),'files':len(files),'bytes':sum(x['bytes'] for x in files.values()),'manifestBytes':(target/'FILES.json').stat().st_size,'manifestSHA256':hashlib.sha256((target/'FILES.json').read_bytes()).hexdigest()}))
