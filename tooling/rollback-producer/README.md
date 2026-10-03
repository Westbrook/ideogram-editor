# Linux rollback producer source and hosted input admission

These helpers produce genuine Linux schema16 maintenance, schema17 and schema18
executable prerequisites. Source adoption alone issues no packet or product pin.
The hosted controller owns setup, input transfer, storage observation, owned
children, the actual compiler/library selection and independent offline restore.
Physical C/H qualification remains separate.

`hosted-inputs.json` is the exact reviewed 72-file source-input inventory:
219,487,623 bytes, manifest SHA-256
`5b71db1fd6c60980c8297b9fe48922a75c0a4dcaac6f73d6c4c0925a3e921e45`.
It contains no source archives itself. Those original byte inputs require the
root-selected immutable input commit; no input commit is issued by these files.
Input manifest membership, hashes, byte bounds, canonical paths, private ownership,
single-link files and active helper seals are checked before any wrapper is made.

The fixed producer paths are `tooling/rollback-producer/schema16`, `schema17` and
`schema18`. Each launcher requires isolated unoptimized Python (`-I -S -B`) and
an explicit reviewed `--seal-sha256 sha256:…` before its existing source-input,
build, verify or install command. Do not import these helpers into the controller
or replace their owned-process/native-host guards.

| Family | Active source seal SHA-256 |
| --- | --- |
| 16 | b074c7a19c6167a44b4dac1b370a6411dedaf3c9406538313838df919625dc3a |
| 17 | 403083498d96297da60fc33fe17835df00abe286c3e26a981ce5e01f14dd8e3f |
| 18 | 4b61813dc558928169c36c1883268ac8e55dc3e2b9867b33c22cf1981f27a3e9 |

Schema17/18 are byte-for-byte copies of reviewed producer-successor-03. Schema16
changes only its typed original source-manifest boundary and matching source seal.
The original seal is retained as `schema16-original-seal.json`, SHA-256
`c330622c4b5286ec8537ab04ed4e2fa1cc5642ba4a61d4b32c6467630cb4b450`.
Original helpers and source archives remain preserved in the owning retained
inputs. The new schema16 boundary validates the exact source family, manifest
shape/status, archive identity and inert lineage before identifying that exact
manifest as historical provenance. This preserves its bytes while preventing
collection from reopening its original Mac archive path. Other live references
remain mandatory. No executable authority or historical-source identity changes.

The Node entry is data-only and uses pinned Node26.10.0. The controller runs these
commands as its selected nonroot input owner inside the measured producer-data
allocation, through its bounded-child owner. `INPUT_ROOT` already contains the
exact materialized 72 input files plus `INPUTS.json`; `PREPARED_ROOT` must be new,
private, disjoint from inputs and have an existing private parent.
Both CLI operations refuse UID or GID zero and require matching real/effective
UID/GID before reading inputs or writing wrappers. Pure data APIs remain usable
for source-boundary tests; they are not privileged execution entry points.

```sh
node tooling/rollback-producer/hosted-inputs.mjs prepare \
  --input-root "$INPUT_ROOT" --manifest "$INPUT_ROOT/INPUTS.json" \
  --output "$PREPARED_ROOT"
node tooling/rollback-producer/hosted-inputs.mjs recheck \
  --receipt "$PREPARED_ROOT/prepared.json" --receipt-sha256 "$ACTUAL_RECEIPT_SHA256"
```

Prepare writes only three new `schemaV/source-input.json` wrappers and
`prepared.json`; original archives, manifests, wrappers and lineage are unchanged.
The stdout JSON is bounded to 32 KiB and contains the receipt file reference,
three source-input references and sealed active producer launcher references.
References use `{path,hash,byteLength}`, with `sha256:` hashes and decimal lengths.
Recheck rereads the fixed full input closure, current helper seals and every
derived wrapper. A serialized receipt is never a cross-process admission grant.
Failures retain partial outputs and never delete or overwrite a previous run.

The source-only Node owner is
`tests/qualification/rollback-hosted-inputs.test.mjs`, discovered by the guarded
qualification/tooling inventory. It covers manifest and filesystem admission,
identity-preserving rebinding, persisted-receipt refusal and the schema16 foreign
manifest through a portable Python source-boundary fixture. Run the whole file
with its owning group through the shared validation runner after source adoption.
These tests cannot establish a Linux native build, namespace admission, storage
coverage or genuine executable qualification.
