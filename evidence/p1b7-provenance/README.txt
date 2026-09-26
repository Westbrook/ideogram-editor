P1b.7 evidence provenance addendum — no product or test execution change

Preserved target: e1fa068e405cf40d6c1e72256a0765967111d7fa.
This directory supplements evidence/p1b7 without changing any of its bytes,
including its original62-entry test-source.json and368-entry SHA256SUMS.
The exact successor commit is recorded in the task and shared PR Context.

The original test-source.json mixed14 verification code files and48 historical
Playwright JSON reporter outputs. All62 hashes were accurate on the shared disk,
but the48 outputs were ignored/untracked and absent from the sealed copies.
A recursive source-file scan included them because the reporter outputFile was
resolved beneath tests/editor; the artifact collector copied the repository-root
artifacts tree only. This was an incomplete evidence package, not a new product
finding or permission to relabel old results as final-source tests.

Current classification and availability:
- verification-code.json contains exactly the original14 tracked code inputs.
- browser-observations.json classifies every remaining original manifest entry
  and maps its original path/digest to a committed observations/attempt-NN.json.
- All48 observation copies are byte-identical to their original manifest digests,
  preserving627679bytes of configuration, success/failure results, dates, elapsed
  observations, diagnostics and attachment-path metadata. Nothing disappeared.
  No redaction was necessary in these JSON reports after structured inspection
  and decoded-string credential checks. inspection.json records the bounded audit.
- All76 attachment references map to existing sealed evidence:37 PNG,36 renamed
  error-context.txt and3 already-sanitized trace ZIPs. The reports recorded paths,
  not creation-time attachment hashes. Current shared-path equality is recorded
  where available; it does not establish an original trace's creation-time bytes.
  The3 trace copies are explicitly SANITIZED historical evidence; no raw private
  trace is added. Existing credential-cleanup/quarantine accounting still applies.
- The48 ignored original paths are no longer needed to verify this package.
  Read the copies/mapping rather than following embedded machine-local paths.
  Reporter results are historical observations, not source inputs or independent
  approval. Their metadata/snippets alone do not bind an older run to final code.

Verification from repository root, using only committed review content:
  python3 evidence/p1b7-provenance/verify.py
  python3 evidence/p1b7-provenance/verify.py --git

The first command verifies both seal inventories, all62 classifications/digests,
14 source files,48 copies and76 attachment mappings without reading ignored
original paths or compiled output. The --git command additionally compares every
verified file with HEAD Git bytes and requires the successor delta from e1fa068
to consist solely of this addendum. Neither command runs app tests or timing.
A fresh archive/checkout supports the first command without dist or ignored data;
--git requires the repository's Git history. Use git archive HEAD for a clean
contained-copy check; do not switch the shared checkout.

Prior runtime6ef96544, source/build identities, preview55911/report4381/approved
preview52219 and all functional/performance dispositions are unchanged. Task stays
review_required; coordinator assigns the existing independent review to the
successor. P1b21/27 and all three open feedback items remain unchanged.
