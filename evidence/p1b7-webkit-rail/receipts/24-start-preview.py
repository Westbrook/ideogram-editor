from pathlib import Path
import json,shutil,os,subprocess
repo=Path('/Users/westbrook/Documents/repos/ideogram-edit');out=Path(__file__).resolve().parent;service=repo.parent/'ideogram-edit-webkit-rail-preview-ccdfab3b'
service.mkdir(mode=0o700)
shutil.copytree(out/'07-build-frozen/dist',service/'dist')
source=json.loads((out/'20-final-source/CODE-INPUTS.json').read_text());source['sourceCommit']=subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip();source['build']=json.loads((out/'07-build-frozen/files.json').read_text());(service/'source.json').write_text(json.dumps(source,indent=2)+'\n');(service/'package.json').write_text('{"type":"module"}\n');(service/'node_modules').symlink_to(repo/'node_modules',target_is_directory=True)
private=repo/'artifacts/webkit-rail-private';private.mkdir(mode=0o700,parents=True,exist_ok=True)
s=(repo.parent/'ideogram-edit-i-br01-preview-1c899cca/run.mjs').read_text().replace('artifacts/i-br01-private-preview-2/pairing.json','artifacts/webkit-rail-private/pairing.json');(service/'run.mjs').write_text(s)
os.mkfifo(service/'control',0o600);fd=os.open(service/'control',os.O_RDWR)
with (service/'service.log').open('wb') as log:
 process=subprocess.Popen([str(repo/'.toolchain/bin/node'),'--import',str(repo/'tests/protocol/no-effects.mjs'),str(service/'run.mjs')],cwd=service,stdin=fd,stdout=log,stderr=log,start_new_session=True)
os.close(fd);(out/'24-preview-start.json').write_text(json.dumps({'pid':process.pid,'service':str(service),'sourceCommit':source['sourceCommit'],'runtimeSourceSHA256':source['runtimeSourceSHA256']},indent=2));print(json.dumps({'pid':process.pid,'service':str(service),'sourceCommit':source['sourceCommit']}))
