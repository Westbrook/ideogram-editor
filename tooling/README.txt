P1a.1 package and public-consumer commands

Run from the editor repository root on macOS/Linux, with Python 3.12+ and tar.
Node/npm are downloaded from their official public distributions, checked against
tooling/toolchain.json, and installed only into ignored .toolchain storage:

  python3 tooling/bootstrap-toolchain.py
  export PATH="$PWD/.toolchain/bin:$PATH"
  python3 tooling/verify-vendor.py
  npm ci
  npm ls --all
  npm run test:vendor
  npm run typecheck
  npm run build
  npm run test:consumer

test:consumer creates a new temporary consumer with its own empty node_modules,
npm cache, home, and Playwright Chromium cache. It copies the committed package,
lock, vendor archives, configuration and fixture; it does not copy or resolve the
live design-system sibling. It verifies archives before installation, runs npm ci
and npm ls --all, checks actual installed realpaths/versions, typechecks/builds,
installs the pinned browser revision, then runs real browser registration, native
button/input and lazy-readiness tests. Browser requests outside loopback fail.
This is filesystem/dependency isolation, not an OS permission sandbox.

The initial root build targets tests/consumer/fixture only. The production editor
and localhost backend are separate later tasks. No provider key or paid call is
used. Neither the fixture nor its passing checks certify the editor's behavior.

Production from a new source selection (read-only live source input):

  python3 tooling/freeze-en-reve.py /path/to/design-system
  node tooling/produce-en-reve.mjs artifacts/en-reve-freezes/PRINTED_ID /path/to/design-system

Freeze captures the complete package/build/test source graph (packages, apps,
tooling, plans, probes and listed root inputs), including nonignored new files,
with exact source/lock/license bytes. Old output/caches, benchmark captures and
unrelated showcases are explicitly outside the selected build graph. The archive
uses sorted paths, fixed tar metadata and gzip mtime, and carries a per-file
path/length/SHA-256/mode manifest, HEAD, dirty binary patch and NUL status. New
file bytes are in the full source archive. Capture compares the source twice;
production also checks live input before and after all build/pack work, failing
on drift. Historical planning-audit corpus hashes describe different scopes and
dates; they must not be substituted for this selected identity.

The producer runs source npm ci in an empty temporary directory/cache using only
the exact pinned toolchain. It builds tokens, styles, primitives and elements in
order, regenerates metadata and checks lazy/types/API/customization output.
It adds the unchanged root LICENSE to each workspace archive, packs via npm12,
and seals actual npm SHA-512 integrity, SHA-1, SHA-256, byte counts and graph.
An existing vendor identity is never overwritten. To adopt a new identity,
update all four root file: dependencies together, regenerate package-lock.json,
then run the complete clean-consumer sequence above.

Reproduce the committed archives WITHOUT any design-system checkout:

  node tooling/produce-en-reve.mjs vendor/en-reve/37341d7a644cdfb37e6ba06d5c051e560306417d61a80705558bd78bd0c02cc4 --verify-rebuild

This extracts the stored source archive into a new temporary directory, installs
its unchanged lock, builds/checks/packs, and requires all four resulting archives
to match the stored SHA-256 and npm integrity byte-for-byte. It does not rewrite
the committed producer receipt or archives.

Receipts and failed outputs are retained under artifacts/producer-* and
artifacts/consumer-*; their temporary workspace paths are printed for diagnosis.
The accepted initial receipts and failed-attempt record are in evidence/p1a1.
Temporary install/browser directories are retained, not automatically deleted.
The consumer web server is owned/stopped by Playwright; tests use one worker and
zero retries. Port 4179 must be free; an occupied port fails rather than reusing
an unrelated service. npm12 may report a blocked optional fsevents install script;
no dependency scripts are granted permission solely to suppress that warning.

Qualification limits: Q12 covers this exact frozen input and initial public
consumer smoke. Q13 covers the selected Node/npm/Lit/Signals/build/browser graph,
not SQLite, fal, native text, all supported browser/AT combinations or adapters.
Recorded D01/D03/D09 elapsed times and D11 bytes are local observations for a
small fixture. They do not establish WD, W0/W1 or Q3 I2 performance qualification.
First archive performance qualification still requires five cold + five warm
whole source-install/producer/consumer-update runs on the specified environment.
Independent review of the exact implementation commit remains a separate gate.
