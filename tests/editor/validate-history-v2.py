"""Offline retained-trace positive and mutation controls; never runs a browser."""
import copy
import datetime
import hashlib
import importlib.util
import json
import pathlib
import sys

analyzer_path = pathlib.Path(__file__).with_name('analyze-history-v2.py')
spec = importlib.util.spec_from_file_location('history_v2', analyzer_path)
analyzer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(analyzer)
bef, eb4, output = map(pathlib.Path, sys.argv[1:])
output.mkdir(parents=True, exist_ok=False)
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
load = lambda p: json.loads(p.read_text())
def run(folder):
    return analyzer.analyze(load(folder/'paint-trace.json')['traceEvents'], load(folder/'action-steps.json')['steps'])
rows = run(bef)
assert {r['action']: r['completedCoveringPaintMs'] for r in rows if r['action'] in ['undo','redo','checkpoint']} == {'undo':79.013,'redo':114.830,'checkpoint':101.224}
control = run(eb4/'full-action')
original = load(eb4/'history-analysis.json')['actions']
for expected, actual in zip(original, control, strict=True):
    for key in ['action','firstCorrectRevisionMs','firstSettledRevisionMs','firstCompleteMs','matchingDrawMs','completedCoveringPaintMs']:
        assert actual[key] == expected[key], (key, actual, expected)
redo = next(r for r in rows if r['action'] == 'redo')
source_events = load(bef/'paint-trace.json')['traceEvents']
start = next(e['ts'] for e in source_events if e['name'] == 'ie.test.start.redo')
stop = next(e['ts'] for e in source_events if e['name'] == 'ie.test.verified.redo')
end = redo['paint']['ts'] + redo['paint'].get('dur', 0)
base_events = [e for e in source_events if start <= e['ts'] <= redo['finiteBoundary']['ts']]
source_steps = load(bef/'action-steps.json')['steps']
i = next(i for i,s in enumerate(source_steps) if s['name']=='redo')
base_steps = [{'name':'predecessor-asset', 'asset':source_steps[i-1]['asset']}, source_steps[i]]
assert analyzer.analyze(base_events,base_steps)[0]['completedCoveringPaintMs'] == 114.830
cases=[]
def negative(name, mutate):
    events,steps=copy.deepcopy(base_events),copy.deepcopy(base_steps)
    mutate(events,steps)
    directory=output/name;directory.mkdir()
    for file,value in [('paint-trace.json',{'traceEvents':events}),('action-steps.json',{'steps':steps})]:
        (directory/file).write_text(json.dumps(value,indent=2)+'\n')
    try:
        analyzer.analyze(events,steps)
    except ValueError as error:
        reason=str(error)
    else:
        raise AssertionError(name+': invalid specimen was accepted')
    cases.append({'case':name,'result':'rejected as required','reason':reason,'inputs':{p.name:sha(p) for p in directory.iterdir()}})
def change_detail(events, field, value, kind='ie.canvas.drawn'):
    for e in events:
        if e['name']==kind:
            d=analyzer.detail(e);d[field]=value;e['args']['detail']=json.dumps(d)
def insert(events,kind,args):
    events.append({'name':kind,'ts':stop+1000,'pid':redo['intent']['pid'],'tid':redo['intent']['tid'],'args':args})
negative('missing-draw',lambda e,s:e.__setitem__(slice(None),[x for x in e if x['name']!='ie.canvas.drawn']))
negative('wrong-draw-document',lambda e,s:change_detail(e,'documentId','wrong-document'))
negative('wrong-draw-revision',lambda e,s:change_detail(e,'revision','999'))
negative('wrong-draw-asset',lambda e,s:change_detail(e,'assetId','wrong-asset'))
negative('wrong-state-document',lambda e,s:change_detail(e,'documentId','wrong-document','ie.editor.updated'))
negative('missing-completion',lambda e,s:e.__setitem__(slice(None),[x for x in e if x['name']!='ie.complete.Redo']))
negative('wrong-completion',lambda e,s:[x.update(name='ie.complete.Undo') for x in e if x['name']=='ie.complete.Redo'])
negative('draw-after-verified',lambda e,s:[x.update(ts=stop+1) for x in e if x['name']=='ie.canvas.drawn'])
negative('missing-expected-document',lambda e,s:[m['detail'].pop('documentId',None) for m in s[-1]['marks'] if m['name']=='ie.editor.updated'])
negative('native-interference',lambda e,s:insert(e,'EventDispatch',{'type':'pointerdown'}))
negative('unknown-tooling-dispatch',lambda e,s:insert(e,'EventDispatch',{'type':'__playwright_unknown__'}))
negative('unknown-app-signal',lambda e,s:insert(e,'ie.unrecognized',{}))
negative('state-supersession',lambda e,s:insert(e,'ie.editor.updated',{'detail':json.dumps({'documentId':redo['documentId'],'revision':'999','busy':False,'ready':True})}))
negative('asset-supersession',lambda e,s:insert(e,'ie.canvas.drawn',{'detail':json.dumps({'documentId':redo['documentId'],'revision':redo['revision'],'assetId':'wrong-asset'})}))
negative('error-interference',lambda e,s:insert(e,'EventDispatch',{'type':'error'}))
negative('navigation-interference',lambda e,s:insert(e,'navigationStart',{}))
negative('no-finite-bound',lambda e,s:e.__setitem__(slice(None),[x for x in e if x['ts']<=end]))
negative('insufficient-bound',lambda e,s:e.append({'name':'EventDispatch','ts':end,'pid':redo['intent']['pid'],'args':{'type':'keydown'}}))
receipt={'retrospective':True,'argv':sys.argv,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'analyzerSha256':sha(analyzer_path),'validatorSha256':sha(pathlib.Path(__file__)),'sourceInputs':{str(p):sha(p) for folder in [bef,eb4/'full-action'] for p in [folder/'paint-trace.json',folder/'action-steps.json']},'positiveControls':{'bef':{r['action']:r['completedCoveringPaintMs'] for r in rows},'eb4':'all eight actions match original analysis exactly'},'negativeControls':cases}
(output/'validation.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({'positiveControls':receipt['positiveControls'],'rejectedNegativeControls':len(cases),'receipt':str(output/'validation.json')},indent=2))
