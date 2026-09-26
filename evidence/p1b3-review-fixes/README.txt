P1b.3 correction for independent findings I-A01, I-A02 and I-A03.
Author verification, not independent approval. Parent source7469f99 remains sealed.
Exact correction commit and committed-byte checks are recorded in the task and PR Context.

Use pinned .toolchain/bin Node26.10.0/npm12.1.0.
Main gates: npm run typecheck; npm run build; npm run test:assets;
npm run test:protocol; npm run test:recovery; npm run test:store;
npm run test:session; npm run test:shell; npm run verify:vendor;
python3 docs/spec/tools/check_spec.py.
Use IE_RECOVERY_OUTPUT pointing to a fresh isolated output directory.

The unchanged independent scripts in probe/ were copied from the reviewer7469f99
workspace. Before and after executions used distinct new roots/output directories.
To rerun, copy both scripts into a NEW directory, place/build the exact candidate
under source/, then run from that directory:
source/.toolchain/bin/node --import ./source/tests/session/no-egress.mjs --test --test-concurrency=1 independent.test.mjs
Never run these write-producing scripts over sealed evidence or reviewer roots.

The unchanged timing-760.mjs driver likewise needs source/ plus an empty roots/
in a NEW directory. Its historical embedded target label is disclosed and rebound
to the actual current source manifest in timing-index.json. No timing limit changed.

Raw fail-before logs are preserved byte-for-byte, including whitespace.
No claim is made that original7469f99 passed the three independent findings.
SHA256SUMS is relative to this evidence directory and excludes itself.
