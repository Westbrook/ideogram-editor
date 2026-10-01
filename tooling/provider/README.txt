Usable Fal Generate — explicit local setup
========================================

Default: disabled. FAL_KEY alone neither enables nor selects a provider. The
normal launcher uses no fixture, proxy, caller-supplied endpoint or TLS override.
Only Generate image at ideogram/v4 is enabled by the sealed production profile.
Uploads, transformations, masks, LoRA and direct streaming remain denied until
their production contracts are separately implemented and reviewed.

Before enabling real calls, review a concrete prompt, exact dimensions and one
PNG output; approve a request/image limit and submission deadline, and the
privacy/cancellation disclosures below. A request cap is not a currency cap.
Do not paste a key into chat, browser fields, source, report data or logs. Store
an API-scoped Fal key locally in a separate owner-only 0600 regular file outside
the repository and editor root. No setup command automatically tests the key.

A separate owner-only 0600 approval JSON file follows the exported
FalAuthorizationManifest in server/provider/config.ts. It contains no key.
Required fields: schemaVersion=1, unique id, canonical ISO approvedAt/expiresAt,
endpoint="ideogram/v4", operation="generate", maxRequests (1..100), maxImages
(1..400), output={width,height,count:1,format:"png"}, expansion="None", exact
profileId/profileVersion/evidenceDigest/disclosureDigest from the current
server/provider/production-profile.ts, acknowledgeChargeAndPrivacy=true.
Dimensions must be 512..3840 in multiples of 16. Keep a pilot at 512x512, one
request and one requested image unless a wider concrete scope is approved.
The manifest hash binds the full configuration. A new manifest is a new explicit
approval, not a way to erase previous uncertain charges. Counters for the same
configuration survive browser sessions, spend-session resets and server restart.

Launch using Node 26.10.0 and npm 12.1.0 after the normal build, with server-only
environment settings IDEOGRAM_PROVIDER_MODE=fal,
IDEOGRAM_FAL_APPROVAL_FILE=/absolute/private/approval.json and
FAL_KEY_FILE=/absolute/private/fal-key. Key contents never appear in argv. The
loader rejects unsafe permissions, links, malformed content and unsupported
configuration. It reads no secrets in disabled mode. The writer receives the
captured configuration through an explicit backend channel; its environment
remains empty. Same-UID local processes are inside the existing trust boundary.

In the paired local UI: prepare and accept an exact request review, enqueue it,
refresh Fal dispatch, inspect its immutable review token and current disclosure,
then deliberately authorize that one queued attempt. Local review/enqueue alone
never submits. Old queued jobs and restored/imported history do not inherit
submission authorization. Restart invalidates an authorized but unstarted
attempt's dispatch authority: retain it for inspection, cancel it locally and
prepare a fresh queued request if still wanted. A lost provider acknowledgment
retains its count and conservative hold; there is no automatic paid retry.

The sealed documented fallback requests X-Fal-Store-IO:0 and a media lifecycle
of 3600 seconds with public ACL {default:"allow",rules:[]}. Media can be read
by anyone holding its URL. This is not qualified minimum/private retention.
Only HTTPS v3b.fal.media is permitted for credential-free image retrieval;
unknown hosts/redirects fail closed. With JSON history disabled, result JSON
may remain available for only about one hour after completion, or about six
minutes when >=10KB. Keep the server running to retain candidates promptly.
These policies are documented requests, not live provider compliance evidence.

Cancellation/disconnection does not prove execution stopped or establish a
refund. Local deletion does not remove provider copies. Authorization expiry
stops new submissions; explicit recovery/status/cancel/result handling for
previously authorized work remains available. Results are retained candidates;
provider completion does not adopt or overwrite the current document.

Official evidence and unresolved URL/schema variants:
  tooling/provider/research/20260930-official-profile.json
No credentialed request, upload, spend, provider compliance, or whole-product
acceptance is implied by the implementation or its loopback fixture tests.
