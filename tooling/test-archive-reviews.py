import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import pwd
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('archive', Path(__file__).with_name('archive-reviews.py'))
archive = importlib.util.module_from_spec(spec)
spec.loader.exec_module(archive)


def write_json(path, data):
    path.write_text(json.dumps(data, indent=2) + '\n')


def seal(root, reader, exclude=(), target=None):
    files = {str(p.relative_to(root)): {'bytes': p.stat().st_size, 'sha256': archive.file_hash(p)}
             for p in root.rglob('*') if p.is_file()
             and not any(archive.below(str(p.relative_to(root)), x) for x in exclude)}
    if reader == 'files-json-v1':
        manifest = 'FILES.json'
        write_json(root / manifest, {'files': files})
        data = {'manifestSHA256': archive.file_hash(root / manifest),
                'manifestBytes': (root / manifest).stat().st_size,
                'files': len(files), 'bytes': sum(v['bytes'] for v in files.values())}
        if target:
            data['target'] = target
        write_json(root / 'SEAL.json', data)
    else:
        manifest = 'SHA256SUMS'
        (root / manifest).write_text(''.join(v['sha256'] + '  ' + n + '\n' for n, v in files.items()))
    for p in sorted(root.rglob('*'), key=lambda p: len(p.parts), reverse=True):
        os.chflags(p, stat.UF_IMMUTABLE)
    os.chflags(root, stat.UF_IMMUTABLE)
    rule = {'reader': reader, 'root': root.name, 'manifest': manifest,
            'manifestSHA256': archive.file_hash(root / manifest), 'exclude': list(exclude),
            'immutable': 'all' if reader == 'sha256sums-v1' else 'files'}
    if reader == 'files-json-v1':
        rule.update(seal='SEAL.json', sealSHA256=archive.file_hash(root / 'SEAL.json'))
        if target:
            rule['target'] = target
    return rule


def fixture(parent, reader='files-json-v1', nested=False, target='a' * 40):
    root = parent / 'source'
    root.mkdir()
    evidence = root / 'evidence'; evidence.mkdir()
    (evidence / 'result.txt').write_text('Historical failure followed by a correction.\n')
    (evidence / 'references').mkdir()
    (evidence / 'references/FILES.json').write_text('{"historical":true}\n')
    os.utime(evidence / 'result.txt', ns=(1700000000123456789, 1700000000123456789))
    subprocess.run(['/usr/bin/xattr', '-w', 'user.archive-test', 'preserve-me', str(evidence / 'result.txt')], check=True)
    (root / 'HANDOFF.txt').write_text('Independent review; keep the original verdict.\n')
    admin = (evidence if nested else root) / 'admin'; admin.mkdir()
    (admin / 'closure.json').write_text('{"reviewed":false}\n')
    admin_rule = seal(admin, reader)
    admin_rule['root'] = str(admin.relative_to(root))
    primary = seal(evidence, reader, ['admin'] if nested else [], target)
    d = {'schemaVersion': 1, 'packetId': 'fixture-correction', 'sourceRoot': str(root),
         'include': ['evidence', 'HANDOFF.txt'] + ([] if nested else ['admin']),
         'review': {'kind': 'independent-review', 'target': target, 'verdict': 'Historical NOT APPROVED'},
         'seals': [primary, admin_rule], 'closingRecords': [{'path': 'HANDOFF.txt'}],
         'lineage': [{'relationship': 'corrects', 'reference': 'earlier rejected review'}],
         'dependencies': [{'kind': 'runtime', 'location': 'external', 'description': 'Pinned review runtime'}]}
    descriptor = parent / 'packet.json'; write_json(descriptor, d)
    return descriptor, d


def unlock_fixture(root):
    # Only test-owned temporary trees; the production tool has no cleanup operation.
    if not root.exists():
        return
    os.chflags(root, 0)
    for path in root.iterdir():
        if path.is_symlink():
            continue
        os.chflags(path, 0)
        if path.is_dir():
            unlock_fixture(path)


@unittest.skipUnless(sys.platform == 'darwin', 'The archive backend requires macOS')
class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.parent = Path(self.temporary.name).resolve()

    def tearDown(self):
        unlock_fixture(self.parent)
        self.temporary.cleanup()

    def test_both_readers_and_nested_seals_preserve_reference_manifests(self):
        for reader, nested in [('files-json-v1', False), ('files-json-v1', True), ('sha256sums-v1', False)]:
            folder = self.parent / (reader + str(nested)); folder.mkdir()
            _, d = fixture(folder, reader, nested)
            archive.schema(d)
            rows = archive.snapshot(d, Path(d['sourceRoot']))
            receipt = archive.validate_seals(d, Path(d['sourceRoot']), rows)
            self.assertEqual([r['files'] for r in receipt['seals']], [2, 1])
            self.assertEqual(receipt['unsealedFiles'], ['HANDOFF.txt'])
            self.assertEqual(rows, archive.snapshot(d, Path(d['sourceRoot'])))

    def test_descriptor_rejects_ambiguous_paths_and_unknown_policies(self):
        _, d = fixture(self.parent)
        for value in ['../source', '/absolute', 'a/../b', './evidence', 'evidence/', 'a\\b', 'a\nb', '._metadata']:
            bad = copy.deepcopy(d); bad['include'] = [value]
            with self.subTest(value=value), self.assertRaises(archive.ArchiveError):
                archive.schema(bad)
        for paths in [['evidence', 'evidence'], ['evidence', 'evidence/result.txt']]:
            bad = copy.deepcopy(d); bad['include'] = paths
            with self.assertRaises(archive.ArchiveError):
                archive.schema(bad)
        bad = copy.deepcopy(d); bad['seals'][0]['immutable'] = 'ignore'
        with self.assertRaises(archive.ArchiveError):
            archive.schema(bad)
        with self.assertRaises(archive.ArchiveError):
            archive.decode_json('{"files":{},"files":{}}')

    def test_seal_hash_and_exact_membership_are_enforced(self):
        _, d = fixture(self.parent)
        root = Path(d['sourceRoot']); rows = archive.snapshot(d, root)
        bad = copy.deepcopy(d); bad['seals'][0]['manifestSHA256'] = '0' * 64
        with self.assertRaisesRegex(archive.ArchiveError, 'identity mismatch'):
            archive.validate_seals(bad, root, rows)
        os.chflags(root / 'evidence', 0)
        (root / 'evidence/extra').write_text('unlisted')
        with self.assertRaisesRegex(archive.ArchiveError, 'exact path set'):
            archive.validate_seals(d, root, archive.snapshot(d, root))

    def test_tampered_payload_and_missing_flags_are_rejected(self):
        _, d = fixture(self.parent)
        root = Path(d['sourceRoot']); p = root / 'evidence/result.txt'; original = p.read_bytes()
        os.chflags(p, 0); p.write_bytes(b'bad')
        with self.assertRaisesRegex(archive.ArchiveError, 'Payload mismatch'):
            archive.validate_seals(d, root, archive.snapshot(d, root))
        p.write_bytes(original)
        with self.assertRaisesRegex(archive.ArchiveError, 'immutable flag'):
            archive.validate_seals(d, root, archive.snapshot(d, root))

    def test_links_and_unclassified_sidecars_are_rejected(self):
        _, d = fixture(self.parent); root = Path(d['sourceRoot'])
        bad = copy.deepcopy(d); bad['closingRecords'] = []
        with self.assertRaisesRegex(archive.ArchiveError, 'Unclassified'):
            archive.validate_seals(bad, root, archive.snapshot(bad, root))
        (root / 'link').symlink_to(root / 'HANDOFF.txt'); bad['include'] = ['link']
        with self.assertRaises(archive.ArchiveError):
            archive.snapshot(bad, root)
        os.link(root / 'HANDOFF.txt', root / 'hardlink')
        with self.assertRaises(archive.ArchiveError):
            archive.snapshot(d, root)

    def copy_run(self, nested=True, reader='files-json-v1'):
        descriptor, d = fixture(self.parent, reader, nested)
        before = archive.snapshot(d, Path(d['sourceRoot']))
        run = self.parent / 'run'
        with patch.object(archive, 'activity', return_value={'status': 'clear', 'openFiles': []}):
            result = archive.create(descriptor, run)
        return descriptor, d, before, run, result

    def test_round_trip_preserves_metadata_seals_and_originals(self):
        for reader in ['files-json-v1', 'sha256sums-v1']:
            folder = self.parent / reader; folder.mkdir()
            descriptor, d = fixture(folder, reader, nested=True)
            before = archive.snapshot(d, Path(d['sourceRoot']))
            run = folder / 'run'
            with patch.object(archive, 'activity', return_value={'status': 'clear', 'openFiles': []}):
                created = archive.create(descriptor, run)
            result = archive.verify(run, folder / 'restored', created['runSHA256'])
            self.assertTrue(result['contentVerified']); self.assertTrue(result['metadataVerified'])
            self.assertEqual(before, archive.snapshot(d, Path(d['sourceRoot'])))
            catalog = json.loads(Path(result['catalog']).read_text())
            self.assertEqual(catalog['review'], d['review'])
            self.assertEqual(catalog['lineage'], d['lineage'])
            self.assertFalse(catalog['humanReviewed']); self.assertFalse(catalog['originalDeletionAuthorized'])
            self.assertEqual(catalog['dependencies'][0]['availability'], 'not-verified')
            self.assertEqual((run.stat().st_mode & 0o777), 0o700)
            self.assertEqual(((run / 'payload.tar.gz').stat().st_mode & 0o777), 0o600)

    def test_existing_and_overlapping_destinations_are_rejected(self):
        descriptor, d, before, run, result = self.copy_run()
        saved = {p.name: p.read_bytes() for p in run.iterdir()}
        with patch.object(archive, 'activity', return_value={'status': 'clear'}):
            with self.assertRaisesRegex(archive.ArchiveError, 'already exists'):
                archive.create(descriptor, run)
            with self.assertRaisesRegex(archive.ArchiveError, 'overlaps'):
                archive.create(descriptor, Path(d['sourceRoot']) / 'run')
        self.assertEqual(saved, {p.name: p.read_bytes() for p in run.iterdir()})
        restore = self.parent / 'restored'
        archive.verify(run, restore, result['runSHA256'])
        with self.assertRaisesRegex(archive.ArchiveError, 'already exists'):
            archive.verify(run, restore, result['runSHA256'])
        self.assertEqual(before, archive.snapshot(d, Path(d['sourceRoot'])))

    def test_checksums_and_external_trust_anchor_block_substituted_inputs(self):
        _, _, _, run, result = self.copy_run()
        with self.assertRaisesRegex(archive.ArchiveError, 'trust anchor'):
            archive.verify(run, self.parent / 'restore', '0' * 64)
        (run / 'payload.tar.gz').write_bytes(b'corrupt')
        with self.assertRaisesRegex(archive.ArchiveError, 'checksum mismatch'):
            archive.verify(run, self.parent / 'restore', result['runSHA256'])
        self.assertFalse((self.parent / 'restore').exists())
        (run / 'RUN-SHA256SUMS').write_text('substituted')
        with self.assertRaisesRegex(archive.ArchiveError, 'trust anchor'):
            archive.verify(run, self.parent / 'restore', result['runSHA256'])

    def test_source_changes_leave_incomplete_receipt_without_verified_output(self):
        descriptor, d = fixture(self.parent)
        original_command = archive.command
        def changing_command(argv, **kwargs):
            output = original_command(argv, **kwargs)
            if '--no-recursion' in argv:
                (Path(d['sourceRoot']) / 'HANDOFF.txt').write_text('changed during copy')
            return output
        with patch.object(archive, 'command', side_effect=changing_command), \
             patch.object(archive, 'activity', return_value={'status': 'clear'}):
            with self.assertRaisesRegex(archive.ArchiveError, 'Source changed'):
                archive.create(descriptor, self.parent / 'run')
        self.assertTrue(list((self.parent / 'run').glob('failure-*.json')))
        self.assertFalse((self.parent / 'run/RUN-SHA256SUMS').exists())

    def test_activity_and_missing_capabilities_block_before_writing(self):
        descriptor, _ = fixture(self.parent)
        for status in ['unknown', 'in-use']:
            with patch.object(archive, 'activity', return_value={'status': status}):
                inspection, _ = archive.inspect_packet(descriptor)
                self.assertFalse(inspection['ready'])
                with self.assertRaisesRegex(archive.ArchiveError, 'Cannot copy'):
                    archive.create(descriptor, self.parent / 'run')
            self.assertFalse((self.parent / 'run').exists())
        with patch.object(archive.sys, 'platform', 'unsupported'):
            with self.assertRaisesRegex(archive.ArchiveError, 'macOS'):
                archive.create(descriptor, self.parent / 'run')
        with patch.object(archive.shutil, 'disk_usage', return_value=type('Disk', (), {'free': 0})()), \
             patch.object(archive, 'activity', return_value={'status': 'clear'}):
            with self.assertRaisesRegex(archive.ArchiveError, 'Insufficient space'):
                archive.create(descriptor, self.parent / 'run')

    def test_metadata_loss_blocks_catalog_publication(self):
        _, _, _, run, result = self.copy_run()
        original_command = archive.command
        def losing_command(argv, **kwargs):
            output = original_command(argv, **kwargs)
            if '-xpf' in argv:
                p = Path(argv[-1]) / 'evidence/result.txt'
                os.chflags(p, 0)
            return output
        with patch.object(archive, 'command', side_effect=losing_command):
            with self.assertRaisesRegex(archive.ArchiveError, 'metadata mismatch'):
                archive.verify(run, self.parent / 'restore', result['runSHA256'])
        comparison = json.loads((self.parent / 'restore/comparison.json').read_text())
        self.assertTrue(comparison['contentVerified']); self.assertFalse(comparison['metadataVerified'])
        self.assertFalse((self.parent / 'restore/catalog.json').exists())

    def test_unsafe_archive_members_are_rejected_before_extraction(self):
        cases = [('escape', '../escape', tarfile.REGTYPE, None),
                 ('absolute', '/escape', tarfile.REGTYPE, None),
                 ('symlink', 'file', tarfile.SYMTYPE, None),
                 ('hardlink', 'file', tarfile.LNKTYPE, None),
                 ('fifo', 'file', tarfile.FIFOTYPE, None),
                 ('pax', 'file', tarfile.REGTYPE, {'GNU.sparse.name': '../escape'}),
                 ('duplicate', 'file', tarfile.REGTYPE, None),
                 ('appledouble', '._file', tarfile.REGTYPE, None)]
        rows = {'file': {'type': 'file', 'bytes': 1, 'sha256': archive.digest(b'x')}}
        for label, name, kind, headers in cases:
            p = self.parent / (label + '.tar.gz')
            with tarfile.open(p, 'w:gz', format=tarfile.PAX_FORMAT) as tf:
                member = tarfile.TarInfo(name); member.type = kind
                member.size = 1 if kind == tarfile.REGTYPE else 0
                member.linkname = '../../outside' if kind in [tarfile.SYMTYPE, tarfile.LNKTYPE] else ''
                if headers:
                    member.pax_headers = headers
                tf.addfile(member, io.BytesIO(b'x') if member.size else None)
                if label == 'duplicate':
                    tf.addfile(member, io.BytesIO(b'x'))
            with self.subTest(label=label), self.assertRaises(archive.ArchiveError):
                archive.validate_archive(p, rows)

    def test_activity_reports_open_files_and_unknown_checks(self):
        root = self.parent / 'source'
        r = subprocess.CompletedProcess([], 0, 'p12\ncwriter\nf4\nn' + str(root / 'file') + '\n', '')
        with patch.object(archive.subprocess, 'run', return_value=r):
            self.assertEqual(archive.activity(root)['status'], 'in-use')
        with patch.object(archive.subprocess, 'run', side_effect=FileNotFoundError('lsof')):
            self.assertEqual(archive.activity(root)['status'], 'unknown')

    def test_partial_seal_selection_cannot_hide_unlisted_files(self):
        _, d = fixture(self.parent)
        d['include'] = ['evidence/result.txt', 'evidence/references', 'evidence/FILES.json',
                        'evidence/SEAL.json', 'admin', 'HANDOFF.txt']
        with self.assertRaisesRegex(archive.ArchiveError, 'entire seal root'):
            archive.validate_seals(d, Path(d['sourceRoot']), archive.snapshot(d, Path(d['sourceRoot'])))

    def test_bundle_history_classification_and_target_verification(self):
        repo = Path(__file__).resolve().parent.parent
        commits = subprocess.check_output(['git', '-C', str(repo), 'rev-list', '--reverse', 'HEAD'], text=True).splitlines()
        for thin in [False, True]:
            folder = self.parent / str(thin); folder.mkdir()
            target = commits[1] if thin else commits[0]
            descriptor, d = fixture(folder, target=target)
            header = '# v2 git bundle\n'
            revisions = target + '\n'
            if thin:
                header += '-' + commits[0] + ' prerequisite\n'
                revisions += '^' + commits[0] + '\n'
            header += target + ' refs/heads/fixture\n\n'
            pack = subprocess.check_output(['git', '-C', str(repo), 'pack-objects', '--stdout', '--revs'], input=revisions.encode())
            bundle = Path(d['sourceRoot']) / 'source.bundle'; bundle.write_bytes(header.encode() + pack)
            dep = {'kind': 'git-bundle', 'location': 'included', 'path': 'source.bundle',
                   'description': 'Small bundle fixture from existing local history',
                   'sha256': archive.file_hash(bundle), 'target': target}
            d['dependencies'].append(dep); d['include'].append('source.bundle'); write_json(descriptor, d)
            receipts = archive.dependencies(d, Path(d['sourceRoot']))
            self.assertEqual(receipts[1]['history'], 'prerequisite-dependent' if thin else 'complete')
            self.assertEqual(receipts[1]['prerequisites'], [commits[0]] if thin else [])
            dep['target'] = 'b' * 40
            with self.assertRaisesRegex(archive.ArchiveError, 'exact target'):
                archive.dependencies(d, Path(d['sourceRoot']))

    def test_malformed_checksum_list_is_rejected(self):
        _, d = fixture(self.parent, 'sha256sums-v1')
        root = Path(d['sourceRoot']); path = root / 'evidence/SHA256SUMS'
        os.chflags(path, 0); line = path.read_text().splitlines()[0]
        path.write_text(line + '\n' + line + '\n'); os.chflags(path, stat.UF_IMMUTABLE)
        d['seals'][0]['manifestSHA256'] = archive.file_hash(path)
        with self.assertRaisesRegex(archive.ArchiveError, 'duplicate checksum'):
            archive.validate_seals(d, root, archive.snapshot(d, root))

    def test_acl_round_trip(self):
        descriptor, d = fixture(self.parent)
        p = Path(d['sourceRoot']) / 'evidence/result.txt'
        os.chflags(p, 0)
        subprocess.run(['/bin/chmod', '+a', 'user:' + pwd.getpwuid(os.getuid()).pw_name + ' allow read', str(p)], check=True)
        os.chflags(p, stat.UF_IMMUTABLE)
        self.assertTrue(archive.entry(p)['acl'])
        with patch.object(archive, 'activity', return_value={'status': 'clear'}):
            created = archive.create(descriptor, self.parent / 'run')
        restored = archive.verify(self.parent / 'run', self.parent / 'restore', created['runSHA256'])
        self.assertTrue(restored['metadataVerified'])

    def test_interrupted_copy_keeps_originals_and_cannot_be_verified(self):
        descriptor, d = fixture(self.parent)
        before = archive.snapshot(d, Path(d['sourceRoot']))
        with patch.object(archive, 'activity', return_value={'status': 'clear'}), \
             patch.object(archive, 'validate_archive', side_effect=KeyboardInterrupt()):
            with self.assertRaises(KeyboardInterrupt):
                archive.create(descriptor, self.parent / 'run')
        self.assertEqual(before, archive.snapshot(d, Path(d['sourceRoot'])))
        self.assertTrue(list((self.parent / 'run').glob('failure-*.json')))
        self.assertFalse((self.parent / 'run/RUN-SHA256SUMS').exists())

    def test_documented_cli_commands_and_read_only_inspection(self):
        descriptor, d = fixture(self.parent, 'sha256sums-v1')
        script = str(Path(__file__).with_name('archive-reviews.py'))
        before = archive.snapshot(d, Path(d['sourceRoot']))
        def cli(*args, code=0):
            result = subprocess.run([sys.executable, script, *map(str, args)], capture_output=True, text=True)
            self.assertEqual(result.returncode, code, result.stderr)
            return result.stdout
        for args in [('--help',), ('inspect', '--help'), ('create', '--help'), ('verify', '--help')]:
            self.assertIn('usage:', cli(*args))
        inspected = json.loads(cli('inspect', '--descriptor', descriptor))
        self.assertTrue(inspected['ready'])
        self.assertEqual(before, archive.snapshot(d, Path(d['sourceRoot'])))
        created = json.loads(cli('create', '--descriptor', descriptor, '--destination', self.parent / 'run'))
        verified = json.loads(cli('verify', '--run', self.parent / 'run', '--restore-to', self.parent / 'restore',
                                  '--expected-run-sha256', created['runSHA256']))
        self.assertEqual(verified['status'], 'restore-verified')
        self.assertEqual(before, archive.snapshot(d, Path(d['sourceRoot'])))
        cli('--delete', code=2)


if __name__ == '__main__':
    unittest.main()
