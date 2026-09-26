# Ideogram Editor implementation handoff

Start with the [approved technical specification](../spec/index.md), then copy [kickoff.txt](kickoff.txt) into the future implementation task. All planning records are available through local files; workspace links are optional.

The exact approved technical identity is **409e4afb1a7168f706e9015e5e62122a74d40453** (SPEC-A3). Every existing `docs/spec/` byte is preserved. [Task 10's final V2 review](snapshots/20260926T020523Z/45decaa2-2459-4100-8461-d7680076c4d3.md) approves this commit with high confidence for specification readiness, closes R10-01/R10-02 and verifies all 20 audit findings and REQ-READY. Search that file for “V2” to reach the final verdict; the earlier NOT APPROVED verdict concerns the preceding version.

Some sealed files still say “pending review” because they were committed before the verdict. Those labels and earlier proposals are preserved evidence, not outstanding technical findings. The final V2 receipt and settled decisions supersede them. Planning completion does not establish runtime results, and this packaging task does not authorize application implementation.

## Read locally

| Need | Local artifact |
| --- | --- |
| Implementation scope, decisions, P1–P3 order, Q01–Q27 and first slice | [Specification index](../spec/index.md) |
| Complete owning requirements | [UX](../spec/ux.md), [Architecture](../spec/architecture.md), [Design system](../spec/design-system.md), [API](../spec/api.md), [Testing](../spec/testing.md), [Performance](../spec/performance.md) |
| Final approval and verification receipts | [Task 10 V2](snapshots/20260926T020523Z/45decaa2-2459-4100-8461-d7680076c4d3.md), [Task 9](snapshots/20260926T020523Z/06f9a11c-d6b1-4ddf-b695-69ea592617df.md) |
| Latest captured planning decisions and task index | [Spec snapshot](snapshots/20260926T020523Z/spec.md), [accepted operation policy](snapshots/20260926T020523Z/6df7045b-6f0a-42c5-a32d-879b38d54c51.md) |
| Latest captured progress and shared handoff | [Progress snapshot](snapshots/20260926T020523Z/b6884312-45fe-4295-a5a3-70180a701223.md), [PR Context snapshot](snapshots/20260926T020523Z/337dd04c-2911-4227-8217-1e2fc0b6a9f0.md) |
| Readiness audits | [8A conformance](snapshots/20260926T020523Z/b7a93978-262b-4266-aaf7-03cf836db2cf.md), [8B readiness](snapshots/20260926T020523Z/5f056a05-3316-4c28-9b1b-eb0d6f9d9349.md), [8C evidence](snapshots/20260926T020523Z/f0aea5b2-1d37-42a9-adf3-857e0a4995eb.md) |
| Reviewed desktop layout | [Complete text wireframe](snapshots/20260926T020523Z/1dd17672-e2f0-4c89-a9bb-414f871fa7a4.md) |
| All 32 notes, task receipts and older independent reviews | [Readable note map](note-map.md), [machine-readable ID/file map](note-map.json) |
| Source IDs, titles, task status, capture times, byte counts and hashes | [Manifest](manifest.json), [original capture catalog](capture.json), [direct source verification](source-verification.json) |
| Copyable future instruction and its provenance | [Portable kickoff](kickoff.txt), [exact original prompt](provenance/kickoff-original.txt) |

The first build milestones are P1a (reproducible packed en-reve consumer, browser shell and local session/security boundary without a provider key), then P1b (import → edit → undo → full-history copy → restart/reopen → exact export with real persistence and zero provider calls). P1c completes native text/fonts/masks and separate composition authoring. P2 uses a provider emulator first; P3 qualifies the initial release. P4 training and features marked Future remain deferred. The full specification owns all details and budgets.

Keep candidate bytes after candidate deletion, request the minimum compatible remote retention, and keep the optional durable per-session request cap off by default. Preserve the security, exact raster, history and durability contracts. Q01–Q27 remain implementation qualifications; source reasoning and documentation checks are not runtime evidence.

## Frozen capture and live state

The declared freeze is **2026-09-26T02:05:23.704Z**. The precise capture start and each note's read time are in the manifest. All 32 selected catalog timestamps remained unchanged across that read window. This is a stable source capture, not a claimed atomic database export.

Snapshots are exact UTF-8 `rawContent` text, including original links, Unicode, trailing whitespace and missing final newlines. They are not newly created chat transcripts. Each was read back directly and independently hashed against its workspace source. Do not normalize this evidence to satisfy a whitespace check. Authored navigation, metadata and the portable kickoff are checked separately.

The 34-entry catalog records all notes present at capture. Only the two newly created packaging tasks are excluded from the frozen planning set: Task 11 `1af74827-4b5d-4005-bdd4-d78cab2a9c9e` and Task 12 `618af5c0-045e-47c4-97ea-197c64650e7d`. All 32 preceding notes are included, with their latest text at the freeze. The captured Spec therefore mentions these operational tasks even though their notes are deliberately outside this set.

The progress snapshot is historical. The existing live report remains workspace note `b6884312-45fe-4295-a5a3-70180a701223`; it is a durable notes-only report, with no separate server or browser tab. Open report feedback was empty at capture. Later packaging receipts belong to the live task/report and parent handoff, without repeatedly refreshing this archive. A future Git-only task should use the snapshot as context and establish durable implementation progress in its own environment; it must not label this frozen file as live.

The exact original kickoff was recovered from coordinator agent `agent-3be00502-1589-4940-802a-b79f8ccbaf2d`, message `01a0db71-b331-7683-abf2-8a394adf67f2`, text block `:20`, at **2026-09-26T02:01:57.7304Z**, immediately before the Git-availability question. The provenance file contains the exact text inside its code fence, excluding the fence delimiters and without an added newline. `kickoff.txt` is explicitly a portable adaptation: it substitutes local references, explains the archive baseline and makes machine-specific input paths conditional. Pasting it authorizes local installs, isolated packaging, builds and testing in the future task only. Paid calls, publishing and deployment require separate authorization.

## Media and external references

[media-scan.json](media-scan.json) records the scan. All 32 note image inventories were empty. There are no referenced local image/video assets to copy and no missing required media was found. The wireframe is a complete Unicode text diagram. Image filenames and URLs elsewhere are schema or training examples, not actual image artifacts.

Historical notes mention temporary scripts, tool-output files and the sibling design-system source. These external files are **not included**, even if still present on the capture machine; the scan lists each path and its availability at inspection. Their recorded commands/findings remain in the notes. This handoff does not claim to reconstruct temporary research directories or full raw tool transcripts. The design-system source and built package archives must be obtained and qualified during P1a; they are not documentation artifacts. No secrets, system configuration, environment files, caches or sibling source trees were copied.

All 33 distinct `intent://local/file/` targets referenced by the snapshots already exist locally. Strip that prefix to obtain a repository path. For note/task URLs, use the ID map. For technical section anchors, prefer the mapped current specification file; for historical workspace-only anchors, search the named heading in the local snapshot. Unknown planning-note IDs: none.

## Git availability

Create the future implementation branch from the **latest completed, verified archival commit on local `upon-build`**, which adds this directory on top of the approved technical commit. Do not start from `main` or branch only from `409e4af`, which lacks this handoff. Discover the latest handoff commit candidate in the checkout with:

```sh
git log -1 --format=%H upon-build -- docs/handoff
git status --short
```

Confirm the candidate matches the completed handoff receipt and portability review before implementation; the completion receipt may accompany the handoff without requiring workspace-note access. A Git log entry or passing author checks alone does not establish completed independent review. If the package, local artifacts or completed verification are absent, report incomplete handoff packaging and the specific missing item, without reopening technical review. No future archival SHA is invented here.

This package is local Git availability, not pushed publication. No Git remote was configured at packaging; no push or PR was performed. A task sharing this repository can branch from the verified archival commit. Another machine needs the Git objects transferred through a separately authorized action. The commit's own SHA is recorded by Git and in the final completion handoff, rather than embedded in a self-referential archive.

## Integrity checks

Run from the repository root:

```sh
python3 docs/spec/tools/check_spec.py
(cd docs/spec && shasum -a 256 -c SHA256SUMS)
(cd docs/handoff && shasum -a 256 -c SHA256SUMS)
git diff --exit-code 409e4afb1a7168f706e9015e5e62122a74d40453 -- docs/spec
```

The handoff seals cover every handoff file except `SHA256SUMS` itself. The manifest contains the 32 exact source/snapshot hashes; source-verification records a separate direct hash comparison. [Verification receipt](verification.json) contains packaging checks and their limits. No renewed technical audit, application/runtime/provider test, install, benchmark or CI execution was part of this task.

## Packaging receipts

Task 11 produces the local package and author checks; Task 12 performs the separate bounded portability review. At archive time Task 11 was in progress and Task 12 had not started. Independent packaging credit remains pending Task 12. Final commit, clean-tree status and later review results are recorded in the existing live Task 11, PR Context and progress report, and the parent response. They are deliberately not fed back into these frozen planning sources.
