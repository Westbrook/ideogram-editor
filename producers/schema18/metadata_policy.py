"""Retained Linux construction-scoped metadata proof validation; no historical path access."""
from transport import archive, verify_restore_record

def verify_restore_set(records, expected, read_record):
    archive.require([row['role'] for row in records] == ['source', 'application', 'fixture'], 'Exact restore roles required')
    for row in records:
        closure = {key: expected[row['role']][key] for key in ['archive', 'manifest']}
        proof = read_record(row['record'])
        verify_restore_record(proof, read_record(closure['manifest']), read_record(proof['installedManifest']), closure)
