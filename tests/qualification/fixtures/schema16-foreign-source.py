"""Portable source-boundary cases, never a native producer qualification."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, sys.argv.pop(1))
import maintenance_source as source
import packet


def require(value, message):
    if not value:
        raise ValueError(message)


class ForeignSource(unittest.TestCase):
    def setUp(self):
        self.reference = {'path': '/current/manifest.json', 'hash': 'sha256:' + 'a' * 64, 'byteLength': '10'}
        archive = {'path': '/original/unavailable/archive', 'hash': 'sha256:' + 'b' * 64, 'byteLength': '12'}
        self.spec = {'kind': 'linux-rollback-source-input-1', 'storageVersion': 16, 'historicalBase': source.HISTORICAL_BASE,
                     'compatibilityContract': source.CONTRACT, 'maintenancePatchHash': source.PATCH,
                     'sourceBytesModesIdentity': 'sha256:' + 'c' * 64,
                     'originManifest': self.reference, 'originArchive': {**archive, 'path': '/current/archive'},
                     'lineage': {'path': '/current/lineage.json', 'hash': 'sha256:' + 'd' * 64, 'byteLength': '10'}}
        self.manifest = {'kind': 'schema16-maintenance-source-transport-1', 'metadataPolicy': 'git-bytes-modes-maintenance-1',
                         'storageVersion': 16, 'historicalBase': source.HISTORICAL_BASE, 'compatibilityContract': source.CONTRACT,
                         'maintenancePatchHash': source.PATCH, 'archive': archive, 'metadataEquivalent': False,
                         'originalsUnchanged': True, 'status': 'copied-restore-pending', 'entries': {'source.txt': {'type': 'file'}}}
        observation = {'originalPath': '/original/tool', 'hash': source.PATCH, 'byteLength': '1', 'authority': 'source-selection-observation-only'}
        self.lineage = {'kind': 'schema16-maintenance-source-lineage-2', 'historicalBase': source.HISTORICAL_BASE,
                        'compatibilityContract': source.CONTRACT, 'sourceIdentity': self.spec['sourceBytesModesIdentity'],
                        'historicalExecutableClaim': False, 'linuxExecutableQualified': False,
                        'maintenancePatch': observation, 'gitExecutable': copy.deepcopy(observation)}

    def boundary(self):
        return source.foreign_source_manifest(self.spec, lambda ref: self.manifest if ref == self.spec['originManifest'] else self.lineage, require, 16)

    def test_exact_original_manifest_boundary(self):
        before = copy.deepcopy((self.spec, self.manifest, self.lineage))
        self.assertEqual(self.boundary(), (self.reference['hash'], self.reference['byteLength']))
        self.assertEqual((self.spec, self.manifest, self.lineage), before)

    def test_wrong_source_family(self):
        for key, value in [('kind', 'arbitrary'), ('storageVersion', 17), ('historicalBase', '0' * 40), ('maintenancePatchHash', 'sha256:' + 'e' * 64)]:
            with self.subTest(key=key):
                saved = self.spec[key]; self.spec[key] = value
                with self.assertRaises(ValueError): self.boundary()
                self.spec[key] = saved

    def test_wrong_manifest_family(self):
        for key, value in [('kind', 'arbitrary'), ('storageVersion', 18), ('metadataPolicy', 'arbitrary'), ('compatibilityContract', 'different')]:
            with self.subTest(key=key):
                saved = self.manifest[key]; self.manifest[key] = value
                with self.assertRaises(ValueError): self.boundary()
                self.manifest[key] = saved

    def test_future_or_incomplete_manifest_authority(self):
        for key, value in [('status', 'verified'), ('originalsUnchanged', False), ('metadataEquivalent', True), ('entries', {})]:
            with self.subTest(key=key):
                saved = self.manifest[key]; self.manifest[key] = value
                with self.assertRaises(ValueError): self.boundary()
                self.manifest[key] = saved

    def test_extra_live_ref_is_not_a_foreign_manifest(self):
        self.manifest['other'] = {'path': '/private/unrelated', 'hash': 'sha256:' + 'e' * 64, 'byteLength': '4'}
        with self.assertRaises(ValueError): self.boundary()

    def test_archive_content_binding(self):
        for key, value in [('hash', 'sha256:' + 'e' * 64), ('byteLength', '13')]:
            with self.subTest(key=key):
                saved = self.manifest['archive'][key]; self.manifest['archive'][key] = value
                with self.assertRaises(ValueError): self.boundary()
                self.manifest['archive'][key] = saved

    def test_source_identity_and_unissued_lineage(self):
        for key, value in [('sourceIdentity', 'sha256:' + 'e' * 64), ('historicalExecutableClaim', True), ('linuxExecutableQualified', True)]:
            with self.subTest(key=key):
                saved = self.lineage[key]; self.lineage[key] = value
                with self.assertRaises(ValueError): self.boundary()
                self.lineage[key] = saved

    def test_original_tools_remain_inert_observations(self):
        self.lineage['gitExecutable'] = {'path': '/original/tool', 'hash': source.PATCH, 'byteLength': '1'}
        with self.assertRaises(ValueError): self.boundary()

    def test_collection_does_not_reopen_original_archive_path(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve(); path = root / 'original.json'; packet.archive.save(path, self.manifest)
            original = path.read_bytes(); ref = packet.file_ref(path); self.spec['originManifest'] = ref
            boundary = self.boundary()
            with self.assertRaises((OSError, packet.archive.ArchiveError)):
                packet.collect_evidence(root / 'untyped', [ref], [])
            result = packet.sealed_json(packet.collect_evidence(root / 'typed', [ref], [], foreign_manifest=boundary))
            self.assertEqual(len(result['entries']), 1)
            self.assertEqual((root / 'typed' / result['entries'][0]['path']).read_bytes(), original)
            self.assertEqual(path.read_bytes(), original)

    def test_foreign_boundary_does_not_hide_other_live_refs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve(); path = root / 'original.json'; packet.archive.save(path, self.manifest)
            ref = packet.file_ref(path); self.spec['originManifest'] = ref
            other = root / 'other.json'; packet.archive.save(other, {'nested': {'path': '/unavailable/unrelated', 'hash': 'sha256:' + 'e' * 64, 'byteLength': '1'}})
            with self.assertRaises((OSError, packet.archive.ArchiveError)):
                packet.collect_evidence(root / 'result', [ref, packet.file_ref(other)], [], foreign_manifest=self.boundary())


result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(ForeignSource))
print(json.dumps({'tests': result.testsRun, 'failures': len(result.failures), 'errors': len(result.errors)}))
sys.exit(0 if result.wasSuccessful() else 1)
