"""Version 2: bounded retrospective history Paint analysis; no live observer changes.

The original independent analyzer is retained externally, unchanged. This version
allows the first correct covering Paint to follow DOM verification only when all
original prerequisites precede verification and an explicit later interference
boundary limits the search. It fails closed rather than inferring a trace end.
"""
import hashlib
import json
import math
import pathlib
import sys

LABELS = {'undo': 'Undo', 'redo': 'Redo', 'checkpoint': 'Save checkpoint'}
PASSIVE = {'Paint', 'RunTask', 'FunctionCall', 'Layout', 'UpdateLayoutTree',
           'DrawFrame', 'Commit', 'CompositeLayers'}

# Pinned Playwright diagnostic bookkeeping only; all other native dispatches
# remain boundaries (including unknown event types). Source attribution is
# retained alongside the retrospective validation receipt.
TOOLING_DISPATCH = {'__playwright_reset_targets__', '__playwright_mark_target__'}

def passive(event):
    return event['name'] in PASSIVE or (event['name'] == 'EventDispatch'
        and event.get('args', {}).get('type') in TOOLING_DISPATCH)

def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def detail(event):
    value = event.get('args', {}).get('detail')
    return json.loads(value) if isinstance(value, str) else value or {}


def analyze(trace, steps):
    events = sorted(trace, key=lambda event: event['ts'])
    rows = []
    for index, step in enumerate(steps):
        name = step['name']
        if name not in LABELS and not name.startswith('opacity-'):
            continue
        label = LABELS.get(name, 'Apply properties')
        def only(marker):
            found = [e for e in events if e['name'] == marker]
            require(len(found) == 1, name + ': missing/duplicate ' + marker)
            return found[0]
        start = only('ie.test.start.' + name)
        stop = only('ie.test.verified.' + name)
        require(start['pid'] == stop['pid'] and start['ts'] < stop['ts'], name + ': marker order/process')
        group = [e for e in events if start['ts'] <= e['ts'] <= stop['ts'] and e['pid'] == start['pid']]
        intents = [e for e in group if e['name'].startswith('ie.intent.')]
        complete = [e for e in group if e['name'].startswith('ie.complete.')]
        require(len(intents) == len(complete) == 1, name + ': expected one intent/completion')
        intent = intents[0]
        require(intent['name'] == 'ie.intent.' + label and complete[0]['name'] == 'ie.complete.' + label,
                name + ': wrong action identity')
        revision = step['document'].split('revision ')[-1]
        require(revision.isdecimal() and step.get('asset'), name + ': missing revision/asset')
        # Independently captured browser mark snapshot supplies expected document
        # identity; neither a same-number revision in another document nor an
        # asset-only draw satisfies the prerequisites.
        expected = [m['detail'] for m in step['marks'] if m['name'] == 'ie.editor.updated'
                    and m.get('detail', {}).get('revision') == revision]
        identities = {m.get('documentId') for m in expected}
        require(len(identities) == 1 and None not in identities and '' not in identities,
                name + ': missing/ambiguous expected document')
        document_id = next(iter(identities))
        correct = [e for e in group if e['name'] == 'ie.editor.updated'
                   and detail(e).get('revision') == revision and detail(e).get('documentId') == document_id]
        settled = [e for e in correct if detail(e).get('busy') is False and detail(e).get('ready') is True]
        draws = [e for e in group if e['name'] == 'ie.canvas.drawn'
                 and detail(e) == {'documentId': document_id, 'revision': revision, 'assetId': step['asset']}]
        require(index > 0 and steps[index-1].get('asset'), name + ': missing predecessor asset')
        changed = step['asset'] != steps[index-1]['asset']
        require(correct and settled and (not changed or draws), name + ': missing exact prerequisite before verified')
        required = max([complete[0]['ts'], settled[0]['ts']] + ([draws[0]['ts']] if changed else []))
        require(intent['ts'] <= min(complete[0]['ts'], settled[0]['ts']) <= required <= stop['ts'],
                name + ': prerequisite order')
        box = step['canvasBox']
        require(all(math.isfinite(box[k]) for k in ('x', 'y', 'width', 'height'))
                and box['width'] > 0 and box['height'] > 0 and step.get('canvasBackendNodeId'), name + ': canvas identity/geometry')
        def covers(event):
            clip = event.get('args', {}).get('clip', [])
            return len(clip) == 8 and all(math.isfinite(x) for x in clip) and min(clip[::2]) <= box['x'] and max(clip[::2]) >= box['x'] + box['width'] and min(clip[1::2]) <= box['y'] and max(clip[1::2]) >= box['y'] + box['height']
        paint = next((e for e in events if e['pid'] == start['pid'] and e['name'] == 'Paint'
                      and e['ts'] >= required and covers(e)), None)
        require(paint is not None, name + ': no correct covering Paint')
        paint_end = paint['ts'] + paint.get('dur', 0)
        require(math.isfinite(paint_end) and paint.get('dur', 0) >= 0, name + ': invalid Paint end')
        # Reject intervening supersession even before DOM verification. Duplicate
        # updates of the same settled state do not invalidate the prerequisite.
        for event in events:
            if event['pid'] != start['pid'] or not required < event['ts'] < paint_end:
                continue
            kind = event['name']
            value = detail(event)
            if kind == 'ie.editor.updated':
                require(value.get('documentId') == document_id and value.get('revision') == revision
                        and value.get('busy') is False and value.get('ready') is True, name + ': state superseded')
            elif kind == 'ie.canvas.drawn':
                require(value == {'documentId': document_id, 'revision': revision, 'assetId': step['asset']}, name + ': asset superseded')
            elif not passive(event) and kind != 'ie.test.verified.' + name:
                raise ValueError(name + ': intervening signal ' + kind)
        boundary = None
        if paint_end > stop['ts']:
            # All non-passive records conservatively bound this extension,
            # including unknown app marks, native dispatch, navigation and errors.
            # An absent next signal is inconclusive: a Paint itself cannot prove
            # a later finite trace boundary or continued target identity.
            boundary = next((e for e in events if e['pid'] == start['pid'] and e['ts'] > stop['ts']
                             and not passive(e)), None)
            require(boundary is not None and math.isfinite(boundary['ts']), name + ': no finite interference boundary')
            require(paint_end < boundary['ts'], name + ': Paint reaches interference boundary')
        ms = lambda stamp: round((stamp - intent['ts']) / 1000, 3)
        rows.append({'action': name, 'intent': intent, 'documentId': document_id, 'revision': revision,
                     'asset': step['asset'], 'assetChanged': changed,
                     'firstCorrectRevisionMs': ms(correct[0]['ts']), 'firstSettledRevisionMs': ms(settled[0]['ts']),
                     'firstCompleteMs': ms(complete[0]['ts']), 'matchingDrawMs': ms(draws[0]['ts']) if draws else None,
                     'completedCoveringPaintMs': ms(paint_end), 'paint': paint, 'canvasBox': box,
                     'testAssertionMs': ms(stop['ts']), 'postVerifiedPaint': paint_end > stop['ts'],
                     'finiteBoundary': boundary})
    require(rows, 'No admissible history actions')
    return rows


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    folder, output = map(pathlib.Path, sys.argv[1:])
    require(not output.exists(), 'Refusing to overwrite an existing analysis output')
    inputs = {name: digest(folder/name) for name in ['paint-trace.json', 'action-steps.json']}
    actions = analyze(json.loads((folder/'paint-trace.json').read_text())['traceEvents'],
                      json.loads((folder/'action-steps.json').read_text())['steps'])
    result = {'version': 2, 'retrospective': True, 'source': str(folder), 'inputSha256': inputs,
              'analyzerSha256': digest(pathlib.Path(__file__)),
              'boundary': 'Unchanged native intent through FIRST correct covering renderer Paint END. Exact document/revision/asset, settled state, single completion and required changed-asset draw precede DOM verification. Post-verification Paint must end before the next explicit non-passive signal; absent bounds fail closed. No GPU/physical display, formal W1/H, population or independent approval claim.',
              'actions': actions}
    output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps([{'action': r['action'], 'completedCoveringPaintMs': r['completedCoveringPaintMs'],
                       'postVerifiedPaint': r['postVerifiedPaint']} for r in actions], indent=2))


if __name__ == '__main__':
    main()
