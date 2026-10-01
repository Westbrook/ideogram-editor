# Completion network boundary review — 2026-09-30

This source review is limited to request issuers and their reachable ownership wrapper. The validation implementer reviewed existing product changes written before this work. It is not product acceptance, a human review checkpoint, or approval of memory/resource qualification. The historical issuer producer and its manifest remain sealed and unchanged.

`RecoveryClient` routes the same paths and request options through `RecoveryWorkspace.request`. That wrapper forwards the original transport and options and substitutes the workspace abort signal. It introduces no request API, destination, credentials, redirect behavior, body or keepalive flag. The release POST still uses the same local endpoint, CSRF header and protocol body. Cancellation can prevent cleanup requests; this review does not claim stronger release delivery semantics. Content/control/stream readers and bounded buffers change ownership and parsing, not issuer permissions.

`readSealedAsset` retains the same-origin URL check, bounded expected length, same-origin credentials, redirect rejection and original signal. Its new `readTextAssetResponse` helper only consumes/cancels/unlocks the response already obtained. Cleanup failures retain their owner; they do not launch retries or additional network requests. The recovery ownership helper is now pinned explicitly alongside the two changed boundaries. Session transport and text engine pins are unchanged.

The emitted classifier still requires exactly eight fetch calls and three XHR constructors, exact option shapes, fallback GET/null bodies, and body issuers confined to the main application. No count, option whitelist or historical producer identity is relaxed. Candidate preparation must pass those checks on the newly built application before dependent browser work.

Reviewed source identities (SHA-256):

```json
{
  "src/state/recovery-client.ts": {
    "prior": "6aad855f2d51645759637e1cbb64e1ffacae16e3b86df48d5848077b435d5fd7",
    "reviewed": "43f23b5cfb96db02e99a624ba0fcbe45aef3c1c96bd3db69b18a78aec5eabef4"
  },
  "src/text/contracts.ts": {
    "prior": "80173a85fd2eeca2cac63ea0806c23643668dfc2c3249859e9d07426e3730686",
    "reviewed": "96aa65d78cf834c14def464df88d3b94982193cfeabc8f70b1eaba3d86fae6ec"
  },
  "src/observability/recovery-memory.ts": {
    "prior": null,
    "reviewed": "52c4b1f97ae3ee5e3eec4e88ca0274174aaea1b54f611ec27a948393f052b492"
  }
}
```
