import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('audit', Path(__file__).with_name('review-workspaces.py'))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class ReviewAuditTests(unittest.TestCase):
    def test_inventory_is_read_only_sorted_and_excludes_known_locations(self):
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary).resolve()
            repo = parent / 'repo'
            repo.mkdir()
            small = parent / 'ideogram-edit-old'
            large = parent / 'ideogram-edit-large'
            preview = parent / 'ideogram-edit-preview'
            report = parent / 'ideogram-edit-progress-report'
            for path in (small, large, preview, report / 'data'):
                path.mkdir(parents=True)
            (small / 'keep.txt').write_text('Retained unique work')
            (large / 'large.bin').write_bytes(b'x' * 1024 * 128)
            (parent / 'ideogram-edit-alias').symlink_to(large, target_is_directory=True)
            (small / 'nested-alias').symlink_to(large, target_is_directory=True)
            (report / 'data/project.json').write_text(json.dumps({
                'cards': [{'itemId': 'preview', 'version': 'one', 'current': True,
                           'previewIdentity': {'service': {'root': str(preview / 'runtime')}}}],
            }))
            os.utime(small, (100000, 100000))
            before = {str(p): (p.lstat().st_mtime_ns, p.lstat().st_size) for p in parent.rglob('*')}

            def run(command, **kwargs):
                if command[0] == 'git':
                    return subprocess.CompletedProcess(command, 0, f'worktree {large}/source\0HEAD abc\0\0', '')
                return subprocess.run(command, **kwargs)

            data = audit.inventory(parent, repo, now=100000 + 86400 * 10, run=run)
            self.assertTrue(data['complete'])
            self.assertEqual(data['totals']['directories'], 4)
            self.assertEqual(data['skipped_symlinks'], [str(parent / 'ideogram-edit-alias')])
            rows = {r['path']: r for r in data['directories']}
            self.assertEqual(rows[str(small)]['age_days'], 10)
            self.assertEqual(rows[str(large)]['worktrees'], [str(large / 'source')])
            self.assertFalse(rows[str(preview)]['candidate'])
            self.assertFalse(rows[str(report)]['candidate'])
            self.assertTrue(rows[str(small)]['candidate'])
            self.assertEqual(data['directories'][0]['path'], str(large))
            self.assertLess(rows[str(small)]['allocated_bytes'], rows[str(large)]['allocated_bytes'])
            self.assertEqual(data['totals']['candidate_bytes'], rows[str(small)]['allocated_bytes'] + rows[str(large)]['allocated_bytes'])
            self.assertEqual(data['totals']['allocated_bytes'], data['totals']['candidate_bytes'] + data['totals']['excluded_bytes'])
            after = {str(p): (p.lstat().st_mtime_ns, p.lstat().st_size) for p in parent.rglob('*')}
            self.assertEqual(before, after)
            self.assertEqual((small / 'keep.txt').read_text(), 'Retained unique work')

    def test_failed_size_scan_is_unknown_not_zero(self):
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary).resolve()
            (parent / 'ideogram-edit-denied').mkdir()

            def run(command, **kwargs):
                return subprocess.CompletedProcess(command, 0 if command[0] == 'git' else 1, '', 'permission denied')

            data = audit.inventory(parent, parent, run=run)
            self.assertFalse(data['complete'])
            self.assertIsNone(data['directories'][0]['allocated_bytes'])
            self.assertEqual(data['totals']['measured'], 0)
            self.assertIn('permission denied', data['errors'][0])

    def test_cli_has_no_delete_option_and_missing_parent_fails(self):
        script = str(Path(__file__).with_name('review-workspaces.py'))
        result = subprocess.run(['python3', script, '--delete'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        with tempfile.TemporaryDirectory() as temporary:
            result = subprocess.run(['python3', script, '--parent', temporary + '/absent'], capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn('Cannot audit directories', result.stderr)


if __name__ == '__main__':
    unittest.main()
