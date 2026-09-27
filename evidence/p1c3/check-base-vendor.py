import hashlib,json,pathlib,subprocess,tempfile
base='4b2c82ccc41dd72c3f83480f23481b7b62135d23'
root=pathlib.Path(tempfile.mkdtemp(prefix='p1c3-base-vendor-'))
paths=['tooling/verify-vendor.py','tooling/toolchain.json','package.json','package-lock.json','vendor/en-reve']
archive=subprocess.check_output(['git','archive',base,*paths])
subprocess.run(['tar','-xf','-','-C',str(root)],input=archive,check=True)
r=subprocess.run(['python3',str(root/'tooling/verify-vendor.py'),str(root)],text=True,capture_output=True)
print(json.dumps({'base':base,'root':str(root),'paths':paths,'archiveSHA256':hashlib.sha256(archive).hexdigest(),'exitCode':r.returncode,'stdout':r.stdout,'stderr':r.stderr},indent=2))
assert r.returncode==1 and 'Nonregistry third-party dependency: node_modules/canvaskit-wasm file:vendor/text/canvaskit-wasm-0.40.0-ideogram.3.tgz' in r.stderr
print('Confirmed identical failure on actual accepted base; vendor gate is NOT passed.')
