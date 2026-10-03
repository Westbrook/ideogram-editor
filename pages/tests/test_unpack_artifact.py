"""Offline publication-archive boundary tests; fixtures remain in allocated evidence."""
from pathlib import Path
import hashlib
import importlib.util
import io
import os
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("pages_unpack", ROOT / "tooling/pages/unpack-artifact.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
MANIFEST = b'{"schema":1}\n'
HASH = hashlib.sha256(MANIFEST).hexdigest()


class UnpackArtifact(unittest.TestCase):
    def setUp(self):
        value = os.environ.get("IE_PAGES_OUTPUT")
        if not value or not Path(value).is_absolute():
            raise RuntimeError("Explicit allocated IE_PAGES_OUTPUT required")
        parent = Path(value) / "controller-fixtures"
        parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.root = Path(tempfile.mkdtemp(prefix="unpack-", dir=parent))
        self.archive = self.root / "artifact.tar"
        self.destination = self.root / "public"

    def archive_with(self, members):
        with tarfile.open(self.archive, "w") as archive:
            for name, content, kind in members:
                row = tarfile.TarInfo(name)
                row.type = kind
                row.size = len(content) if kind == tarfile.REGTYPE else 0
                if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                    row.linkname = "../../outside"
                archive.addfile(row, io.BytesIO(content) if kind == tarfile.REGTYPE else None)

    def valid(self):
        return [("./", b"", tarfile.DIRTYPE), ("./assets/", b"", tarfile.DIRTYPE),
                ("./index.html", b"<html></html>", tarfile.REGTYPE),
                ("./assets/app.js", b"export {};", tarfile.REGTYPE),
                ("./artifact-manifest.json", MANIFEST, tarfile.REGTYPE)]

    def test_exact_regular_members_and_manifest(self):
        self.archive_with(self.valid())
        result = module.unpack(self.archive, self.destination, HASH)
        self.assertEqual(result["files"], 3)
        self.assertEqual((self.destination / "assets/app.js").read_bytes(), b"export {};")
        self.assertEqual(result["manifestSha256"], HASH)

    def test_refuses_existing_destination_without_overwrite(self):
        self.archive_with(self.valid())
        self.destination.mkdir()
        (self.destination / "preserve").write_bytes(b"original")
        with self.assertRaises(FileExistsError):
            module.unpack(self.archive, self.destination, HASH)
        self.assertEqual((self.destination / "preserve").read_bytes(), b"original")

    def test_refuses_wrong_manifest_and_preserves_failed_output(self):
        self.archive_with(self.valid())
        with self.assertRaisesRegex(ValueError, "differs"):
            module.unpack(self.archive, self.destination, "0" * 64)
        self.assertEqual((self.destination / "artifact-manifest.json").read_bytes(), MANIFEST)

    def test_refuses_path_traversal(self):
        self.archive_with([("../outside", b"bad", tarfile.REGTYPE)])
        with self.assertRaisesRegex(ValueError, "Unsafe"):
            module.unpack(self.archive, self.destination, HASH)
        self.assertFalse((self.root / "outside").exists())

    def test_refuses_links_and_special_members(self):
        for index, kind in enumerate((tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE)):
            with self.subTest(kind=kind):
                self.archive_with([("assets/link", b"", kind)])
                with self.assertRaisesRegex(ValueError, "links and special"):
                    module.unpack(self.archive, self.root / f"public-{index}", HASH)

    def test_refuses_duplicate_and_unexpected_members(self):
        for index, members in enumerate((self.valid() + [("index.html", b"other", tarfile.REGTYPE)],
                                        [(".progress-report/project.json", b"private", tarfile.REGTYPE)])):
            with self.subTest(index=index):
                self.archive_with(members)
                with self.assertRaises(ValueError):
                    module.unpack(self.archive, self.root / f"public-{index}", HASH)

    def test_refuses_declared_oversize_before_extracting(self):
        row = tarfile.TarInfo("assets/oversized.wasm")
        row.size = module.MAX_FILE_BYTES + 1
        self.archive.write_bytes(row.tobuf() + bytes(1024))
        with self.assertRaisesRegex(ValueError, "Unapproved"):
            module.unpack(self.archive, self.destination, HASH)
        self.assertFalse((self.destination / "assets/oversized.wasm").exists())


if __name__ == "__main__":
    unittest.main()
