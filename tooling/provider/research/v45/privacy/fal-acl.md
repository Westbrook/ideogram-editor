> ## Documentation Index
> Fetch the complete documentation index at: https://fal.ai/docs/llms.txt
> Use this file to discover all available pages before exploring further.

> ## Agent Instructions
> fal has two developer products. Model APIs run hosted models through an API key. fal Serverless deploys your own Python apps and models on fal GPUs.
> To call a hosted model, start with the [Quick Start](https://fal.ai/docs/documentation/quickstart.md) and the [Model APIs overview](https://fal.ai/docs/documentation/model-apis/overview.md).
> To deploy your own model with fal Serverless, start with these pages:
> - [Introduction to Serverless](https://fal.ai/docs/documentation/serverless/index.md): What fal Serverless is and the three ways to deploy on it.
> - [Installation & Setup](https://fal.ai/docs/documentation/development/getting-started/installation.md): Install the fal CLI with `pip install fal` and authenticate.
> - [Quick Start](https://fal.ai/docs/documentation/development/getting-started/quick-start.md): Build a Hello World app, test it with `fal run`, and ship it with `fal deploy`.
> - [App Lifecycle](https://fal.ai/docs/documentation/development/app-lifecycle.md): How a `fal.App` goes from code to running runners.
> - [Define Your Endpoints](https://fal.ai/docs/documentation/development/endpoints-overview.md): Structure the API endpoints that your app exposes.
> - [Deploy to Production](https://fal.ai/docs/documentation/deployment/deploy-to-production.md): Persistent URLs, authentication modes, and automatic scaling.
> - [Machine Types](https://fal.ai/docs/documentation/deployment/machine-types.md): Available GPU and CPU machine types and how to choose one.
> - [Pricing](https://fal.ai/docs/documentation/serverless/pricing.md): Per-second billing and the runner states that are billed.
> - [Scaling Parameter Reference](https://fal.ai/docs/documentation/deployment/scale-your-application.md): Parameters that control runners, concurrency, and scale to zero.
> - [Optimizing Cold Starts](https://fal.ai/docs/documentation/serverless/optimizations/optimize-cold-starts.md): Causes of cold starts and ways to make them shorter.
> - [Examples](https://fal.ai/docs/examples/index.md): Complete Serverless apps for image, video, audio, 3D, realtime, and multi-GPU workloads.
> - [Migrating to fal](https://fal.ai/docs/documentation/development/migrating-to-fal.md): Guides to move an existing Docker server or an app from another platform to fal.
> fal Serverless deploys need access that the fal team approves for each account. Request access at https://fal.ai/dashboard/serverless-get-started.

# File Access Controls

> Restrict who can access files on the fal CDN with per-user access rules.

Every file on the [fal CDN](/docs/documentation/model-apis/fal-cdn) (`https://v3b.fal.media/...`) carries an Access Control List (ACL) that decides who can read it. By default, CDN URLs are publicly accessible to anyone with the link. ACLs let you change that default for the files a request produces -- keeping generated media private to your account, sharing it with specific teammates, or hiding it from view entirely.

ACLs are configured through the same [`X-Fal-Object-Lifecycle-Preference`](/docs/documentation/model-apis/common-parameters#x-fal-object-lifecycle-preference) header used to control [media expiration](/docs/documentation/model-apis/media-expiration). Setting an `initial_acl` on an inference request applies the rules to the CDN files that request **produces as output**. Input files are a separate case: SDKs upload them to the CDN *before* the inference call, so they are not covered by the inference request's header and keep your account's default ACL. To restrict an input, set the ACL on the upload itself (see [setting an ACL on a direct upload](#setting-an-acl-per-request)).

<Note>
  **Scope:** ACLs apply only to fal CDN v3 objects (URLs starting with `https://v3b.fal.media/...`). They do **not** apply to:

  * The serverless [`/data` persistent volume](/docs/documentation/development/use-persistent-storage). That storage has its own account-scoped permission model and is not addressable through CDN URLs.
  * Files hosted outside fal (S3, GCS, R2, your own server). Those are governed by the source's own access controls.

  This page is also unrelated to organization-level [Model Access Controls](/docs/documentation/organizations/access-controls), which restrict which models a team can call.
</Note>

## How an ACL Works

An ACL is a `default` decision plus an optional list of per-user `rules`:

```json theme={null}
{
  "default": "allow",
  "rules": [
    { "user": "alice", "decision": "forbid" },
    { "user": "bob", "decision": "allow" }
  ]
}
```

When someone requests a file, the CDN identifies the requester from the credential they present (see [Reading a Restricted File](#reading-a-restricted-file)) and applies the rule whose `user` matches. If no rule matches, the `default` decision applies -- an anonymous request carries no identity, so it matches no rule and always falls through to `default`.

A single request can present **more than one credential** at once -- for example, a signed URL that reads as one user together with a `Bearer` token for another. When several credentials are present, the CDN evaluates each and returns the **most permissive** outcome: `allow` beats `forbid`, and `forbid` beats `hide`. Put simply, the request succeeds if *any* identity it presents is allowed. For example, with the ACL `{ alice: forbid, bob: allow }`, a request that authenticates as both `alice` and `bob` is **allowed**, because `bob`'s `allow` is the most permissive match. (The `default` only applies when none of the presented identities matches an explicit rule.)

The file's **owner** -- the account that created it -- always retains access regardless of the ACL, so a `forbid` default never locks you out of your own files. ACLs only ever restrict *other* callers.

| Decision | HTTP response | Use it when |
| - | - | - |
| `allow` | `200 OK`, file served | The file should be readable |
| `forbid` | `403 Forbidden` | You want callers to know the file exists but is not theirs to read |
| `hide` | `404 Not Found` | You want the file to appear as if it does not exist |

The `user` field is a fal **nickname** (e.g. `alice`). Rules referencing a user that does not exist are silently dropped.

<Note>
  **Finding a user's nickname.** A nickname is the handle on a user's fal profile, also used in their app URLs (`fal.run/<nickname>/...`). Because unknown users are dropped silently, double-check the nickname if a rule doesn't take effect.
</Note>

## Setting an ACL Per Request

To apply an ACL to the files produced by a single inference call, pass [`X-Fal-Object-Lifecycle-Preference`](/docs/documentation/model-apis/common-parameters#x-fal-object-lifecycle-preference) on the request. The header accepts both `expiration_duration_seconds` and `initial_acl`, and they can be combined.

<CodeGroup>
  ```python Python theme={null}
  import fal_client, json

  result = fal_client.subscribe(
      "fal-ai/flux/schnell",
      arguments={"prompt": "a sunset"},
      headers={
          "X-Fal-Object-Lifecycle-Preference": json.dumps({
              "expiration_duration_seconds": 3600,
              "initial_acl": {
                  "default": "forbid",
                  "rules": [{"user": "alice", "decision": "allow"}],
              },
          })
      },
  )
  ```

  ```javascript JavaScript theme={null}
  import { fal } from "@fal-ai/client";

  const result = await fal.subscribe("fal-ai/flux/schnell", {
    input: { prompt: "a sunset" },
    headers: {
      "X-Fal-Object-Lifecycle-Preference": JSON.stringify({
        expiration_duration_seconds: 3600,
        initial_acl: {
          default: "forbid",
          rules: [{ user: "alice", decision: "allow" }],
        },
      }),
    },
  });
  ```

  ```bash cURL theme={null}
  curl -X POST "https://queue.fal.run/fal-ai/flux/schnell" \
    -H "Authorization: Key $FAL_KEY" \
    -H "Content-Type: application/json" \
    -H 'X-Fal-Object-Lifecycle-Preference: {"initial_acl":{"default":"forbid","rules":[{"user":"alice","decision":"allow"}]}}' \
    -d '{"prompt": "a sunset"}'
  ```
</CodeGroup>

You can also set an ACL when you **upload a file directly** (rather than on an inference request) -- the same `X-Fal-Object-Lifecycle-Preference` header applies. The SDKs also wrap it in a convenient `lifecycle` argument:

<CodeGroup>
  ```python Python theme={null}
  import fal_client
  from fal_client import StorageSettings, StorageACL, StorageACLRule

  url = fal_client.upload_file(
      "input.png",
      lifecycle=StorageSettings(
          initial_acl=StorageACL(
              default="forbid",
              rules=[StorageACLRule(user="bob", decision="allow")],
          ),
      ),
  )
  ```

  ```javascript JavaScript theme={null}
  const url = await fal.storage.upload(file, {
    lifecycle: {
      initialAcl: {
        default: "forbid",
        rules: [{ user: "bob", decision: "allow" }],
      },
    },
  });
  ```

  ```bash cURL theme={null}
  # A direct upload is two steps: initiate (which carries the ACL), then PUT the bytes.

  # 1. Initiate — the lifecycle header carries the initial_acl
  RESPONSE=$(curl -s -X POST \
    "https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3" \
    -H "Authorization: Key $FAL_KEY" \
    -H "Content-Type: application/json" \
    -H 'X-Fal-Object-Lifecycle-Preference: {"initial_acl":{"default":"forbid","rules":[{"user":"bob","decision":"allow"}]}}' \
    -d '{"file_name": "input.png", "content_type": "image/png"}')

  # 2. Upload the bytes to the returned presigned URL
  curl -X PUT "$(echo "$RESPONSE" | jq -r .upload_url)" \
    -H "Content-Type: image/png" --data-binary @input.png

  # The file is now available at the returned file_url:
  echo "$RESPONSE" | jq -r .file_url
  ```
</CodeGroup>

## Reading a Restricted File

A restricted file cannot be read with your `FAL_KEY` directly -- the CDN needs a token that identifies you as a user the file's ACL allows. Exchange your key for a short-lived CDN token, then send it as a `Bearer` header when you fetch the file.

<CodeGroup>
  ```python Python theme={null}
  import os, requests

  # 1. Exchange FAL_KEY for a CDN token
  token = requests.post(
      "https://rest.fal.ai/storage/auth/token?storage_type=fal-cdn-v3",
      headers={"Authorization": f"Key {os.environ['FAL_KEY']}"},
      json={},
  ).json()["token"]

  # 2. Read the file as yourself
  resp = requests.get(file_url, headers={"Authorization": f"Bearer {token}"})
  resp.raise_for_status()  # 200
  ```

  ```javascript JavaScript theme={null}
  // 1. Exchange FAL_KEY for a CDN token
  const res = await fetch(
    "https://rest.fal.ai/storage/auth/token?storage_type=fal-cdn-v3",
    {
      method: "POST",
      headers: {
        Authorization: `Key ${process.env.FAL_KEY}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    },
  );
  const { token } = await res.json();

  // 2. Read the file as yourself
  const file = await fetch(fileUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  ```

  ```bash cURL theme={null}
  # 1. Exchange FAL_KEY for a CDN token
  TOKEN=$(curl -s -X POST \
    "https://rest.fal.ai/storage/auth/token?storage_type=fal-cdn-v3" \
    -H "Authorization: Key $FAL_KEY" -H "Content-Type: application/json" -d '{}' \
    | jq -r .token)

  # 2. Read the file as yourself
  curl -s -H "Authorization: Bearer $TOKEN" "$FILE_URL" -o output.bin
  ```
</CodeGroup>

The response also includes `expires_at`. Tokens currently last up to 30 days, and you can request a shorter lifetime by passing `expiration_seconds` in the request body. Refresh the token before it expires.

### Sharing With Someone Who Has No fal Account

Mint a **signed URL** -- a self-contained link that embeds a time-limited, read-only credential, so the recipient needs no fal credentials of their own:

```python theme={null}
store, filename = file_url.split("/files/b/")[1].split("?")[0].split("/")

signed_url = requests.post(
    f"https://v3b.fal.media/files/b/{store}/{filename}/sign",
    headers={"Authorization": f"Bearer {token}"},
    json={"duration": 3600, "scope": ["read"]},  # seconds; default 24h, max 7 days
).text
```

Anyone holding the returned `...?identity=...` URL can download the file until it expires.

## ACLs Inside a Serverless App

When a fal App returns a file via `fal.toolkit.File`, `fal.toolkit.Image`, `fal.toolkit.Video`, or `fal.toolkit.Audio`, the toolkit uploads it to the CDN. If the caller passed `X-Fal-Object-Lifecycle-Preference` on the inference request, that preference (including `initial_acl`) flows through to the gateway and is applied automatically when your handler returns -- no extra code on your side:

```python theme={null}
import fal
from fal.toolkit import Image

class MyApp(fal.App):
    @fal.endpoint("/")
    def predict(self, request):
        pil = run_pipeline(request.prompt)
        return {"image": Image.from_pil(pil)}
```

This is the recommended pattern. Your app respects whatever ACL the caller asked for, and you do not have to thread the preference through your code.

### Enforcing a Server-Side ACL

If you are deploying an app and you want every output to follow a default ACL regardless of what the caller passes (for example, your app is for internal use and outputs must always be restricted to your team), set the lifecycle preference on the current request before constructing any file:

```python theme={null}
import fal
from fal.ref import get_current_app
from fal.toolkit import Image

class MyApp(fal.App):
    @fal.endpoint("/")
    def predict(self, request):
        ctx = get_current_app().current_request
        ctx.lifecycle_preference = {
            **(ctx.lifecycle_preference or {}),
            "initial_acl": {
                "default": "forbid",
                "rules": [
                    {"user": "alice", "decision": "allow"},
                    {"user": "bob", "decision": "allow"},
                ],
            },
        }

        pil = run_pipeline(request.prompt)
        return {"image": Image.from_pil(pil)}
```

The toolkit reads `current_app.current_request.lifecycle_preference` whenever it builds a file, so any `Image`, `Video`, `Audio`, or `File` you return after this assignment uses your enforced ACL. The override is scoped to the current request -- the framework resets the context on each new inference call.

A few notes on the pattern:

* **You override, not merge.** Anything you write to `lifecycle_preference["initial_acl"]` replaces the caller's `initial_acl` outright. Spreading `**(ctx.lifecycle_preference or {})` at the top, as in the example, preserves the caller's `expiration_duration_seconds` so callers can still control retention even though they cannot widen access.
* **Factor it out for multiple endpoints.** If several endpoints need the same enforcement, write a small `enforce_outputs(...)` helper and call it at the top of each handler, or wire it in as a FastAPI middleware on `self.app`.
* **Combine with retention.** Set `expiration_duration_seconds` in the same dict to enforce both retention and access in one place.

See [Working with Files](/docs/documentation/development/working-with-files) for the full file-handling reference.

## Common Patterns

**Make every file from this request private to me**

```json theme={null}
{
  "initial_acl": {
    "default": "forbid",
    "rules": []
  }
}
```

Pass that as the `X-Fal-Object-Lifecycle-Preference` header on the inference call. Every CDN file produced by the request returns `403` to anyone other than you.

**Share files with one teammate**

```json theme={null}
{
  "initial_acl": {
    "default": "forbid",
    "rules": [{ "user": "alice", "decision": "allow" }]
  }
}
```

**Combine with retention**

```json theme={null}
{
  "expiration_duration_seconds": 3600,
  "initial_acl": { "default": "forbid", "rules": [] }
}
```

The files are private and auto-deleted after one hour.

**Choosing between `hide` and `forbid`**

Use `forbid` when callers should be able to tell a file exists but is not theirs (a `403` is informative). Use `hide` when callers should not be able to enumerate or probe for the file (a `404` is indistinguishable from a missing file).

## Account-Wide Defaults

The patterns above let an individual request or a single deployed app set an ACL. If instead you want a default that applies across **all** activity on a fal account -- every model call, every upload, every app you deploy, with no header or handler code involved -- contact your fal account team or [support@fal.ai](mailto:support@fal.ai). Self-serve account-level configuration is not yet available.

When an account default is set, an `initial_acl` passed on an individual request takes precedence for that request -- the per-request ACL replaces the account default rather than merging with it.

## Managing Existing Files

An ACL is set at creation via `initial_acl`, but you can **change it afterward** -- adding or removing allowed users, or flipping the `default` -- through the storage REST API, authenticating with your `FAL_KEY`:

* `GET https://rest.fal.ai/storage/files/acl?url=<file_url>` -- read the file's current ACL.
* `PUT https://rest.fal.ai/storage/files/acl?url=<file_url>` with body `{ "default": "forbid", "rules": [{ "user": "alice", "decision": "allow" }] }` -- replace it.

Convenience wrappers in the SDKs and CLI are still on the roadmap; until then, use the REST endpoints above.

To read or share a file that is already restricted, see [Reading a Restricted File](#reading-a-restricted-file).

## Reference

| | |
| - | - |
| **Header** | `X-Fal-Object-Lifecycle-Preference` |
| **Header body** | JSON object with `expiration_duration_seconds` and/or `initial_acl` |
| **Decisions** | `allow` (200), `forbid` (403), `hide` (404) |
| **Default decision (new accounts)** | `allow` |
| **User identifier format** | fal nickname (e.g. `alice`) |
| **Scope** | fal CDN v3 URLs only (`https://v3b.fal.media/...`) |
| **Auth (set ACL)** | `FAL_KEY` on the inference / upload request |
| **Auth (read a restricted file)** | CDN Bearer token from `POST /storage/auth/token`, or a signed URL |
| **CDN token endpoint** | `POST https://rest.fal.ai/storage/auth/token?storage_type=fal-cdn-v3` |
| **Signed URL endpoint** | `POST https://v3b.fal.media/files/b/<store>/<filename>/sign` |

## Related

<CardGroup cols={2}>
  <Card title="fal CDN" icon="cloud-arrow-up" href="/docs/documentation/model-apis/fal-cdn">
    How files are uploaded to and served from the fal CDN
  </Card>

  <Card title="Data Retention" icon="clock" href="/docs/documentation/model-apis/media-expiration">
    Configure how long CDN files are retained before deletion
  </Card>

  <Card title="Working with Files" icon="file" href="/docs/documentation/development/working-with-files">
    Server-side file handling inside a fal App
  </Card>

  <Card title="Common Parameters" icon="sliders" href="/docs/documentation/model-apis/common-parameters">
    Full reference for platform headers
  </Card>
</CardGroup>
