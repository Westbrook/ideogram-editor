#!/usr/bin/env python3
"""Exercise fail-closed artifact/lock checks using disposable consumer copies."""
import importlib.util
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import tempfile
import tarfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

vendor = load('vendor', ROOT / 'tooling/verify-vendor.py')
freeze = load('freeze', ROOT / 'tooling/freeze-en-reve.py')

class VendorBoundary(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='ideogram-vendor-test-')
        self.root = Path(self.temporary.name)
        for name in ['package.json', 'package-lock.json', 'tooling/toolchain.json', 'src/text/profile.json']:
            (self.root / name).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, self.root / name)
        shutil.copytree(ROOT / 'vendor', self.root / 'vendor')

    def tearDown(self):
        self.temporary.cleanup()

    def change_json(self, name, change):
        path = self.root / name
        value = json.loads(path.read_text())
        change(value)
        path.write_text(json.dumps(value, indent=2) + '\n')

    def replace_canvas_archive(self, change):
        """Re-seal a mutated test copy to reach packed-identity/path checks."""
        path = self.root / vendor.CANVASKIT_PATH
        with tarfile.open(path) as archive:
            files = [(m, archive.extractfile(m).read()) for m in archive.getmembers()]
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode='w:gz') as archive:
            for member, data in files:
                member, data = change(member, data)
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
        data = output.getvalue()
        path.write_bytes(data)
        profile = json.loads((self.root / 'src/text/profile.json').read_text())
        profile['engine']['tarball'].update(bytes=len(data), sha256=vendor.sha(data))
        profile.pop('id')
        profile['id'] = 'sha256:' + vendor.sha(json.dumps(profile, separators=(',', ':'), ensure_ascii=False).encode())
        for name in ['src/text/profile.json', 'vendor/text/manifest.json']:
            (self.root / name).write_text(json.dumps(profile, indent=2) + '\n')
        def reseal(rows):
            for row in rows:
                if row['path'] in [vendor.CANVASKIT_PATH, 'vendor/text/manifest.json']:
                    content = (self.root / row['path']).read_bytes()
                    row.update(bytes=len(content), sha256=vendor.sha(content))
        self.change_json('vendor/text/FILES.json', reseal)
        self.change_json('package-lock.json', lambda lock: lock['packages']['node_modules/canvaskit-wasm'].update(
            integrity='sha512-' + base64.b64encode(hashlib.sha512(data).digest()).decode()))

    def test_valid_archive_without_installed_dependencies(self):
        self.assertFalse((self.root / 'node_modules').exists())
        vendor.verify(self.root)

    def test_required_consumer_files(self):
        for name in ['package.json', 'package-lock.json']:
            with self.subTest(name=name):
                path = self.root / name
                raw = path.read_bytes()
                path.unlink()
                with self.assertRaisesRegex(SystemExit, 'Missing required consumer file'):
                    vendor.verify(self.root)
                path.write_bytes(raw)

    def test_consumer_symlinks_and_hardlinks(self):
        for name in ['package.json', 'package-lock.json']:
            for kind in ['symlink', 'hardlink']:
                with self.subTest(name=name, kind=kind):
                    path, saved = self.root / name, self.root / ('owned-' + name)
                    path.rename(saved)
                    try:
                        if kind == 'symlink':
                            path.symlink_to(saved)
                        else:
                            os.link(saved, path)
                        with self.assertRaisesRegex(SystemExit, 'Unsafe consumer (link|file)'):
                            vendor.verify(self.root)
                    finally:
                        path.unlink(missing_ok=True)
                        saved.rename(path)

    def test_consumer_directory_is_rejected(self):
        path = self.root / 'package-lock.json'
        path.unlink()
        path.mkdir()
        with self.assertRaisesRegex(SystemExit, 'Unsafe consumer file'):
            vendor.verify(self.root)

    def test_canvas_archive_tamper_is_rejected(self):
        with (self.root / vendor.CANVASKIT_PATH).open('ab') as file:
            file.write(b'tampered')
        with self.assertRaisesRegex(SystemExit, 'CanvasKit provenance mismatch'):
            vendor.verify(self.root)

    def test_canvas_profile_hash_is_rejected(self):
        for name in ['src/text/profile.json', 'vendor/text/manifest.json']:
            self.change_json(name, lambda profile: profile['engine']['tarball'].update(sha256='0' * 64))
        with self.assertRaisesRegex(SystemExit, 'CanvasKit profile identity mismatch'):
            vendor.verify(self.root)

    def test_canvas_manifest_inventory_hash_is_rejected(self):
        self.change_json('vendor/text/FILES.json', lambda rows: next(r for r in rows if r['path'] == vendor.CANVASKIT_PATH).update(sha256='0' * 64))
        with self.assertRaisesRegex(SystemExit, 'CanvasKit provenance mismatch'):
            vendor.verify(self.root)

    def test_canvas_lock_identity_is_rejected(self):
        path = self.root / 'package-lock.json'
        original = path.read_bytes()
        for field, value in [('resolved', 'file:vendor/text/other.tgz'), ('integrity', 'sha512-wrong'),
                             ('version', '0.40.0'), ('link', True)]:
            with self.subTest(field=field):
                path.write_bytes(original)
                self.change_json('package-lock.json', lambda lock: lock['packages']['node_modules/canvaskit-wasm'].update({field: value}))
                with self.assertRaisesRegex(SystemExit, 'Lockfile CanvasKit identity mismatch'):
                    vendor.verify(self.root)

    def test_canvas_lock_root_declaration_is_rejected(self):
        self.change_json('package-lock.json', lambda lock: lock['packages']['']['dependencies'].update({'canvaskit-wasm': '0.40.0'}))
        with self.assertRaisesRegex(SystemExit, 'Lockfile CanvasKit identity mismatch'):
            vendor.verify(self.root)

    def test_canvas_nonportable_declaration_is_rejected(self):
        self.change_json('package.json', lambda package: package['dependencies'].update({'canvaskit-wasm': 'file:vendor/text/../text/canvaskit-wasm-0.40.0-ideogram.3.tgz'}))
        with self.assertRaisesRegex(SystemExit, 'CanvasKit dependency must use'):
            vendor.verify(self.root)

    def test_nested_canvas_dependency_is_rejected(self):
        self.change_json('package-lock.json', lambda lock: lock['packages'].update({
            'node_modules/other/node_modules/canvaskit-wasm': lock['packages']['node_modules/canvaskit-wasm']}))
        with self.assertRaisesRegex(SystemExit, 'Duplicated or missing CanvasKit dependency'):
            vendor.verify(self.root)

    def test_unrelated_local_dependency_is_rejected(self):
        self.change_json('package-lock.json', lambda lock: lock['packages'].update({
            'node_modules/other': {'version': vendor.CANVASKIT_VERSION, 'resolved': 'file:' + vendor.CANVASKIT_PATH}}))
        with self.assertRaisesRegex(SystemExit, 'Nonregistry third-party dependency'):
            vendor.verify(self.root)

    def test_canvas_file_symlink_is_rejected(self):
        path = self.root / vendor.CANVASKIT_PATH
        path.unlink()
        path.symlink_to(ROOT / vendor.CANVASKIT_PATH)
        with self.assertRaisesRegex(SystemExit, 'Unsafe CanvasKit link'):
            vendor.verify(self.root)

    def test_canvas_parent_symlink_is_rejected(self):
        path = self.root / 'vendor/text'
        path.rename(self.root / 'text-copy')
        path.symlink_to(self.root / 'text-copy', target_is_directory=True)
        with self.assertRaisesRegex(SystemExit, 'Unsafe CanvasKit link'):
            vendor.verify(self.root)

    def test_canvas_packed_identity_is_rejected(self):
        def change(member, data):
            if member.name == 'package/package.json':
                packed = json.loads(data)
                packed['version'] = '0.40.0'
                data = json.dumps(packed).encode()
            return member, data
        self.replace_canvas_archive(change)
        with self.assertRaisesRegex(SystemExit, 'Packed CanvasKit identity mismatch'):
            vendor.verify(self.root)

    def test_canvas_packed_path_is_rejected(self):
        def change(member, data):
            if member.name == 'package/types/index.d.ts':
                member.name = '../outside.d.ts'
            return member, data
        self.replace_canvas_archive(change)
        with self.assertRaisesRegex(SystemExit, 'Unsafe CanvasKit package archive'):
            vendor.verify(self.root)

    def test_canvas_packed_symlink_is_rejected(self):
        def change(member, data):
            if member.name == 'package/bin/canvaskit.js':
                member.type, member.linkname, data = tarfile.SYMTYPE, '/outside.js', b''
            return member, data
        self.replace_canvas_archive(change)
        with self.assertRaisesRegex(SystemExit, 'Unsafe CanvasKit package archive'):
            vendor.verify(self.root)

    def test_changed_archive_is_rejected(self):
        archive = next((self.root / 'vendor').rglob('en-reve-elements-*.tgz'))
        with archive.open('ab') as file:
            file.write(b'tampered')
        with self.assertRaisesRegex(SystemExit, 'Package archive mismatch'):
            vendor.verify(self.root)

    def test_nested_private_dependency_is_rejected(self):
        path = self.root / 'package-lock.json'
        lock = json.loads(path.read_text())
        lock['packages']['node_modules/other/node_modules/@en-reve/elements'] = lock['packages']['node_modules/@en-reve/elements']
        path.write_text(json.dumps(lock))
        with self.assertRaisesRegex(SystemExit, 'Duplicated or missing private dependency'):
            vendor.verify(self.root)

    def test_concurrent_source_change_does_not_publish_snapshot(self):
        output = self.root / 'freeze-output'
        captures = [([{'path': 'package.json', 'sha256': 'before'}], {}),
                    ([{'path': 'package.json', 'sha256': 'after'}], {})]
        with patch.object(freeze, 'git', return_value=b'fixed'), patch.object(freeze, 'capture', side_effect=captures):
            with self.assertRaisesRegex(RuntimeError, 'Concurrent source drift'):
                freeze.freeze(self.root, output)
        self.assertFalse(output.exists())

if __name__ == '__main__':
    unittest.main()
