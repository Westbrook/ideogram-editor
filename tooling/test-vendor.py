#!/usr/bin/env python3
"""Exercise fail-closed artifact/lock checks using disposable consumer copies."""
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
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
        for name in ['package.json', 'package-lock.json', 'tooling/toolchain.json']:
            (self.root / name).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, self.root / name)
        shutil.copytree(ROOT / 'vendor', self.root / 'vendor')

    def tearDown(self):
        self.temporary.cleanup()

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
