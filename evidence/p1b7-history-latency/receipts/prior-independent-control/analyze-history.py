"""Independent earliest-completed-state check for single-intent history actions only."""
import json, pathlib, sys
folder=pathlib.Path(sys.argv[1]); output=pathlib.Path(sys.argv[2])
events=sorted(json.loads((folder/'paint-trace.json').read_text())['traceEvents'],key=lambda e:e['ts'])
steps=json.loads((folder/'action-steps.json').read_text())['steps']
for e in events:
    detail=e.get('args',{}).get('detail');e['detail']=json.loads(detail) if isinstance(detail,str) else detail
rows=[]
for i,step in enumerate(steps):
    name=step['name']
    if name not in ['undo','redo','checkpoint'] and not name.startswith('opacity-'):continue
    start=next(e for e in events if e['name']=='ie.test.start.'+name)
    stop=next(e for e in events if e['name']=='ie.test.verified.'+name)
    group=[e for e in events if start['ts']<=e['ts']<=stop['ts'] and e['pid']==start['pid']]
    intents=[e for e in group if e['name'].startswith('ie.intent.')]
    complete=[e for e in group if e['name'].startswith('ie.complete.')]
    assert len(intents)==len(complete)==1,(name,len(intents),len(complete))
    intent=intents[0];revision=step['document'].split('revision ')[-1]
    correct=[e for e in group if e['name']=='ie.editor.updated' and e['detail']['revision']==revision]
    settled=[e for e in correct if not e['detail']['busy']]
    draws=[e for e in group if e['name']=='ie.canvas.drawn' and e['detail']['assetId']==step['asset']]
    changed=step['asset']!=steps[i-1]['asset']
    assert correct and settled and (not changed or draws),name
    required=[complete[0]['ts'],settled[0]['ts']]+([draws[0]['ts']] if changed else [])
    box=step['canvasBox']
    def covers(e):
        c=e.get('args',{}).get('clip',[])
        return len(c)==8 and min(c[::2])<=box['x'] and max(c[::2])>=box['x']+box['width'] and min(c[1::2])<=box['y'] and max(c[1::2])>=box['y']+box['height']
    paint=next(e for e in events if e['pid']==start['pid'] and e['name']=='Paint' and e['ts']>=max(required) and covers(e))
    assert paint['ts']<=stop['ts'],name
    ms=lambda t:round((t-intent['ts'])/1000,3)
    rows.append({'action':name,'intent':intent,'revision':revision,'asset':step['asset'],'assetChanged':changed,'firstCorrectRevisionMs':ms(correct[0]['ts']),'firstSettledRevisionMs':ms(settled[0]['ts']),'firstCompleteMs':ms(complete[0]['ts']),'matchingDrawMs':ms(draws[0]['ts']) if draws else None,'completedCoveringPaintMs':ms(paint['ts']+paint.get('dur',0)),'paint':paint,'canvasBox':box,'testAssertionMs':ms(stop['ts'])})
result={'source':str(folder),'boundary':'First native intent to first renderer Paint covering canvas after the earliest exact final revision, settled state, exact one action completion and new matching asset draw when required. Test assertion delay is not the stopping boundary. Only single-intent opacity/undo/redo/checkpoint are admitted. Software Paint, not GPU/physical presentation; no formal W1/H sample or workload claim.','actions':rows}
output.write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps([{k:r[k] for k in ['action','firstCorrectRevisionMs','firstSettledRevisionMs','firstCompleteMs','matchingDrawMs','completedCoveringPaintMs']} for r in rows],indent=2))
