"""Restore the exact Pages upload into a fresh private directory; never extract links."""
from pathlib import Path, PurePosixPath
import hashlib
import os
import re
import stat
import sys
import tarfile

MAX_ARCHIVE_BYTES = 66 * 1024 * 1024
MAX_CONTENT_BYTES = 64 * 1024 * 1024
MAX_FILE_BYTES = 24 * 1024 * 1024
MAX_ENTRIES = 164


def unpack(archive, destination, manifest_sha256):
    archive, destination = Path(archive), Path(destination)
    if not re.fullmatch(r"[0-9a-f]{64}", manifest_sha256):
        raise ValueError("Expected public manifest SHA-256 required")
    if not archive.is_absolute() or not destination.is_absolute():
        raise ValueError("Absolute archive and fresh destination required")
    before = archive.lstat()
    if not stat.S_ISREG(before.st_mode) or archive.resolve() != archive or before.st_size > MAX_ARCHIVE_BYTES:
        raise ValueError("Archive must be a bounded canonical regular file")
    if destination.parent.resolve(strict=True) != destination.parent:
        raise ValueError("Destination parent must be canonical")
    destination.mkdir(mode=0o700)
    seen, file_count, total = set(), 0, 0
    # r: admits the uncompressed artifact.tar created by upload-pages-artifact.
    # Enumerate lazily so a hostile header count cannot allocate an unbounded list.
    with archive.open("rb") as stream, tarfile.open(fileobj=stream, mode="r:") as bundle:
        opened = os.fstat(stream.fileno())
        if (opened.st_dev, opened.st_ino, opened.st_size) != (before.st_dev, before.st_ino, before.st_size):
            raise ValueError("Archive identity changed before reading")
        for count, item in enumerate(bundle, start=1):
            if count > MAX_ENTRIES:
                raise ValueError("Archive entry bound exceeded")
            name = item.name
            if name in (".", "./") and item.isdir():
                if "" in seen:
                    raise ValueError("Duplicate archive root")
                seen.add("")
                continue
            if name.startswith("./"):
                name = name[2:]
            if name.endswith("/") and item.isdir():
                name = name[:-1]
            if not name or "\\" in name or name.startswith("/") or any(part in ("", ".", "..") for part in name.split("/")):
                raise ValueError("Unsafe archive path")
            if name in seen:
                raise ValueError("Duplicate archive member")
            seen.add(name)
            path = PurePosixPath(name)
            if item.isdir():
                if name not in ("assets", "notices"):
                    raise ValueError("Unexpected artifact directory")
                (destination / name).mkdir(mode=0o700, exist_ok=True)
                continue
            if not item.isfile() or item.issym() or item.islnk() or item.sparse:
                raise ValueError("Archive links and special files are forbidden")
            allowed = name in ("index.html", "build-identity.json", "artifact-manifest.json", ".nojekyll") or re.fullmatch(r"(?:assets|notices)/[A-Za-z0-9_.-]+", name)
            if not allowed or len(path.parts) > 2 or item.size < 0 or item.size > MAX_FILE_BYTES:
                raise ValueError("Unapproved artifact file")
            if path.name == ".nojekyll" and (name != ".nojekyll" or item.size != 0):
                raise ValueError("Pages .nojekyll must be an empty root file")
            file_count += 1
            total += item.size
            if file_count > 160 or total > MAX_CONTENT_BYTES:
                raise ValueError("Artifact content bound exceeded")
            target = destination / name
            target.parent.mkdir(mode=0o700, exist_ok=True)
            source = bundle.extractfile(item)
            if source is None:
                raise ValueError("Missing ordinary file data")
            remaining = item.size
            with source, target.open("xb") as output:
                os.chmod(target, 0o600)
                while remaining:
                    part = source.read(min(remaining, 65536))
                    if not part:
                        raise ValueError("Truncated artifact file")
                    output.write(part)
                    remaining -= len(part)
            if target.lstat().st_size != item.size:
                raise ValueError("Artifact extraction length differs")
        after_fd = os.fstat(stream.fileno())
        after_path = archive.lstat()
        for after in (after_fd, after_path):
            if not stat.S_ISREG(after.st_mode) or any(getattr(before, key) != getattr(after, key) for key in ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns")):
                raise ValueError("Archive changed during extraction")
    manifest = destination / "artifact-manifest.json"
    if not manifest.is_file() or manifest.stat().st_size > 1024 * 1024 or hashlib.sha256(manifest.read_bytes()).hexdigest() != manifest_sha256:
        raise ValueError("Uploaded artifact manifest differs from the tested build")
    # Semantic file-set/font/WASM/notice validation follows in artifact.mjs before
    # the publisher receives a token. Failed or partial restorations stay retained.
    return {"files": file_count, "bytes": total, "manifestSha256": manifest_sha256}


if __name__ == "__main__":
    import json
    if len(sys.argv) != 4:
        raise SystemExit("Usage: unpack-artifact.py /artifact.tar /fresh/public-artifact MANIFEST_SHA256")
    try:
        print(json.dumps(unpack(*sys.argv[1:])))
    except (OSError, ValueError, tarfile.TarError) as error:
        raise SystemExit(str(error))
