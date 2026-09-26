import sys,os,json,subprocess,datetime,pathlib
root=pathlib.Path(__file__).resolve().parent
label=sys.argv[1];argv=sys.argv[2:]
record={"label":label,"argv":argv,"cwd":os.getcwd(),"started":datetime.datetime.now(datetime.timezone.utc).isoformat(),"head":subprocess.check_output(["git","rev-parse","HEAD"],text=True).strip(),"environment":{k:os.environ[k] for k in ["EDITOR_RECEIPT","EDITOR_BROWSER"] if k in os.environ}}
with (root/(label+".log")).open("w") as log:
 result=subprocess.run(argv,stdout=log,stderr=subprocess.STDOUT)
record.update(ended=datetime.datetime.now(datetime.timezone.utc).isoformat(),exit=result.returncode)
with (root/"commands.jsonl").open("a") as log:log.write(json.dumps(record)+"\n")
print(json.dumps(record));print((root/(label+".log")).read_text()[-5000:]);sys.exit(result.returncode)
