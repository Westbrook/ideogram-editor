"""Conservative renderer-Paint observations; never a physical-display qualification."""
import json, pathlib, sys

folder = pathlib.Path(sys.argv[1])
trace = sorted(json.loads((folder / 'paint-trace.json').read_text())['traceEvents'], key=lambda e: e['ts'])
run = json.loads((folder / 'action-steps.json').read_text())
for event in trace:
    detail = event.get('args', {}).get('detail')
    event['detail'] = json.loads(detail) if isinstance(detail, str) else detail
marks = [e for e in trace if e['name'].startswith('ie.')]
paints = [e for e in trace if e['name'] == 'Paint']

def first_paint(at, pid):
    return next((e for e in paints if e['ts'] >= at and e['pid'] == pid), None)

def elapsed(start, paint):
    return round((paint['ts'] + paint.get('dur', 0) - start) / 1000, 3) if paint else None

actions = []
for step in run['steps']:
    start = next(e for e in marks if e['name'] == 'ie.test.start.' + step['name'])
    verified = next(e for e in marks if e['name'] == 'ie.test.verified.' + step['name'])
    group = [e for e in marks if start['ts'] <= e['ts'] <= verified['ts'] and e['pid'] == start['pid']]
    intents = [e for e in group if e['name'].startswith('ie.intent.')]
    complete = [e for e in group if e['name'].startswith('ie.complete.')]
    draws = [e for e in group if e['name'] == 'ie.canvas.drawn' and e['detail'].get('assetId') == step['asset']]
    revision = step['document'].split('revision ')[-1]
    correct = [e for e in group if e['name'] == 'ie.editor.updated' and e['detail'].get('revision') == revision and not e['detail']['busy']]
    viewport = [e for e in group if e['name'] == 'ie.viewport.drawn'] if step['name'] == 'zoom' else []
    bound = max([start['ts']] + [e['ts'] for e in complete + draws + correct + viewport])
    paint = first_paint(bound, start['pid'])
    actions.append({'action': step['name'], 'testIntentToPaintMs': elapsed(start['ts'], paint),
                    'firstNativeIntentToPaintMs': elapsed(intents[0]['ts'], paint) if intents else None,
                    'lastNativeIntentToPaintMs': elapsed(intents[-1]['ts'], paint) if intents else None,
                    'lastIntent': intents[-1]['name'] if intents else None,
                    'correctAsset': step['asset'], 'revision': revision, 'newCorrectCanvasDraw': bool(draws),
                    'canvasBackendNodeId': step['canvasBackendNodeId'], 'paint': paint,
                    'boundary': 'First renderer Paint after exact accepted completion, matching revision update and new matching canvas draw when content changes; unchanged content retains its verified asset. Includes automated review dwell and all preparatory work in the first-intent parent.'})

feedback, pan = [], []
for intent in (e for e in marks if e['name'].startswith('ie.intent.')):
    if intent['name'] == 'ie.intent.Pan':
        draw = next((e for e in marks if e['name'] == 'ie.viewport.drawn' and e['pid'] == intent['pid'] and e['ts'] >= intent['ts']), None)
        paint = first_paint(draw['ts'], intent['pid']) if draw else None
        pan.append({'inputToCanvasDrawMs': round((draw['ts']-intent['ts'])/1000, 3) if draw else None,
                    'inputToNextRendererPaintMs': elapsed(intent['ts'], paint)})
        continue
    update = next((e for e in marks if e['name'] == 'ie.editor.updated' and e['pid'] == intent['pid'] and e['ts'] >= intent['ts']), None)
    paint = first_paint(update['ts'], intent['pid']) if update else None
    feedback.append({'action': intent['name'], 'inputToNextStatusPaintMs': elapsed(intent['ts'], paint)})

startup = []
for marker in ['ie.test.cold.ready', 'ie.test.warm.ready', 'ie.test.warm.test-edit']:
    ready = next((e for e in marks if e['name'] == marker), None)
    if not ready:
        startup.append({'marker': marker, 'qualified': False, 'reason': 'Missing: attempt did not reach this checkpoint'})
        continue
    nav = [e for e in trace if e['name'] == 'navigationStart' and e['pid'] == ready['pid'] and e['ts'] <= ready['ts']][-1]
    # This intentionally includes the browser assertion/orchestration delay;
    # it cannot make readiness appear faster than the observed completion.
    startup.append({'marker': marker, 'navigationToSubsequentPaintUpperBoundMs': elapsed(nav['ts'], first_paint(ready['ts'], ready['pid']))})

result = {'actions': actions, 'feedback': feedback, 'pan': pan, 'startup': startup,
          'serverProcessRSSPeakMiB': max(e['rss'] for e in run['resources']) / 2**20,
          'receiptObservations': run['receipts'],
          'limits': ['Tiny author fixture, single run per source; no formal W0/W1/W2, p95 population, native, GPU/display, power-loss or exclusive-host qualification.',
                     'Renderer Paint is a conservative software paint boundary. GPU canvas updates can present without a new Paint event; per-pan presented-frame latency and drop rate are NOT established.',
                     'No child clock substitutes for an action parent. HTTP request-to-observed-receipt includes preparation and queue; it is NOT the commit-ready R20 boundary.',
                     'R08 forced fallback/cooperative slice attribution and complete browser+server+native-child RSS are NOT qualified by this trace. Server-process RSS alone is partial.',
                     'Download initiated and Playwright saveAs remain separate observations; external destination is unconfirmed. Actual destination writable close is a separate functional check.',
                     'Startup readiness markers are conservative upper bounds after assertions, not a complete formal startup decomposition. The accepted warm edit is required and missing in failed63.']}
output = folder / 'paint-analysis.json'
output.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'file': str(output), 'actions': [{'name': a['action'], 'nativeParentMs': a['firstNativeIntentToPaintMs'], 'lastIntentMs': a['lastNativeIntentToPaintMs']} for a in actions], 'feedbackMaxMs': max(x['inputToNextStatusPaintMs'] or 0 for x in feedback), 'startup': startup, 'serverRSSMiB': result['serverProcessRSSPeakMiB']}, indent=2))
