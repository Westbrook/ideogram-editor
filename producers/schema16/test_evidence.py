"""Evidence references and fixture-relative content have different identities."""
import hashlib
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

import packet
from transport import archive, file_ref, sealed_json


def content(data=b'fixture object'):
    digest = hashlib.sha256(data).hexdigest()
    return {'path': 'sha256/' + digest[:2] + '/' + digest, 'hash': 'sha256:' + digest, 'byteLength': str(len(data))}


def observation(root, objects):
    return {'kind': 'schema17-executable-observation-1', 'storageVersion': 17, 'root': str(root), 'retained': {'objects': objects}}


class EvidenceBoundaries(unittest.TestCase):
    def test_only_canonical_absolute_refs_are_relocatable(self):
        value = {**content(), 'path': '/fixture/evidence.json'}
        self.assertEqual(packet.reference_kind(value), 'file')
        for path in ['/fixture/../evidence.json', 'relative.json', './evidence.json', 'sha256/aa/unknown']:
            with self.subTest(path=path), self.assertRaises(archive.ArchiveError): packet.reference_kind({**value, 'path': path})

    def test_relative_objects_need_exact_context_and_digest_address(self):
        value = content()
        self.assertEqual(packet.reference_kind(value, ('retained', 'objects', 0)), 'object')
        for pointer in [(), ('objects', 0), ('retained', 'objects', '0'), ('nested', 'retained', 'objects', 0)]:
            with self.subTest(pointer=pointer), self.assertRaises(archive.ArchiveError): packet.reference_kind(value, pointer)
        for field, replacement in [('path', '../' + value['path']), ('hash', 'sha256:' + 'a' * 64), ('byteLength', '01')]:
            with self.subTest(field=field), self.assertRaises(archive.ArchiveError):
                packet.reference_kind({**value, field: replacement}, ('retained', 'objects', 0))

    def test_identity_relocation_does_not_erase_content_path_semantics(self):
        value = {'source': {**content(), 'path': '/old/source'}, 'retained': {'objects': [content()]}}
        moved = {**value, 'source': {**value['source'], 'path': '/new/source'}}
        self.assertEqual(packet.packet_identity(value), packet.packet_identity(moved))
        with self.assertRaises(archive.ArchiveError):
            packet.packet_identity({**value, 'retained': {'objects': [{**content(), 'path': 'different'}]}})

    def test_observation_requires_declared_root_exact_membership_and_bytes(self):
        item = content(); rows = {item['path']: {key: item[key] for key in ['hash', 'byteLength']}}
        packet.verify_observation_objects(observation('/fixture', [item]), '/fixture', rows)
        for changed in [observation('/other', [item]), observation('/fixture', []), observation('/fixture', [item, item]),
                        observation('/fixture', [{**item, 'byteLength': '9'}])]:
            with self.assertRaises(archive.ArchiveError): packet.verify_observation_objects(changed, '/fixture', rows)

    def test_actual_fixture_objects_are_hashed_without_links(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve(); item = content(); path = root / 'objects' / item['path']; path.parent.mkdir(parents=True)
            path.write_bytes(b'fixture object')
            rows = packet.fixture_objects(root)
            packet.verify_observation_objects(observation(root, [item]), str(root), rows)
            (path.parent / 'linked').symlink_to(path.name)
            with self.assertRaises(archive.ArchiveError): packet.fixture_objects(root)

    def test_archive_object_bytes_match_observed_relative_content(self):
        item = content(); name = 'objects/' + item['path']; manifest = {'entries': {name: {'type': 'file', 'bytes': int(item['byteLength']), 'sha256': item['hash'][7:]}}}
        def bundle(payload=b'fixture object', include=True):
            output = io.BytesIO()
            with tarfile.open(fileobj=output, mode='w:gz') as writer:
                if include:
                    member = tarfile.TarInfo(name); member.size = len(payload); writer.addfile(member, io.BytesIO(payload))
            output.seek(0); return output
        rows = packet.archive_fixture_objects(manifest, bundle())
        packet.verify_observation_objects(observation('/fixture', [item]), '/fixture', rows)
        for stream in [bundle(b'changed object'), bundle(include=False)]:
            with self.assertRaises(archive.ArchiveError): packet.archive_fixture_objects(manifest, stream)

    def test_collection_validates_objects_instead_of_opening_relative_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve(); item = content(); path = root / 'fixture/objects' / item['path']; path.parent.mkdir(parents=True); path.write_bytes(b'fixture object')
            note = root / 'observation.json'; archive.save(note, observation(root / 'fixture', [item])); reference = file_ref(note)
            binding = {(reference['hash'], reference['byteLength']): {'declaredRoot': str(root / 'fixture'), 'objects': packet.fixture_objects(root / 'fixture')}}
            index = sealed_json(packet.collect_evidence(root / 'valid', [reference], [], binding))
            self.assertEqual(len(index['entries']), 1)
            with self.assertRaises(archive.ArchiveError): packet.collect_evidence(root / 'unbound', [reference], [])
            bad_binding = {(reference['hash'], reference['byteLength']): {'declaredRoot': '/wrong', 'objects': {}}}
            with self.assertRaises(archive.ArchiveError): packet.collect_evidence(root / 'wrong', [reference], [], bad_binding)

    def test_old_producer_substitution_is_exact_and_retains_original_reference(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve(); producer = root / 'producer.py'; old = root / 'sealed-original.py'
            producer.write_bytes(b'original'); old.write_bytes(b'original'); reference = file_ref(producer); old_ref = file_ref(old)
            producer.write_bytes(b'repaired')
            key = (reference['hash'], reference['byteLength'])
            index = sealed_json(packet.collect_evidence(root / 'evidence', [reference], [], substitutions={key: old_ref}))
            self.assertEqual(index['entries'][0]['originalPath'], str(producer)); self.assertEqual(index['entries'][0]['resolvedPath'], str(old))
            self.assertEqual(index['entries'][0]['hash'], reference['hash'])
            with self.assertRaises(archive.ArchiveError): packet.collect_evidence(root / 'changed', [reference], [], substitutions={key: file_ref(producer)})

    def test_unknown_relative_triples_are_not_silently_skipped(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve(); path = root / 'unknown.json'; archive.save(path, {'different': content()})
            with self.assertRaises(archive.ArchiveError): packet.collect_evidence(root / 'result', [file_ref(path)], [])


if __name__ == '__main__': unittest.main()
