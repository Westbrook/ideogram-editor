# Progress Report history archive source patch

This package updates the **independent sibling Progress Report**, not the editor.
The application does not import or execute these files. It contains source changes
and synthetic controls only. It contains no live project state, real selections,
archive chunks/indexes, runtime receipts, feedback payloads or machine-specific
private paths. The synthetic fixture uses invented state and has no qualification
or project-completion credit.

`../history-archive-v1.patch` changes `report.py` and `public/app.js`, adds
`report_archive.py`, and adds `test_archive.py`. The existing `test_compact.py` is
an unchanged prerequisite, not a patch target. `source-pins.json` is authoritative
for every baseline, required absence and after-file identity. Paths in it are
relative to the independent report workspace root.

Source review is closed with no findings against the frozen source manifest
`faaeae2de5ea10367939aa1d92f9bbe5e17ce4655f8bb5207aab1f5c1165629a`.
Its scope is source-only; real-data rehearsal and deployment outcomes belong to
the report owner and are not claimed by this package.

## Exact baseline

| Path | Bytes | SHA-256 |
| --- | ---: | --- |
| `report.py` | 19,710 | `10e3cc0c3c5f262e0a7d26c39c8b3c190ebd071ed6f915fd826a172c3c1caba3` |
| `public/app.js` | 12,402 | `ed5212de59477ed24801f1e8e40aa07832961e9d8033fd50aac59601e3a3a7de` |
| `test_compact.py` | 4,095 | `861ef55e7c20dd8fc29d8b5bde65df9292d63260006542543f6a73c831059334` |

`report_archive.py` and `test_archive.py` must be absent before applying. Stop on
any mismatch; this is an exact-baseline patch, not a merge recipe. Preserve the
existing independent report source and data before deployment.

## Source application and synthetic controls

Work first in a fresh, private, small source copy containing the three baseline
files above, with their relative layout. Apply with the ordinary patch utility
from that copy, using the absolute location of this package's patch:

The patch uses zero context so blank context markers are not mistaken for trailing
whitespace. Exact baseline and result hashes remain mandatory.

```sh
patch --batch --forward -p1 -i "$ARCHIVE_PATCH"
```

Verify all five resulting files against `source-pins.json`, including the unchanged
compact test. Do not apply this command from the editor root or point it at live
report data. Packaging verified this exact application and all after-file hashes
on a fresh source-only copy; it did not import modules, run tests, start a server,
execute a product build or migrate state.

When the report owner selects synthetic verification, use its pinned Python 3.14
interpreter from that private source copy:

```sh
PYTHONDONTWRITEBYTECODE=1 "$REPORT_PYTHON" -B test_archive.py
```

The test creates temporary invented report data beside the test and cleans it up.
It also invokes four existing non-HTTP compact controls. It deliberately excludes
the HTTP/server control. No editor dependencies, npm install, product imports,
external network, browser or real project state are needed. Do not infer browser
UI verification from these tests. The independent review and actual test results
are retained separately by the report owner, not embedded as private evidence here.

## Deployment and migration are separate

Only `report.py`, `report_archive.py` and `public/app.js` are report runtime files.
The report owner controls deployment into the independent sibling, service restart,
health/UI checks and any actual migration. Installing this source does not itself
archive data. No automatic aging occurs on reads, polls or normal milestone writes.

Before real archival, retain a durable exact snapshot of canonical JSON and the
paired prior source. Rehearse on a private copy with the exact reviewed selection,
material-event anchor and expected revision. Do not copy selection or report data
into this public source package. The archive API accepts only the six explicitly
supported handoff history arrays. Each selected outer record must have its canonical
JSON digest, exact field/offset and reviewed live-context justification. Explicit
zoned timestamps must be strictly more than 168 hours before the material anchor;
unknown or recent dates refuse. Current obligations, feedback, foreign streams,
checkpoints and accounting remain intact.

`Store.prepare_history_archive(selections, anchor_id, expected_revision)` writes
and verifies durable immutable chunks/indexes, reconstructs the full logical state,
and leaves canonical JSON unchanged. Retain its plan privately. Verify reconstruction,
nonselected fields, current summaries, external references and recovery before the
report owner calls `Store.commit_history_archive(plan, request_id)`. The commit
rechecks source identity, selection, anchor and revision under the existing lock/CAS.
A stale revision, including new user feedback, refuses: prepare again from current
state instead of overwriting it. A committed request ID is idempotent. Maintenance
is not a new material-work event and does not earn acceptance or effort credit.

Archive files remain required report data. Never remove or overwrite chunks/indexes.
Preserve their stable version IDs and links. The ordinary Store read/update API
hydrates full historical values; changed records remain inline while prior immutable
versions remain discoverable. Archive-aware UI navigation and export are separate
views of the same retained content.

## Recovery

Keep the original byte-exact snapshot and old code for pre-migration recovery. JSON
archive recovery preserves values, types and array order; it does not promise original
pretty-print whitespace or object-key order. Verify a reconstructed export before
changing a service. After subsequent report edits, never restore an old snapshot
over newer feedback: export the **latest** full logical state with
`Store.export_state(include_archive_metadata=False)` into a private recovery copy,
verify it, then pair that expanded state with compatible prior code. Old code must
never read compact markers without its archive module.

This reduces repeated active-payload writes. Compatible full-state writers still
hydrate history; no read-speed, peak-memory, disk-reclamation or product runtime
claim is made. Archive creation temporarily needs additional storage and does not
authorize cleanup or deletion.
