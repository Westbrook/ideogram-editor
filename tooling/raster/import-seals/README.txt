Oversized import profiles: source-only bridge, no qualification implied

All commands use pinned Node26.10.0, npm12.1.0 and existing repository guards.
PNG issuer is in ../import-issuance/. Native issuers remain separately frozen
producer inputs. Their output alone never changes product availability.

1. Produce actual format-specific evidence and obtain its accepted qualification.
   PNG uses its exact source closure. JPEG/WebP keep their own upstream/recipe,
   allocator, ABI, halo and pixel rules. Every qualification also lists exact integrated hostSourceFiles
   {repositoryPath,bytes,hash}, with their canonical hostSourceHash bound by each
   host-dependent receipt; candidate-only runtime
   authorization must be disclosed in the retained host evidence, never called
   a production issued profile. There are no synthetic qualifying receipts here.
   JPEG's qualification also references producerManifest {path,bytes,hash} for
   the selected exact producer-v3, producer-v4 or producer-v5 source manifest. Its hash must equal producerSourceHash;
   the complete copied input/dependency inventories are verified independently.
   The supported native producer authorities are explicitly pinned: JPEG v3/v4/v5
   and WebP v2. JPEG v4 only fixes published oracle CLI paths colliding with
   build directories; the C/ABI, pixel, allocator and qualification rules stay
   unchanged. Each retained JPEG generation resolves its own pinned producer
   manifest and dependency inventory. A repaired native producer needs a reviewed successor case, not
   a self-consistent replacement under an already frozen version name.

2. Run the format issuer into a fresh output and review adoption.json's SHA256.
   Complete its proof closure without changing any accepted qualification bytes:
     node --import ./tests/store/no-network.mjs tooling/raster/import-seals/complete.mjs ROOT ISSUED_CAPSULE MANIFEST_HASH ORIGINAL_QUALIFICATION EVIDENCE_ROOT NEW_OUTPUT
   References resolve relative to the original referring file, must remain in
   the explicit evidence root, and are captured using held descriptors. The
   sidecar maps original references to copied bytes. WebP full load-order child
   receipts, halo proof and source audit are retained, not only parent summaries.
   The original issuer manifest and proof sidecar remain separate historical
   inputs. A failed completion leaves its new incomplete directory for diagnosis.
   Input/output trees must be disjoint. Place the fresh output beside, rather
   than inside, the issuer capsule and evidence tree. Copied bytes and file
   counts are booked against the capsule limit before each copy.

3. Review the completed manifest hash, then create an adoption overlay:
     node --import ./tests/store/no-network.mjs tooling/raster/import-seals/adopt.mjs ROOT COMPLETE_CAPSULE MANIFEST_HASH NEW_OVERLAY
   This writes only NEW_OVERLAY/new and integration-manifest.json. It never
   copies directly into the real vendor tree or changes the live registry.
   The parent/root integration workflow applies exact-base targets after review,
   with new vendor paths and one generated inventory target. Existing destinations
   and ambiguous active (platform,arch,transport) tuples are rejected.
   All prior profiles, manifests and vendor files remain unchanged. activeProfiles
   explicitly selects executable generations. The overlay names every prior
   profile it deactivates because it replaces that format/target or the current
   implementation no longer matches. Historical verification parses captured
   authority/source bytes; current activation additionally checks the actual
   trusted checkout. Historical readable identity does not authorize replay.
   Native vendor paths include version/platform; a later generation needs a new
   producer version/path rather than replacing that directory. PNG paths include
   the source and qualification hashes, permitting host-only successors. Append order must never choose an executable decoder.

4. npm run verify:raster now includes verifyImportInventory. It verifies every
   installed capsule's exact files, accepted evidence closure, target codec
   authority and generated profile/native inventories. Foreign platforms are
   file-verified; no native library is loaded. Empty inventories pass as empty
   and all oversized crop/resize capabilities remain unavailable.

Scope: captured qualification verification, not a fully rerunnable native corpus.
Native oracle/harness binaries or corpus files without declared references are
not invented or implied retained. Source/host changes require new affected
qualification; emitted hash identities never stand in for actual execution.

No build, image execution, platform qualification, product activation or resource
claim occurs by preparing or verifying this source bridge. The unchanged 512MiB
runtime admission and all decoder limits remain the product authority.

Canonical source loading is pinned to Node26.10.0 and the exact4337-byte
src/protocol/json.ts SHA2562c7c9fd87dd2312bd144418a8ef6239e496c556c435c11eb326de5aa42f5b7c4.
A local helper lowers only its one exact JSONError parameter-property declaration,
then strips erasable types. Canonical/parser bodies stay unchanged. The common
verifier loads the trusted current checkout; historical captured source is never
executed. PNG CLI verifies its full source identity before the same pinned load.
The PNG issuer now seals this helper as its sixth input. The exact prior reviewed
five-input producer manifest remains readable as a separate historical case.
