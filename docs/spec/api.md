# API Surface — Ideogram V4 on fal.ai

Assembly revision **API-1.2+A1**, 2026-09-26 UTC. Approved technical baseline: **API-1.2** with accepted Spec addenda. This editorial assembly awaits independent final verification; the underlying source approvals are recorded in the [index](index.md#source-versions-and-approvals). No application, provider or performance qualification is claimed.

[Technical Specification](index.md) · [Traceability](index.md#requirement-traceability) · [Owned qualifications](index.md#qualification-register) · [Exact pre-assembly source and history](history/2728dafd-4209-4558-a762-3a0192e0610f.md).

Current policy: one style per text box, explicit Apply/Cancel, explicit field links between separate Layers and Composition lists, and previewed font substitution are accepted. Engineering choices and performance ceilings remain proposals requiring qualification. API facts retain their original evidence date and class.

## Corrected V4 family scope

The original six schemas remain correctly described by accepted v1. However, discovery through the official model catalog exposes `ideogram/v4/image-to-image/lora` and `ideogram/v4/inpaint/lora`: the former declares prompt + source + adapters, and the latter prompt + source + mask + adapters. The assertion that no single V4 call supports these combinations is no longer true of the expanded verified set. `ideogram/v4/lora` itself still accepts neither source nor mask. The coordinator independently confirmed these schemas and corrected the accepted compatibility note with a provider evidence addendum on 2026-09-25. The source/mask+LoRA gap is superseded: explicit Transform image with adapters resolves to /image-to-image/lora, and explicit Edit masked region with adapters resolves to /inpaint/lora after endpoint-specific validation. This is a factual correction within authorized family research, not a new user approval or permission to infer attachments. No staged workaround is required merely to combine these inputs. [Image-to-image LoRA docs](https://fal.ai/models/ideogram/v4/image-to-image/lora/api), [inpaint LoRA schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=ideogram/v4/inpaint/lora).

Discovery also found Fast, tiling, tiling with LoRA, six explicit stream routes, and an operational health route. Fast is now accepted for the initial editor; tiling remains later. Other discoveries extend the research set without automatically expanding product scope. Source/mask + Instant remains unsupported by its declared schema. No paid-contract checks were run.

## Evidence method and coverage

Evidence classes used throughout:

- **S — schema:** declared JSON types, required arrays, null branches, enums, bounds, defaults and references. A schema default is an annotation; it does not insert a value into a JSON payload. No captured request schema declares `additionalProperties: false`; an undeclared field therefore is not necessarily rejected by a generic validator. The editor must use an operation-specific allowlist so unsupported context is never ignored silently.
- **M — metadata:** `x-fal` size bounds and ordering/presentation metadata. These are not standard JSON Schema validation keywords. Their runtime enforcement is untested.
- **P — prose/example:** descriptions, official protocol docs, rendered examples, model listings and pricing text. Cross-field rules expressed only in prose must be implemented separately if adopted. Examples are not authoritative complete responses.
- **R — runtime:** none for generation, editing, training, streaming, uploads, cancellation or billing. Successful public documentation retrieval is evidence of publication, not a successful model call.

Discovery sources: [Ideogram catalog](https://fal.ai/explore/ideogram), [V4 model page](https://fal.ai/models/ideogram/v4), [family landing page](https://fal.ai/ideogram-4), [model's linked machine-readable guide](https://fal.ai/models/ideogram/v4/llms.txt). The server-rendered V4 page contains public endpoint entries, endpoint method descriptions, and `streamUrl` values. These exposed additional paths before retrieval of their schemas. The catalog displays nine family variants; that UI count excludes some schema routes and must not be treated as an exhaustive API inventory. Published method metadata additionally names `/inpaint/lora` and GET `/health`, even though those do not appear among the catalog's nine visible variants. No absence claim relies on a guessed URL failing.

Captured **27 endpoint schemas**: 17 V4 routes (10 ordinary inference, 6 streaming, 1 trainer) and 10 comparison routes. The appendix records every request/response field, nested schema, source URL, raw-byte SHA-256, and illustrative valid request/response. All files identify OpenAPI 3.0.4 and info.version 1.0.0; this version is a wrapper version, not a pinned model weights revision. Some constructs (`type: null`, numeric `exclusiveMinimum`) use modern JSON Schema forms despite the 3.0.4 declaration. Choose a compatible validator deliberately; do not assume an unmodified strict OAS 3.0 validator will accept the document.

GET `https://fal.run/ideogram/v4/health` is listed in the published method metadata as no inputs and `void` output. It is operational, not an editor operation. Its HTTP status, response body, auth behavior and error contract are not specified there; no health call was made. It has no captured queue schema. This limited reference does not assert worldwide completeness or discoverability of private/unlisted routes.

## V4 operation and field semantics

The appendix's complete field tables are normative for S/M evidence. This section provides semantics and application ownership; inheritance here is explanatory, never a shared payload that sends every field to every endpoint.

| Endpoint relative to `ideogram/v4` | Required inputs | Distinct declared behavior | Research disposition |
| --- | --- | --- | --- |
| base | prompt | Text-to-image; ten request fields | Accepted direct V4 |
| /instant | prompt | No speed/acceleration fields; None/Medium expansion; 2048-side metadata cap | Accepted direct V4 |
| /image-to-image | prompt, image_url | One source; strength default 0.8; auto size | Accepted direct V4 |
| /inpaint | prompt, image_url, mask_url | Masked regeneration; strength default 1; auto size | Accepted direct V4 |
| /lora | prompt | Optional loras list; no source/mask | Accepted direct V4; app requires at least one adapter |
| /trainer | images_data_url | Dataset and training controls; files out | Fully specified; later implementation phase |
| /fast | prompt | None/Medium expansion; speed retained; acceleration absent; 2048-side metadata cap | Accepted direct V4 in initial editor |
| /image-to-image/lora | prompt, image_url | Source transformation + loras; auto size; strength 0.8 | Direct V4; corrected compatibility addendum |
| /inpaint/lora | prompt, image_url, mask_url | Masked source transformation + loras; auto size; strength 1 | Direct V4; corrected compatibility addendum |
| /tiling | prompt | Optional source/mask; strength 0.8; tiling_mode | Newly discovered direct V4, product adoption deferred |
| /tiling/lora | prompt | Tiling inputs + loras | Newly discovered direct V4, product adoption deferred |
| /stream; /lora/stream; /image-to-image/stream; /image-to-image/lora/stream; /tiling/stream; /tiling/lora/stream | Same required fields as corresponding non-stream route | Same declared request controls except num_images absent; output schema is empty `{}` | Transport research; typed preview/final payload contract unresolved |

All ordinary V4 inference outputs share five **required, non-null** properties: `images: ImageFile[]`, `timings: object<string,number>`, `seed: integer`, `has_nsfw_concepts: boolean[]`, and `prompt: string`. No schema minItems, equal-length rule, timing-key list, timing units, seed range or exact per-image seed mapping is specified. Preserve actual output prompt separately from the requested prompt, and preserve returned seed and original request settings as provenance. Keep safety metadata with results; do not assume missing flags mean safe. Validate array correspondence defensively without inventing a provider guarantee. `timings` is not the same object as queue `metrics`; only the protocol's `metrics.inference_time` has an explicitly documented seconds unit. Generated output examples on several pages omit required timings/seed/safety fields: those examples are incomplete, not evidence that fields are optional.

`ImageFile.url` is required string; `content_type`, `file_name`, `file_size`, `width`, `height` are optional and nullable. `file_size` is bytes; dimensions are pixels. URL may carry hosted media or the documented data URI representation. Schema declares string, not URI-format validation. MIME, dimensions and bytes should be checked after retrieval; output width/height are not required. File metadata uses no numeric non-negative bounds. `File` used by trainer/comparators has URL plus optional nullable MIME/name/byte size, and no declared image dimensions.

### Controls and relationships

| Concept | V4 meaning and application ownership |
| --- | --- |
| prompt | Required string for all inference; no declared min/max length. Creative control, exact submitted text retained. Empty string is schema-valid but quality/provider acceptance is untested; any nonempty app rule must be labelled app policy. |
| expansion_model | Default Medium. None disables expansion; ordinary endpoints also allow Large. Instant/Fast allow only None/Medium. Expansion changes actual prompt and may add a fee; output prompt is provenance. Do not downgrade Large silently. |
| rendering_speed | TURBO/BALANCED/QUALITY, default BALANCED where present; prose relates faster modes to fewer denoising steps. Absent on Instant. Creative quality/cost choice, not a latency guarantee. |
| acceleration | none/low/regular/high, default none where present; absent on Instant/Fast. No quantitative tradeoff or speed guarantee is specified. |
| num_images | Integer 1–4, default 1, ordinary inference only. Batch-size control and expected workload; no stream field. |
| seed | Optional integer or null, no bounds. Omitted seed is described as randomly chosen. Explicit-null runtime semantics are not stated. Preserve exact returned value without assuming JavaScript safe-integer range or pixel reproducibility across model/provider changes. |
| sync_mode | Boolean false by default. P: returns inline data URI and does not store the image. It does not turn queue submission into direct HTTP or synchronous transport. Large inline responses affect expiry and memory; verify exact retention interaction separately. Internal transport/output policy. |
| enable_safety_checker | Boolean true by default. Disabling requires provider account authorization; unauthorized false still gets checked. Keep safe default; not an ordinary bypass control. |
| output_format | jpeg/png, default jpeg. Encoded image format; PNG alone is not a transparency guarantee. |
| image_url | One explicit source asset, required on dedicated editing routes; optional nullable on tiling. Frozen source version is provenance. URLs and data URIs are documented file inputs; local filesystem paths and private localhost URLs are not remotely readable. |
| mask_url | Required on inpaint variants; optional nullable on tiling. P: white regenerates, black preserves. Tiling mask requires image_url in prose, not a schema conditional. No V4 mask byte cap, format enumeration, binary-only requirement, equal-dimensions constraint, soft-mask/alpha semantics or exact pixel-preservation guarantee is established. Align source/mask in a previewed app raster pipeline as an app rule; do not borrow V3's documented equal-dimensions rule as V4 evidence. |
| strength | Number 0–1. Image-to-image default 0.8: increasing values increases transformation; 1 disregards source content according to prose. Inpaint default 1: full regeneration within mask; smaller values retain more original content. Tiling default 0.8, used only with source. Never reuse V3 remix's label as though its direction were identical. |
| loras | Optional array default [], maximum 3. Each entry requires path string; scale number 0–4 defaults 1. Path describes V4 `.safetensors` weights. No minItems, file-size/checksum/rank limit or mixing/order rule is declared. App's adapter operation requires ≥1 selected adapter; record immutable weights identity, scale and order. |
| tiling_mode | both/horizontal/vertical, default both, only tiling routes. Controls matching of opposite edges; not outpainting or a larger-canvas operation. Source/mask are optional; image_size excludes auto even with source. |

Source: endpoint-specific [V4 schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=ideogram/v4), [Instant schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=ideogram/v4/instant), [editing schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=ideogram/v4/image-to-image), [inpaint schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=ideogram/v4/inpaint), [LoRA schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=ideogram/v4/lora), [tiling schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=ideogram/v4/tiling); all captured versions identified in appendix.

### Sizing is endpoint-specific

Shared ImageSize object has optional integer width/height, each default 512 and `0 < value <= 14142` (S); object `{}` therefore passes declared constraints. The preset enum is square_hd, square, portrait_4_3, portrait_16_9, landscape_4_3, landscape_16_9. Exact preset pixel sizes should not be inferred from their names. The [common arguments documentation](https://fal.ai/docs/documentation/model-apis/model-arguments) supplies common conventions, but endpoint/model sizing remains authoritative and output dimensions must be measured.

Base and text LoRA (including their stream requests) default square_hd; x-fal metadata says each side 512–3840, multiples of 16 (M). Instant/Fast default square_hd with each side 512–2048, multiples of 16 (M). Dedicated editing and corresponding stream routes add auto and default auto; prose says match source, capped approximately 25MP and 8192 pixels per side (P). Their generic nested ImageSize bounds remain 14142 and have no endpoint x-fal size bounds. Tiling defaults square_hd, excludes auto, and has no x-fal dimensional limits in its captured size property. Do not apply base metadata to tiling silently. No exact 25MP rounding/crop/downscale algorithm is specified. Separate S validation from M/P advisory constraints and disclose any proposed resizing before submission.

## Accepted compatibility audit and full capability map

| Accepted v1 row | Evidence outcome | Routing consequence |
| --- | --- | --- |
| Generate image → base, no source/mask/adapters | Confirmed fields and required prompt | Preserve |
| Instant → prompt only, no speed/acceleration/Large | Confirmed | Preserve; explicit switch to eligible edit route if source/mask intended |
| Transform/variations → image-to-image | Confirmed one required source, strength 0–1 | Preserve |
| Masked edit → inpaint | Confirmed required source+mask; white/black prose | Preserve |
| Adapter generation → /lora | Confirmed ≤3 and scale 0–4; empty list provider-valid | Preserve app ≥1 policy |
| Training → /trainer | Confirmed archive request and two File outputs | Preserve later phase |
| Source/mask + Instant | No declared source/mask fields in Instant | Preserve draft, explain incompatibility, never discard inputs |
| Former source/mask + LoRA gap | Superseded by independently verified dedicated editing LoRA schemas and the compatibility evidence addendum | Explicit source+adapters → /image-to-image/lora; source+mask+adapters → /inpaint/lora; validate the complete payload |
| Mask without source | Required-source schemas and tiling prose support rejection | Preserve |
| Multiple independent reference images | No V4 reference-list field found | Preserve single selection or explicit composite; not equivalent conditioning |
| Extend canvas/outpaint | No dedicated outpaint field/route in captured set | Candidate pad+mask+inpaint; seams, dimensions and preserved area need validation |
| Upscale | No dedicated V4 upscale schema discovered | Gap in verified V4 set; comparison only, no older-model fallback |
| Native negative/style/palette controls | No dedicated outer fields in captured V4 request schemas | API-1.2 documents model-caption style/palette fields serialized within prompt; negative_prompt remains absent. Nested caption controls and app prompt-writing aids are distinct. |
| Rerun/variations | Explicit eligible operation can be repeated with chosen settings | Preserve provenance; no exact-pixel seed promise |

Every request must freeze operation, endpoint, source/mask/adapter versions and settings at submission. Inputs merely visible in the document are not automatically attached. Keep incompatible drafts and per-operation settings, but exclude inactive settings from the actual request. No model switch silently resizes, downgrades expansion, drops context, or chooses a comparator.

| Kickoff capability | Disposition and evidence boundary |
| --- | --- |
| Generation | Direct V4 base, Instant and Fast accepted for initial editor |
| Image-to-image | Direct V4 source transformation |
| Inpaint | Direct V4 source+mask |
| Outpaint | Candidate composed workflow only, not validated by presence of inpaint or tiling |
| Upscale | Absent from verified V4 set; `fal-ai/ideogram/upscale` comparison-only |
| Remix / variations | Direct V4 source transform or explicit rerun; adjacent remix comparison tests differing strength semantics |
| Source reference | One source on editing routes; not a generic reference role |
| Style reference | Dedicated style-reference conditioning absent in V4 set; prompt aids or trained LoRA are different mechanisms; V3 style image lists comparison-only |
| Character reference | Dedicated character reference fields absent in V4 set; character endpoints comparison-only; LoRA subject training does not establish identity guarantees |
| Multiple references | Independent conditioning absent; explicit raster compositing is candidate app input preparation |
| Prompt/style/palette controls | Prompt and expansion direct; model-caption style/palette conventions documented in API-1.2. No dedicated outer style/palette/negative_prompt fields; Fal forwarding fidelity is runtime-unverified. |
| Instant | Direct accepted endpoint; no contextual editing inputs |
| LoRA inference | Direct text LoRA and dedicated source/mask LoRA APIs; corrected compatibility addendum maps the explicit operations |
| LoRA training | Direct trainer API, implementation deferred; full contract below |
| Transparency | Family marketing claims native transparency; no alpha/transparency request field or declared alpha output contract found. Capability unresolved/deferred; PNG option alone insufficient |
| Layers / editable text | Native editable text is required initially in the app. No V4 layered output contract found; structured caption text describes raster intent, not editable output. Preserve app-owned text/layers/history. V3 layerize-text comparison-only. See API-1.2. |
| Seamless textures | Newly discovered direct tiling family; product adoption deferred, does not prove outpainting |

Transparency/layer claims: [official family page](https://fal.ai/ideogram-4). The V3 layerize comparison was added through the official Ideogram catalog because it tests whether layered output belongs in the generic image-output abstraction. No V2/non-Ideogram comparator was needed to establish an additional boundary.

## Adjacent comparison contracts

These models inform capability/adapter design; none is an authorized editor fallback. Their full schemas, nested fields and examples appear in the same appendix as V4.

| Comparator | Boundary tested |
| --- | --- |
| fal-ai/ideogram/v3 | Prompt, negative_prompt, boolean expand_prompt, native style/style_preset/style_codes, style image URLs and color_palette differ from V4 expansion enum and serialized model-caption style/palette conventions documented in API-1.2. Count is 1–8, not V4 1–4. |
| /v3/edit | Prompt+source+mask. Prose explicitly requires same source/mask dimensions. Tests operation-specific raster preparation, not a transferable V4 payload rule. |
| /v3/remix | Prompt+source; strength 0.01–1 default 0.8 is described as source-image strength. Do not map direction/default blindly onto V4 denoising-style transformation strength. |
| /v3/reframe | Requires source and target image_size, no required prompt; dedicated reframing abstraction, not proof of a V4 outpaint endpoint. |
| /v3/replace-background | Requires prompt+source, no mask; tests semantic background replacement versus user-selected inpaint mask. |
| /character | Requires prompt+reference_image_urls; dedicated identity reference separate from optional style image_urls. |
| /character/edit | Adds required source+mask alongside required character references; tests multiple input roles. |
| /character/remix | Source transformation plus identity conditioning; distinct reference list and strength contract. |
| /upscale | Required source; optional nullable prompt default empty, detail/resemblance integers 1–100 default 50, expand_prompt false. No scale-factor field; do not invent a 2×/4× control. |
| /v3/layerize-text | Required graphic source; optional prompt/seed and font overrides. Returns background File, actual prompt, seed, optional structured text/HTML/image layers. Tests a document-like output boundary beyond flat images. |

V3/character style references `image_urls` are optional nullable arrays of strings; prose limits combined style inputs to 10MB and JPEG/PNG/WebP. Character `reference_image_urls` is a required array but has no schema min/max items; prose says only its first image is used, with others ignored, and gives a 10MB combined character-reference constraint. Optional non-null `reference_mask_urls` arrays have analogous prose. These are comparator-specific rules; no 10MB cap is transferred to V4 source, mask or ZIP inputs. `style_codes` describes eight-character hexadecimal codes and conflicts with style/reference images; length/pattern/exclusion are prose, not schema keywords, and the prose uses `style_reference_images` although the exposed field is `image_urls`. Keep that naming inconsistency visible.

ColorPalette has optional nullable `name` preset or optional nullable `members`; prose demands choosing one representation, but schema has no oneOf. Members require nested `rgb` object with r/g/b integer 0–255 defaults 0; weight is optional nullable number 0.05–1 default 0.5. Prose mentions hexadecimal colors while the declared object uses integer RGB channels: serialize the declared object, not hex strings. The full preset/style enums are preserved in the appendix. Fields vary between variants; do not assume style_preset, style or negative_prompt exists on every edit route.

All nine image comparators return required images array of File and integer seed, without V4's required output prompt/timings/safety arrays. Layerize instead requires image File, prompt string, seed integer; optional nullable text_html string and text_containers array of unspecified objects, plus optional non-null image_layers array of unspecified objects. Font name and file URL are mutually exclusive per h1/h2/body/small role in prose. Source JPEG/PNG/WebP up to 10MB is its prose contract. Nested text/container/layer properties are not enumerated: do not invent an editable document schema or render returned HTML as trusted app code. [V3 schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/ideogram/v3), [character schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/ideogram/character), [layerize schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/ideogram/v3/layerize-text).

## Training and adapter lifecycle

`ideogram/v4/trainer` accepts six fields. `images_data_url` is required string naming a ZIP of images/captions; `steps` integer 100–40000 default 1000; `learning_rate` number 0.000001–0.01 default 0.0001; `default_caption` optional string/null with no declared default; `resolution` string default auto; `output_lora_format` fal/comfy default fal. It does not require a generation prompt or accept inference sizing/output controls. [Trainer schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=ideogram/v4/trainer), [trainer guide](https://fal.ai/models/ideogram/v4/trainer/llms.txt).

Dataset P contract: target-only dataset prepared by `prepare_dataset_dir`; captions come from `.txt` files with the same stem as each image. `default_caption` fills missing captions. Prose mentions `force_default_caption` overriding existing captions, but **no such request field exists**. Do not send it. If the app offers replacing all captions, that must be explicit ZIP preparation with previewed dataset changes. No documented archive-size cap, image-count range, allowed image extensions, nested-directory rule, caption encoding/length, duplicate-stem behavior or missing-caption behavior when default_caption is absent/null was found in the captured trainer schema/guide. These remain provider questions, not arbitrary client limits advertised as provider rules. Defensive archive handling, app workload caps and content checks belong to downstream design and must be labelled app policy.

Resolution P contract: auto chooses the largest crop common to the dataset without enlarging images; processing uses centered crops. Presets: square 1024×1024; landscape 1536×1024; portrait 1024×1536; widescreen 1920×1088; ultrawide 2048×768; phone_wallpaper 1024×1792; social_banner 1584×400. Custom `WIDTHxHEIGHT` requires both dimensions divisible by 16 in prose. Schema itself is unconstrained string; no regex, enum, max pixels, size minimum or dataset-specific resolution feasibility bound is declared. Require a crop preview in future UX; never suggest auto preserves every edge.

Outputs are required `diffusers_lora_file: File` and `config_file: File`. The latter is described as public training configuration. The weights field retains its name regardless of fal/comfy naming format; that name does not prove arbitrary Diffusers compatibility. LoRA inference specifically requests Ideogram V4 `.safetensors`. Prefer fal output for the fal inference path as a proposed interoperability choice; verify actual adapter acceptance, tensor names, and Comfy compatibility separately. V3, SDXL, Flux or other-family adapters are not established compatible. No rank, trigger-word, trainer-version, resume-checkpoint or optimizer-state output is declared.

Proposed durable workflow boundary: archive and dataset manifest/captions/crops → immutable training submission → persisted provider request ID → polling/reconciliation → copy weights and config into durable owned storage → register adapter with content hashes, training parameters, dataset identity and source endpoint → select explicit adapter version/scale for inference. Keep config and weights together; a provider URL alone is not durable ownership. CDN lifecycle controls apply to files generally, but trainer-specific retention exceptions were not documented. Download both outputs promptly, retain the original source URLs and capture time, and reconcile jobs completed while the browser/backend was offline. Failure or cancellation must not register an adapter as usable. No training duration, percentage cadence, per-step logs, resume support or partial-weights recovery guarantee has been verified. Queue logs are observations, not a numerical training progress contract.

## Transport, auth and local integration

Use a localhost backend that reads FAL_KEY from its environment; preserve that boundary when injecting a deployment secret. Provider HTTP uses `Authorization: Key <secret>`; JSON requests use Content-Type application/json. Browser sends app commands and uploads to the backend, not the provider credential. Do not persist secrets, signed URL credentials or full authorization headers in events/logs. Public SDK examples support `@fal-ai/client` and Python `fal_client`; these are conventions, not a pinned installed SDK version. [Auth/setup](https://fal.ai/models/ideogram/v4/api).

### Queue paths and lifecycle

For each endpoint E in the appendix, captured S wrapper uses server `https://queue.fal.run`: POST `/E` with required JSON Input → HTTP 200 QueueStatus; GET `/E/requests/{request_id}/status` → 200 QueueStatus; PUT `/E/requests/{request_id}/cancel` → 200 object with optional boolean success; GET `/E/requests/{request_id}` → 200 endpoint Output. request_id is required string path parameter; status logs is optional number, prose 1/0. Security is Authorization header apiKeyAuth. No schema error responses are provided.

Protocol P docs instead give returned response/status/cancel URLs and examples with `/response` on the result URL. Use the provider-returned URLs or tested SDK route normalization, not guessed concatenation. Persist request_id plus endpoint and returned URLs immediately. States are IN_QUEUE, IN_PROGRESS, COMPLETED; COMPLETED can include failure. Fetch/validate result before app success. Queue position counts ahead, not time. `metrics.inference_time` is seconds. [Queue protocol](https://fal.ai/docs/documentation/model-apis/inference/queue).

QueueStatus S declares required status enum and request_id; optional response_url/status_url/cancel_url strings, queue_position integer, and open objects logs/metrics. Official protocol examples have logs as an array of entries, not the wrapper's object; failed status adds error/error_type absent from the wrapper's property list. Use a tolerant protocol adapter and retain unknown fields; do not treat this generated wrapper as the complete runtime status/error schema. Cross-source path/log/cancel conflicts require an opt-in integration check before implementation is declared working.

JavaScript queue.submit returns snake-case request_id; subsequent status/result/cancel calls use requestId and input endpoint string. Results from subscribe/result use `{data, requestId}`. `logs: true`, `onQueueUpdate`, `streamStatus` provide observations; Python uses arguments, request handles, with_logs and submit_async/iter_events variants. `subscribe` waits through the queue; `run` is direct inference. Preserve a durable job record rather than relying solely on a long-lived subscribe call. [JS queue reference](https://fal.ai/docs/api-reference/client-libraries/javascript/queue), [endpoint SDK examples](https://fal.ai/models/ideogram/v4/api).

### Three distinct meanings of streaming/sync

1. Queue status SSE: GET returned status path plus `/stream?logs=1`, or JS queue.streamStatus; events carry queue status. Python iter_events is described as polling. This is not a generated-image stream.
2. Model stream: direct POST to `https://fal.run/E/stream` for a supported E, usually SDK `fal.stream(E, …)`; it bypasses the queue. Six V4 stream routes were discovered. Their generated queue schemas have empty output schema `{}` and omit num_images. Exact event types, preview encoding, ordering, final-result shape, reconnection and safety timing are unspecified; do not promise progressive images from a generic streaming badge. Do not pass E already suffixed /stream without checking the SDK's path behavior.
3. `sync_mode` is an image representation/storage input, independent of either transport. Inline base64 does not mean a synchronous queue or progressive previews.

The streaming guide says direct streaming has no queue retries and describes some unsupported SDK options; the platform headers page says infrastructure headers apply across methods. Verify the chosen SDK version's streaming signature before relying on custom headers. Queued finished results are the accepted initial local policy. [Streaming protocol](https://fal.ai/docs/documentation/model-apis/inference/streaming).

### Retries, deadlines, uncertain submission and cancellation

Separate retries by owner. Provider queue retries transient runner failures; reliability prose says up to ten retries while headers prose says ten total attempts. Do not promise an exact attempt count without reconciliation. Concurrency requeues have a separate unbounded policy subject to start deadline. SDK/network/upload retry logic is another layer; JS retry APIs expose maxRetries/backoff/status/jitter options, and user-induced timeout 504s are non-retryable. An app retry of submission is a new potentially billable attempt. No provider submission-idempotency key guarantee was found. A lost acknowledgement is **submission uncertain**, not failed-before-start: persist attempt identity and any received request header/ID, reconcile if possible, and require an explicit new-attempt choice when duplication cannot be excluded. Replaying saved document history makes no submissions. [Reliability](https://fal.ai/docs/documentation/model-apis/inference/reliability), [JS retries](https://fal.ai/docs/api-reference/client-libraries/javascript/retry).

`X-Fal-Request-Timeout` / JS startTimeout / Python start_timeout is a time-to-start deadline in seconds; no default deadline. It includes wait and failed-attempt elapsed time but does not cap successful inference duration. Python client_timeout limits subscribe's waiting, not provider execution; abort/disconnect similarly does not prove termination. Provider per-attempt runtime limits are configured by the model app; do not advertise the generic 3600-second serverless default as the V4 trainer SLA. `X-Fal-No-Retry: 1` requests disabling automatic retries; X-Fal-Retry-Config is documented as ignored for shared/public model APIs. `x-app-fal-disable-fallback: true` should be included in the proposed backend contract to uphold explicit model routing; provider fallback is otherwise enabled for supported models. Applicability to V4 is unverified. [Platform headers](https://fal.ai/docs/documentation/model-apis/common-parameters).

Cancellation protocol P: PUT cancel yields 202 CANCELLATION_REQUESTED; 400 ALREADY_COMPLETED; 404 NOT_FOUND. Queued work is removed; in-progress cancellation depends on runner support and can race with completion. This differs from generated wrapper's 200/success schema. Maintain cancel-requested separately from confirmed terminal outcome. Retain late/duplicate/out-of-order results for reconciliation with frozen job identity and target version; do not overwrite current canvas or discard evidence solely because cancel was requested. Completed provider work and user adoption are separate events. No refund/cessation guarantee follows from 202. [Cancel behavior](https://fal.ai/docs/documentation/model-apis/inference/queue#cancel-a-request).

### Webhooks, retention and uploads

Localhost uses backend polling with durable restart reconciliation. Provider cannot deliver to loopback/private webhook addresses. Hosted deployment may add webhooks, with polling recovery retained. Webhook statuses OK/ERROR differ from queue states; store request_id and gateway_request_id (the latter can identify the last retried attempt). Payload may be null with payload_error. Verify ED25519 using fal JWKS, raw body SHA-256, request/user/timestamp/signature headers and documented clock tolerance. Acknowledge after durable receipt; deduplicate by request ID and output identity. Docs specify 15-second initial delivery timeout, 120 seconds for retries, up to 31 retries until stored result expiry; redirects and private-IP targets are permanent failures. Stored result delivery window is about one hour, or six minutes for ≥10KB results; >1MB or storage-disabled results may only remain retrievable until that expiry. These are result-delivery/cache windows, not the media lifetime or ordinary 30-day JSON history. [Webhook contract](https://fal.ai/docs/documentation/model-apis/inference/webhooks).

Request JSON history defaults to 30 days; `X-Fal-Store-IO: 0` disables that payload storage without deleting generated CDN files. CDN retention is configurable; platform headers describe unconfigured account default as forever/public, not a durability promise. `X-Fal-Object-Lifecycle-Preference` accepts expiration_duration_seconds (null means no expiration) and initial_acl. Expired files cannot be recovered; archive required results locally. Completed-request payload deletion also deletes associated output files but not reused input files. Do not equate queue cache, payload history, CDN lifecycle, ACL/signed URL expiry and owned editor storage. [Retention](https://fal.ai/docs/documentation/model-apis/media-expiration), [lifecycle headers](https://fal.ai/docs/documentation/model-apis/common-parameters).

File inputs accept provider-readable hosted URLs, presigned URLs or base64 data URIs. A storage upload yields a URL; some SDK binary inputs auto-upload. CDN docs describe no upload-level file-type restriction, with model-specific checks later. Current prose: 10MB multipart chunks; JS threshold 90MB/sequential chunks; Python threshold 100MB/up to ten parallel chunks; transient upload retries and fallback hosts are separate from inference retries. These are SDK transfer thresholds, **not V4 model payload limits**. Data URI expansion increases bytes approximately by 4/3 plus prefix/JSON overhead; stage large source/mask/archive files rather than persist base64 in event logs. Upload/file ACL and lifetime must allow the provider's deferred fetch; exact V4 fetch timing is unknown. [CDN/upload guide](https://fal.ai/docs/documentation/model-apis/fal-cdn).

### Errors and capacity

Model errors use detail arrays with loc/msg/type/url and optional ctx/input; docs warn migration is incomplete. Infrastructure errors use detail string plus error_type and X-Fal-Error-Type. Handle both plus malformed/non-JSON responses without parsing human text. Validate input errors locally where possible; prompt/mask/media policy failures require changed inputs, not retry storms. Preserve sanitized diagnostic codes/request IDs. Distinguish 401/403 credential/permission failures, 422 input failures, 429 concurrency/rate signals, transient 5xx, network uncertainty, expired/missing result, and cancelled job. Exact V4-specific error enumerations remain untested. [Model errors](https://fal.ai/docs/documentation/model-apis/errors), [request errors](https://fal.ai/docs/documentation/model-apis/request-errors).

Published account concurrency starts at two, scales by paid-invoice history up to forty self-serve, and may have endpoint-specific caps. This is not the user's measured allocation. Only IN_PROGRESS consumes that allocation; queued work waits. Direct requests can receive 429 concurrent_requests_limit with X-Fal-needs-retry: 1; queue dispatch handles capacity retries. No fixed public V4 requests-per-minute limit was established. Do not set app concurrency to forty automatically or convert queue position into an ETA. Record current account allocation during future opt-in setup. `fal_max_queue_length` is an optional queue query guard returning 429 beyond chosen global endpoint queue length; it is not an image parameter. [Concurrency](https://fal.ai/docs/documentation/model-apis/concurrency-limits).

## Pricing evidence and workload handoff

Prices below are published observations on 2026-09-25, not incurred spend or a binding quote. Endpoint-specific linked llms guides are the sources; raw guide hashes accompany schema evidence. Costs for expansion, exact billing-area rounding, batched outputs, failed/cancelled attempts and direct stream routes need future confirmation. Capture provider X-Fal-Billable-Units and usage records when authorized; do not infer actual spend solely from input dimensions.

| Endpoint(s) relative to V4 | Published unit and USD rate |
| --- | --- |
| base; /image-to-image | Per megapixel TURBO .0075, BALANCED .015, QUALITY .025 |
| /instant | Per megapixel .0075 |
| /fast | Per megapixel TURBO .00525, BALANCED .0105, QUALITY .0175 |
| /lora; /image-to-image/lora | Per megapixel TURBO .01125, BALANCED .0225, QUALITY .0375 |
| /tiling | Per megapixel TURBO .03, BALANCED .06, QUALITY .10 |
| /tiling/lora | Per megapixel TURBO .03375, BALANCED .0675, QUALITY .1125 |
| /inpaint | Guide says .01 per image; no detailed size/tier schedule there |
| /inpaint/lora | Guide says .015 per image; no detailed size/tier schedule there |
| all six /stream routes | Generated guides say $0 per compute second; treat as unresolved publication metadata, not evidence streaming is free |
| /trainer | .00675 × steps; 1000-step published example $6.75 |

Base/Fast/LoRA/Instant pricing examples treat 2048×2048 as four billed megapixels. That is not literal decimal width×height/1,000,000; rounding or 1024² units require clarification before a precise estimator. Expansion None is described as avoiding expansion fee; no verified numeric Medium/Large surcharge is captured. Do not reuse base price across inpaint or tiling. [Base pricing guide](https://fal.ai/models/ideogram/v4/llms.txt), [trainer pricing](https://fal.ai/models/ideogram/v4/trainer/llms.txt), [inpaint pricing guide](https://fal.ai/models/ideogram/v4/inpaint/llms.txt), [stream guide](https://fal.ai/models/ideogram/v4/stream/llms.txt).

Comparisons: five V3 generation/edit/remix/reframe/background guides quote TURBO .03, BALANCED .06, QUALITY .09 per request in prose, without explaining batch multiplication; three character guides .10/.15/.20 respectively. Upscale guide .06 per image; layerize .09 per image. These are distinct units and output structures, not V4 budget substitutes. Every endpoint's pricing-guide source is listed in the appendix.

### Task 6: numerical workload inputs, not app budgets

| Workload dimension | Evidence or explicit derived estimate |
| --- | --- |
| Batch count | Ordinary V4 request 1–4 outputs; stream has no num_images field; comparators 1–8 where declared |
| Base/LoRA custom size | M: 512–3840 per side, multiple 16. 3840² = 14,745,600 pixels; one decoded RGBA8 raster = 58,982,400 bytes (56.25MiB), four = 225MiB, excluding copies/GPU/undo |
| Instant/Fast custom size | M: up to 2048² = 4,194,304 pixels; RGBA8 = 16MiB each, 64MiB for four |
| Editing auto | P: approximately 25MP and ≤8192 per side. About 100,000,000 bytes (95.4MiB) per decoded RGBA8 output at 25 million pixels; four about 381.5MiB. This is a scenario estimate, not an exact provider cap |
| Generic ImageSize ceiling | S: 14142² = 199,996,164 pixels; not a V4 runtime promise. Never use this generic bound as an implicit safe editor allocation |
| Source+mask workload | At least one source raster and one aligned mask for inpaint; add candidate results, previews and copies. Mask representation is app-defined; byte use is not automatically RGBA |
| LoRA | ≤3 adapters, scales 0–4. Adapter byte limit/load cost/cache behavior not specified |
| Tiling | No endpoint M size caps captured; app must choose bounded test sizes and call them app assumptions |
| Training | ZIP bytes/image count unknown; steps 100–40000, rate 1e-6–1e-2, crop presets/custom multiples of 16. No wall-time or peak-memory claim |
| Network | URL submission small versus actual upload/download; base64 ≈4/3 expansion. SDK multipart thresholds are transfer mechanics, not endpoint caps |
| Capacity/lifecycle | Account-specific concurrency, uncertain provider latency, bounded result retrieval window, configurable CDN retention; measure upload, local validation, submit acknowledgement, queue wait, execution, download, decode and adoption separately |

Task 6 should set app budgets over declared fixtures, target hardware and percentile policy; avoid inventing mask/ZIP caps or training durations. Include peak decoded-memory stress, four-result batches, cancellation races, expired URLs, inline versus hosted outputs, and offline training-result reconciliation. Dedicated LoRA editing follows the corrected compatibility addendum; Fast is accepted initially and tiling remains later. No performance measurements were made.

## Task 5: schema-driven cases and opt-in contract checks

The appendix supplies illustrative valid request/response per endpoint, including required output metadata missing from published examples. URLs are placeholders, not callable fixtures. Valid means declared structural constraints only. Build tests against captured hash identities, with separate S, M, P and app-policy assertions.

| Case | Expected layer/result |
| --- | --- |
| Each of 27 endpoint requests and declared responses in appendix | S-valid examples; stream output unconstrained, not a known usable result |
| Remove each required property, send null to each non-null field, wrong primitive/array item type | S-invalid, per endpoint and nested schema; optional ≠ nullable |
| V4 num_images 1 and 4 vs 0/5/fractional | S-valid boundaries / invalid values |
| V3/character num_images 8 vs 9 | Comparator S boundary; prevents V4 shared-limit reuse |
| Instant/Fast expansion Large; Instant rendering_speed or source/mask | Large S-invalid; undeclared fields app allowlist-invalid (not necessarily generic-schema-invalid) |
| Base custom 512²/3840² vs Instant 3840² | Both may pass generic S; Instant violates M. Explain rather than silently resize |
| Custom width 0/14143/fraction vs width 1/14142; missing width/height | S-invalid vs S-valid; {} valid by S, not runtime proof |
| image_size auto on base/tiling/Instant vs editing | S-invalid vs S-valid; default editing auto retained |
| Strength 0/1 vs -.01/1.01, and comparator remix 0 | V4 boundaries valid; out-of-range invalid; comparator remix 0 invalid (min .01) |
| loras []/3 entries vs 4, scale 0/4 vs -1/4.01, missing path | Empty/3/boundaries S-valid; ≥1 required by app adapter operation; others S-invalid |
| Source+mask+loras on new inpaint/lora; source+loras on new image-to-image/lora | S-valid documented combinations; route explicit matching operations under the corrected compatibility addendum |
| Mask without source on inpaint vs tiling | Inpaint S-invalid; tiling P-invalid although S permits nullable independent properties |
| Trainer steps 100/40000 vs 99/40001; rate 1e-6/.01 vs outside | S-boundary cases |
| Trainer resolution 1024x1024 vs 1025x1024 | Both S strings; latter P-invalid divisibility; no invented pixel maximum |
| force_default_caption supplied | Undeclared field rejected by app allowlist; prose/schema conflict remains |
| Palette name+members; style+style_codes; two character refs | S may permit; comparator prose exclusivity/first-reference-only rules need separate tests |
| Layerize font name+URL for same role | S may permit; prose forbids |
| V4 response missing prompt/seed/timings/safety; nullable File metadata; wrong timings value type | Missing required/incorrect type invalid; nullable optional metadata valid |
| Queue logs object versus official array, cancellation 200 versus 202, result URL /response versus wrapper path | Protocol adapter fixtures must cover documented variants; opt-in request needed to settle actual V4 behavior |
| Lost submission ack, browser/server restart, duplicate webhook/poll results, out-of-order queue snapshots, stale/deleted target, cancel-complete race, expired media | App recovery semantics; no repeated paid call during replay, no stale canvas overwrite |
| Trainer success while offline; only one output downloaded; corrupt/incompatible weights | Do not mark adapter usable until both durable outputs and registration checks succeed |

Future paid/credentialed verification is **opt-in, not completed research**: runtime unknown-field handling; endpoint sizing/rounding and presets; V4 mask dimensions/grayscale/alpha/preservation; strength endpoints and source content behavior; LoRA format/version interoperability and ordered composition; archive/caption edge cases; direct stream event/final/safety contract; actual queue normalization/status/cancel behavior; output retention/expiry and sync_mode; pricing units/expansion/stream charges; seed repeatability; training logs/duration/cancellation and downloadable outputs. Obtain explicit authorization and bounded fixtures/spend before any such calls. Mock/network fixture tests establish app behavior, not provider compliance.

## Open evidence register and handoff

| ID | Unresolved matter | Owner / next action |
| --- | --- | --- |
| API-U01 — resolved evidence correction | Original LoRA editing gap contradicted by new schemas | Coordinator independently verified matching hashes and corrected compatibility addendum; API-1.1 now reflects dedicated routes while preserving explicit input selection |
| API-U02 | M/P size limits differ from generic S, presets/auto rounding unknown | API implementor + Task 5 design opt-in boundary checks; Task 6 uses labelled workload assumptions |
| API-U03 | Stream output schemas empty and generated $0 pricing | API implementor/provider clarification before exposing preview or charging estimates |
| API-U04 | Queue wrapper differs from official protocol paths/logs/cancel schema | SDK-version audit and controlled contract check; don't hide mismatch |
| API-U05 | Trainer force_default_caption missing; archive/caption/format limits unknown | Provider clarification; app preparation rules remain labelled and explicit |
| API-U06 | Transparency/layer marketing exceeds V4 schema contract | Defer claims; product-owned layers remain separate |
| API-U07 | Billing megapixel units, batch/expansion/cancel costs and inpaint schedule | Future opted-in price/usage reconciliation; no spend occurred |
| API-U08 | Model version, runtime limits, rate allocation, deterministic seed behavior | Preserve evidence revision; no SLA or reproducibility guarantee |
| API-U09 | Webhook result windows differ from history/media lifetime | Task 4 durable polling/download design; Task 6 retrieval-window fixtures |

This reference covers R02 discovery/all-schema verification, R03 endpoint differences, R05 capability/routing boundary, R10 transport lifecycle and R12 trainer depth. It is a documentation result, not provider certification or a verified application. Independent verifier should inspect the field appendix against every endpoint hash, specifically the corrected LoRA editing evidence and empty stream response schemas. The original audit changed no repository files and ran no provider calls. This assembly supplies the documentation mirror; historical receipts remain in the frozen source.



## Appendix A — complete captured schema contracts

The following tables are generated from every captured schema, without sampling. `R` means required; `O` means omission is allowed. Null is allowed only where the constraint JSON explicitly contains `type:null`; omission never implies nullability. A missing default/bound/format is unspecified, not zero/unlimited runtime permission. All unlisted validation constraints are absent from the captured property. `$ref` names resolve to the nested definitions in Appendix B. Standard JSON constraints (S) and `x-fal` metadata (M) are both preserved. Field semantics, units and prose-only relationships are above. All examples are authored illustrations, use placeholder URLs, and were checked structurally without a provider call.


<a id="a01"></a>

### A01. ideogram/v4

[Schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=ideogram/v4) · [Guide / pricing](https://fal.ai/models/ideogram/v4/llms.txt). Retrieved 2026-09-25 UTC; OpenAPI `3.0.4`; info.version `1.0.0`. Raw schema SHA-256 `d83cf73ad6afecb49c2c1c094e8876674d0b844d0c1bda93b8ec804026653806`.

Input component `V4Input`; output component `V4Output`.

**Request** (`object`); no object-level conditional constraints or additionalProperties restriction declared.

| Field | Presence | Complete property constraints (S; x-fal is M) |
| --- | --- | --- |
| `prompt` | R | `{"type":"string"}` |
| `expansion_model` | O | `{"enum":["None","Medium","Large"],"default":"Medium","type":"string"}` |
| `image_size` | O | `{"default":"square_hd","anyOf":[{"$ref":"#/components/schemas/ImageSize"},{"enum":["square_hd","square","portrait_4_3","portrait_16_9","landscape_4_3","landscape_16_9"],"type":"string"}],"x-fal":{"multiple_of":16,"min_height":512,"max_height":3840,"max_width":3840,"min_width":512}}` |
| `rendering_speed` | O | `{"enum":["TURBO","BALANCED","QUALITY"],"default":"BALANCED","type":"string"}` |
| `acceleration` | O | `{"enum":["none","low","regular","high"],"default":"none","type":"string"}` |
| `num_images` | O | `{"minimum":1,"maximum":4,"type":"integer","default":1}` |
| `seed` | O | `{"anyOf":[{"type":"integer"},{"type":"null"}]}` |
| `sync_mode` | O | `{"default":false,"type":"boolean"}` |
| `enable_safety_checker` | O | `{"default":true,"type":"boolean"}` |
| `output_format` | O | `{"enum":["jpeg","png"],"default":"jpeg","type":"string"}` |

**Response** (`object`); no object-level conditional constraints or additionalProperties restriction declared.

| Field | Presence | Complete property constraints (S; x-fal is M) |
| --- | --- | --- |
| `images` | R | `{"items":{"$ref":"#/components/schemas/ImageFile"},"type":"array"}` |
| `timings` | R | `{"type":"object","additionalProperties":{"type":"number"}}` |
| `seed` | R | `{"type":"integer"}` |
| `has_nsfw_concepts` | R | `{"items":{"type":"boolean"},"type":"array"}` |
| `prompt` | R | `{"type":"string"}` |

**Illustrative request (not submitted):**
```json
{
  "prompt": "A blue paper bird on a cream background"
}
```
**Illustrative response**:
```json
{
  "images": [
    {
      "url": "https://example.org/result.png"
    }
  ],
  "timings": {},
  "seed": 42,
  "has_nsfw_concepts": [
    false
  ],
  "prompt": "A blue paper bird on a cream background"
}
```

<a id="a02"></a>

### A02. ideogram/v4/fast

[Schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=ideogram/v4/fast) · [Guide / pricing](https://fal.ai/models/ideogram/v4/fast/llms.txt). Retrieved 2026-09-25 UTC; OpenAPI `3.0.4`; info.version `1.0.0`. Raw schema SHA-256 `a6db6ca26a594018c8ad9315d46e09e30a42d18b2483a412502c1a1943e5c91e`.

Input component `V4FastInput`; output component `V4FastOutput`.

**Request** (`object`); no object-level conditional constraints or additionalProperties restriction declared.

| Field | Presence | Complete property constraints (S; x-fal is M) |
| --- | --- | --- |
| `prompt` | R | `{"type":"string"}` |
| `expansion_model` | O | `{"enum":["None","Medium"],"default":"Medium","type":"string"}` |
| `image_size` | O | `{"default":"square_hd","anyOf":[{"$ref":"#/components/schemas/ImageSize"},{"enum":["square_hd","square","portrait_4_3","portrait_16_9","landscape_4_3","landscape_16_9"],"type":"string"}],"x-fal":{"multiple_of":16,"min_height":512,"max_height":2048,"max_width":2048,"min_width":512}}` |
| `rendering_speed` | O | `{"enum":["TURBO","BALANCED","QUALITY"],"default":"BALANCED","type":"string"}` |
| `num_images` | O | `{"minimum":1,"maximum":4,"type":"integer","default":1}` |
| `seed` | O | `{"anyOf":[{"type":"integer"},{"type":"null"}]}` |
| `sync_mode` | O | `{"default":false,"type":"boolean"}` |
| `enable_safety_checker` | O | `{"default":true,"type":"boolean"}` |
| `output_format` | O | `{"enum":["jpeg","png"],"default":"jpeg","type":"string"}` |

**Response** (`object`); no object-level conditional constraints or additionalProperties restriction declared.

| Field | Presence | Complete property constraints (S; x-fal is M) |
| --- | --- | --- |
| `images` | R | `{"items":{"$ref":"#/components/schemas/ImageFile"},"type":"array"}` |
| `timings` | R | `{"type":"object","additionalProperties":{"type":"number"}}` |
| `seed` | R | `{"type":"integer"}` |
| `has_nsfw_concepts` | R | `{"items":{"type":"boolean"},"type":"array"}` |
| `prompt` | R | `{"type":"string"}` |

**Illustrative request (not submitted):**
```json
{
  "prompt": "A blue paper bird on a cream background"
}
```
**Illustrative response**:
```json
{
  "images": [
    {
      "url": "https://example.org/result.png"
    }
  ],
  "timings": {},
  "seed": 42,
  "has_nsfw_concepts": [
    false
  ],
  "prompt": "A blue paper bird on a cream background"
}
```

<a id="a03"></a>

### A03. ideogram/v4/image-to-image

[Schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=ideogram/v4/image-to-image) · [Guide / pricing](https://fal.ai/models/ideogram/v4/image-to-image/llms.txt). Retrieved 2026-09-25 UTC; OpenAPI `3.0.4`; info.version `1.0.0`. Raw schema SHA-256 `44262f4376e55aead06f8b56cfbc8d8f32d240484b06c7c9164f6867184e9fa6`.

Input component `V4ImageToImageInput`; output component `V4ImageToImageOutput`.

**Request** (`object`); no object-level conditional constraints or additionalProperties restriction declared.

| Field | Presence | Complete property constraints (S; x-fal is M) |
| --- | --- | --- |
| `prompt` | R | `{"type":"string"}` |
| `expansion_model` | O | `{"enum":["None","Medium","Large"],"default":"Medium","type":"string"}` |
| `image_size` | O | `{"default":"auto","anyOf":[{"$ref":"#/components/schemas/ImageSize"},{"enum":["square_hd","square","portrait_4_3","portrait_16_9","landscape_4_3","landscape_16_9","auto"],"type":"string"}]}` |
| `rendering_speed` | O | `{"enum":["TURBO","BALANCED","QUALITY"],"default":"BALANCED","type":"string"}` |
| `acceleration` | O | `{"enum":["none","low","regular","high"],"default":"none","type":"string"}` |
| `num_images` | O | `{"minimum":1,"maximum":4,"type":"integer","default":1}` |
| `seed` | O | `{"anyOf":[{"type":"integer"},{"type":"null"}]}` |
| `sync_mode` | O | `{"default":false,"type":"boolean"}` |
| `enable_safety_checker` | O | `{"default":true,"type":"boolean"}` |
| `output_format` | O | `{"enum":["jpeg","png"],"default":"jpeg","type":"string"}` |
| `image_url` | R | `{"type":"string"}` |
| `strength` | O | `{"minimum":0,"default":0.8,"maximum":1,"type":"number"}` |

**Response** (`object`); no object-level conditional constraints or additionalProperties restriction declared.

| Field | Presence | Complete property constraints (S; x-fal is M) |
| --- | --- | --- |
| `images` | R | `{"items":{"$ref":"#/components/schemas/ImageFile"},"type":"array"}` |
| `timings` | R | `{"type":"object","additionalProperties":{"type":"number"}}` |
| `seed` | R | `{"type":"integer"}` |
| `has_nsfw_concepts` | R | `{"items":{"type":"boolean"},"type":"array"}` |
| `prompt` | R | `{"type":"string"}` |

**Illustrative request (not submitted):**
```json
{
  "prompt": "A blue paper bird on a cream background",
  "image_url": "https://example.org/image.png"
}
```
**Illustrative response**:
```json
{
  "images": [
    {
      "url": "https://example.org/result.png"
    }
  ],
  "timings": {},
  "seed": 42,
  "has_nsfw_concepts": [
    false
  ],
  "prompt": "A blue paper bird on a cream background"
}
```

<a id="a04"></a>

### A04. ideogram/v4/image-to-image/lora

[Schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=ideogram/v4/image-to-image/lora) · [Guide / pricing](https://fal.ai/models/ideogram/v4/image-to-image/lora/llms.txt). Retrieved 2026-09-25 UTC; OpenAPI `3.0.4`; info.version `1.0.0`. Raw schema SHA-256 `391081e2e09dbf08d8f7db59e9349d23e4d444a8819f8f01213a7929b5e5e193`.

Input component `V4ImageToImageLoraInput`; output component `V4ImageToImageLoraOutput`.

**Request** (`object`); no object-level conditional constraints or additionalProperties restriction declared.

| Field | Presence | Complete property constraints (S; x-fal is M) |
| --- | --- | --- |
| `prompt` | R | `{"type":"string"}` |
| `expansion_model` | O | `{"enum":["None","Medium","Large"],"default":"Medium","type":"string"}` |
| `image_size` | O | `{"default":"auto","anyOf":[{"$ref":"#/components/schemas/ImageSize"},{"enum":["square_hd","square","portrait_4_3","portrait_16_9","landscape_4_3","landscape_16_9","auto"],"type":"string"}]}` |
| `rendering_speed` | O | `{"enum":["TURBO","BALANCED","QUALITY"],"default":"BALANCED","type":"string"}` |
| `acceleration` | O | `{"enum":["none","low","regular","high"],"default":"none","type":"string"}` |
| `num_images` | O | `{"minimum":1,"maximum":4,"type":"integer","default":1}` |
| `seed` | O | `{"anyOf":[{"type":"integer"},{"type":"null"}]}` |
| `sync_mode` | O | `{"default":false,"type":"boolean"}` |
| `enable_safety_checker` | O | `{"default":true,"type":"boolean"}` |
| `output_format` | O | `{"enum":["jpeg","png"],"default":"jpeg","type":"string"}` |
| `image_url` | R | `{"type":"string"}` |
| `strength` | O | `{"minimum":0,"default":0.8,"maximum":1,"type":"number"}` |
| `loras` | O | `{"items":{"$ref":"#/components/schemas/LoRAInput"},"maxItems":3,"default":[],"type":"array"}` |

**Response** (`object`); no object-level conditional constraints or additionalProperties restriction declared.

| Field | Presence | Complete property constraints (S; x-fal is M) |
| --- | --- | --- |
| `images` | R | `{"items":{"$ref":"#/components/schemas/ImageFile"},"type":"array"}` |
| `timings` | R | `{"type":"object","additionalProperties":{"type":"number"}}` |
| `seed` | R | `{"type":"integer"}` |
| `has_nsfw_concepts` | R | `{"items":{"type":"boolean"},"type":"array"}` |
| `prompt` | R | `{"type":"string"}` |

**Illustrative request (not submitted):**
```json
{
  "prompt": "A blue paper bird on a cream background",
  "image_url": "https://example.org/image.png",
  "loras": [
    {
      "path": "https://example.org/adapter.safetensors",
      "scale": 1
    }
  ]
}
```
**Illustrative response**:
```json
{
  "images": [
    {
      "url": "https://example.org/result.png"
    }
  ],
  "timings": {},
  "seed": 42,
  "has_nsfw_concepts": [
    false
  ],
  "prompt": "A blue paper bird on a cream background"
}
```

<a id="a05"></a>

### A05. ideogram/v4/image-to-image/lora/stream

[Schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=ideogram/v4/image-to-image/lora/stream) · [Guide / pricing](https://fal.ai/models/ideogram/v4/image-to-image/lora/stream/llms.txt). Retrieved 2026-09-25 UTC; OpenAPI `3.0.4`; info.version `1.0.0`. Raw schema SHA-256 `21b8009c6d632817855d4252b4bdb78d10c17be633f36af509f77367bb79983e`.

Input component `V4ImageToImageLoraStreamInput`; output component `V4ImageToImageLoraStreamOutput`.

**Request** (`object`); no object-level conditional constraints or additionalProperties restriction declared.

| Field | Presence | Complete property constraints (S; x-fal is M) |
| --- | --- | --- |
| `prompt` | R | `{"type":"string"}` |
| `expansion_model` | O | `{"enum":["None","Medium","Large"],"default":"Medium","type":"string"}` |
| `image_size` | O | `{"default":"auto","anyOf":[{"$ref":"#/components/schemas/ImageSize"},{"enum":["square_hd","square","portrait_4_3","portrait_16_9","landscape_4_3","landscape_16_9","auto"],"type":"string"}]}` |
| `rendering_speed` | O | `{"enum":["TURBO","BALANCED","QUALITY"],"default":"BALANCED","type":"string"}` |
| `acceleration` | O | `{"enum":["none","low","regular","high"],"default":"none","type":"string"}` |
| `seed` | O | `{"anyOf":[{"type":"integer"},{"type":"null"}]}` |
| `sync_mode` | O | `{"default":false,"type":"boolean"}` |
| `enable_safety_checker` | O | `{"default":true,"type":"boolean"}` |
| `output_format` | O | `{"enum":["jpeg","png"],"default":"jpeg","type":"string"}` |
| `image_url` | R | `{"type":"string"}` |
| `strength` | O | `{"minimum":0,"default":0.8,"maximum":1,"type":"number"}` |
| `loras` | O | `{"items":{"$ref":"#/components/schemas/LoRAInput"},"maxItems":3,"default":[],"type":"array"}` |

**Response:** empty schema `{}` — unconstrained, no documented event/result fields or requiredness.

**Illustrative request (not submitted):**
```json
{
  "prompt": "A blue paper bird on a cream background",
  "image_url": "https://example.org/image.png",
  "loras": [
    {
      "path": "https://example.org/adapter.safetensors",
      "scale": 1
    }
  ]
}
```
**Illustrative response** (structure unknown; this is not a usable stream event):
```json
{}
```

<a id="a06"></a>

### A06. ideogram/v4/image-to-image/stream

[Schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=ideogram/v4/image-to-image/stream) · [Guide / pricing](https://fal.ai/models/ideogram/v4/image-to-image/stream/llms.txt). Retrieved 2026-09-25 UTC; OpenAPI `3.0.4`; info.version `1.0.0`. Raw schema SHA-256 `3f1469685499df946e3a750db792dc5d66c08caca72ed190fb7d9ed2369ce607`.

Input component `V4ImageToImageStreamInput`; output component `V4ImageToImageStreamOutput`.

**Request** (`object`); no object-level conditional constraints or additionalProperties restriction declared.

| Field | Presence | Complete property constraints (S; x-fal is M) |
| --- | --- | --- |
| `prompt` | R | `{"type":"string"}` |
| `expansion_model` | O | `{"enum":["None","Medium","Large"],"default":"Medium","type":"string"}` |
| `image_size` | O | `{"default":"auto","anyOf":[{"$ref":"#/components/schemas/ImageSize"},{"enum":["square_hd","square","portrait_4_3","portrait_16_9","landscape_4_3","landscape_16_9","auto"],"type":"string"}]}` |
| `rendering_speed` | O | `{"enum":["TURBO","BALANCED","QUALITY"],"default":"BALANCED","type":"string"}` |
| `acceleration` | O | `{"enum":["none","low","regular","high"],"default":"none","type":"string"}` |
| `seed` | O | `{"anyOf":[{"type":"integer"},{"type":"null"}]}` |
| `sync_mode` | O | `{"default":false,"type":"boolean"}` |
| `enable_safety_checker` | O | `{"default":true,"type":"boolean"}` |
| `output_format` | O | `{"enum":["jpeg","png"],"default":"jpeg","type":"string"}` |
| `image_url` | R | `{"type":"string"}` |
| `strength` | O | `{"minimum":0,"default":0.8,"maximum":1,"type":"number"}` |

**Response:** empty schema `{}` — unconstrained, no documented event/result fields or requiredness.

**Illustrative request (not submitted):**
```json
{
  "prompt": "A blue paper bird on a cream background",
  "image_url": "https://example.org/image.png"
}
```
**Illustrative response** (structure unknown; this is not a usable stream event):
```json
{}
```

<a id="a07"></a>

### A07. ideogram/v4/inpaint

[Schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=ideogram/v4/inpaint) · [Guide / pricing](https://fal.ai/models/ideogram/v4/inpaint/llms.txt). Retrieved 2026-09-25 UTC; OpenAPI `3.0.4`; info.version `1.0.0`. Raw schema SHA-256 `a04dd440c2ad322730020cd99b1abe07bd16115ab5db1563f44239dc8d27a149`.

Input component `V4InpaintInput`; output component `V4InpaintOutput`.

**Request** (`object`); no object-level conditional constraints or additionalProperties restriction declared.

| Field | Presence | Complete property constraints (S; x-fal is M) |
| --- | --- | --- |
| `prompt` | R | `{"type":"string"}` |
| `expansion_model` | O | `{"enum":["None","Medium","Large"],"default":"Medium","type":"string"}` |
| `image_size` | O | `{"default":"auto","anyOf":[{"$ref":"#/components/schemas/ImageSize"},{"enum":["square_hd","square","portrait_4_3","portrait_16_9","landscape_4_3","landscape_16_9","auto"],"type":"string"}]}` |
| `rendering_speed` | O | `{"enum":["TURBO","BALANCED","QUALITY"],"default":"BALANCED","type":"string"}` |
| `acceleration` | O | `{"enum":["none","low","regular","high"],"default":"none","type":"string"}` |
| `num_images` | O | `{"minimum":1,"maximum":4,"type":"integer","default":1}` |
| `seed` | O | `{"anyOf":[{"type":"integer"},{"type":"null"}]}` |
| `sync_mode` | O | `{"default":false,"type":"boolean"}` |
| `enable_safety_checker` | O | `{"default":true,"type":"boolean"}` |
| `output_format` | O | `{"enum":["jpeg","png"],"default":"jpeg","type":"string"}` |
| `image_url` | R | `{"type":"string"}` |
| `mask_url` | R | `{"type":"string"}` |
| `strength` | O | `{"minimum":0,"default":1,"maximum":1,"type":"number"}` |

**Response** (`object`); no object-level conditional constraints or additionalProperties restriction declared.

| Field | Presence | Complete property constraints (S; x-fal is M) |
| --- | --- | --- |
| `images` | R | `{"items":{"$ref":"#/components/schemas/ImageFile"},"type":"array"}` |
| `timings` | R | `{"type":"object","additionalProperties":{"type":"number"}}` |
| `seed` | R | `{"type":"integer"}` |
| `has_nsfw_concepts` | R | `{"items":{"type":"boolean"},"type":"array"}` |
| `prompt` | R | `{"type":"string"}` |

**Illustrative request (not submitted):**
```json
{
  "prompt": "A blue paper bird on a cream background",
  "image_url": "https://example.org/image.png",
  "mask_url": "https://example.org/mask.png"
}
```
**Illustrative response**:
```json
{
  "images": [
    {
      "url": "https://example.org/result.png"
    }
  ],
  "timings": {},
  "seed": 42,
  "has_nsfw_concepts": [
    false
  ],
  "prompt": "A blue paper bird on a cream background"
}
```

<a id="a08"></a>

### A08. ideogram/v4/inpaint/lora

[Schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=ideogram/v4/inpaint/lora) · [Guide / pricing](https://fal.ai/models/ideogram/v4/inpaint/lora/llms.txt). Retrieved 2026-09-25 UTC; OpenAPI `3.0.4`; info.version `1.0.0`. Raw schema SHA-256 `c7a156d6fa86482abf3add45c55dc6cc9b0e7ba58bb77982884cf9cf0e5b8bdb`.

Input component `V4InpaintLoraInput`; output component `V4InpaintLoraOutput`.

**Request** (`object`); no object-level conditional constraints or additionalProperties restriction declared.

| Field | Presence | Complete property constraints (S; x-fal is M) |
| --- | --- | --- |
| `prompt` | R | `{"type":"string"}` |
| `expansion_model` | O | `{"enum":["None","Medium","Large"],"default":"Medium","type":"string"}` |
| `image_size` | O | `{"default":"auto","anyOf":[{"$ref":"#/components/schemas/ImageSize"},{"enum":["square_hd","square","portrait_4_3","portrait_16_9","landscape_4_3","landscape_16_9","auto"],"type":"string"}]}` |
| `rendering_speed` | O | `{"enum":["TURBO","BALANCED","QUALITY"],"default":"BALANCED","type":"string"}` |
| `acceleration` | O | `{"enum":["none","low","regular","high"],"default":"none","type":"string"}` |
| `num_images` | O | `{"minimum":1,"maximum":4,"type":"integer","default":1}` |
| `seed` | O | `{"anyOf":[{"type":"integer"},{"type":"null"}]}` |
| `sync_mode` | O | `{"default":false,"type":"boolean"}` |
| `enable_safety_checker` | O | `{"default":true,"type":"boolean"}` |
| `output_format` | O | `{"enum":["jpeg","png"],"default":"jpeg","type":"string"}` |
| `image_url` | R | `{"type":"string"}` |
| `mask_url` | R | `{"type":"string"}` |
| `strength` | O | `{"minimum":0,"default":1,"maximum":1,"type":"number"}` |
| `loras` | O | `{"items":{"$ref":"#/components/schemas/LoRAInput"},"maxItems":3,"default":[],"type":"array"}` |

**Response** (`object`); no object-level conditional constraints or additionalProperties restriction declared.

| Field | Presence | Complete property constraints (S; x-fal is M) |
| --- | --- | --- |
| `images` | R | `{"items":{"$ref":"#/components/schemas/ImageFile"},"type":"array"}` |
| `timings` | R | `{"type":"object","additionalProperties":{"type":"number"}}` |
| `seed` | R | `{"type":"integer"}` |
| `has_nsfw_concepts` | R | `{"items":{"type":"boolean"},"type":"array"}` |
| `prompt` | R | `{"type":"string"}` |

**Illustrative request (not submitted):**
```json
{
  "prompt": "A blue paper bird on a cream background",
  "image_url": "https://example.org/image.png",
  "mask_url": "https://example.org/mask.png",
  "loras": [
    {
      "path": "https://example.org/adapter.safetensors",
      "scale": 1
    }
  ]
}
```
**Illustrative response**:
```json
{
  "images": [
    {
      "url": "https://example.org/result.png"
    }
  ],
  "timings": {},
  "seed": 42,
  "has_nsfw_concepts": [
    false
  ],
  "prompt": "A blue paper bird on a cream background"
}
```

<a id="a09"></a>

### A09. ideogram/v4/instant

[Schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=ideogram/v4/instant) · [Guide / pricing](https://fal.ai/models/ideogram/v4/instant/llms.txt). Retrieved 2026-09-25 UTC; OpenAPI `3.0.4`; info.version `1.0.0`. Raw schema SHA-256 `e8ddffdfef2072067915ae0a257c60439900e978468d7753bc0cf9176c525027`.

Input component `V4InstantInput`; output component `V4InstantOutput`.

**Request** (`object`); no object-level conditional constraints or additionalProperties restriction declared.

| Field | Presence | Complete property constraints (S; x-fal is M) |
| --- | --- | --- |
| `prompt` | R | `{"type":"string"}` |
| `expansion_model` | O | `{"enum":["None","Medium"],"default":"Medium","type":"string"}` |
| `image_size` | O | `{"default":"square_hd","anyOf":[{"$ref":"#/components/schemas/ImageSize"},{"enum":["square_hd","square","portrait_4_3","portrait_16_9","landscape_4_3","landscape_16_9"],"type":"string"}],"x-fal":{"multiple_of":16,"min_height":512,"max_height":2048,"max_width":2048,"min_width":512}}` |
| `num_images` | O | `{"minimum":1,"maximum":4,"type":"integer","default":1}` |
| `seed` | O | `{"anyOf":[{"type":"integer"},{"type":"null"}]}` |
| `sync_mode` | O | `{"default":false,"type":"boolean"}` |
| `enable_safety_checker` | O | `{"default":true,"type":"boolean"}` |
| `output_format` | O | `{"enum":["jpeg","png"],"default":"jpeg","type":"string"}` |

**Response** (`object`); no object-level conditional constraints or additionalProperties restriction declared.

| Field | Presence | Complete property constraints (S; x-fal is M) |
| --- | --- | --- |
| `images` | R | `{"items":{"$ref":"#/components/schemas/ImageFile"},"type":"array"}` |
| `timings` | R | `{"type":"object","additionalProperties":{"type":"number"}}` |
| `seed` | R | `{"type":"integer"}` |
| `has_nsfw_concepts` | R | `{"items":{"type":"boolean"},"type":"array"}` |
| `prompt` | R | `{"type":"string"}` |

**Illustrative request (not submitted):**
```json
{
  "prompt": "A blue paper bird on a cream background"
}
```
**Illustrative response**:
```json
{
  "images": [
    {
      "url": "https://example.org/result.png"
    }
  ],
  "timings": {},
  "seed": 42,
  "has_nsfw_concepts": [
    false
  ],
  "prompt": "A blue paper bird on a cream background"
}
```

<a id="a10"></a>

### A10. ideogram/v4/lora

[Schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=ideogram/v4/lora) · [Guide / pricing](https://fal.ai/models/ideogram/v4/lora/llms.txt). Retrieved 2026-09-25 UTC; OpenAPI `3.0.4`; info.version `1.0.0`. Raw schema SHA-256 `c5c544d3883e7f3392139adac4c2a41cbeae7fd88a9d7762c4733238ba9848b6`.

Input component `V4LoraInput`; output component `V4LoraOutput`.

**Request** (`object`); no object-level conditional constraints or additionalProperties restriction declared.

| Field | Presence | Complete property constraints (S; x-fal is M) |
| --- | --- | --- |
| `prompt` | R | `{"type":"string"}` |
| `expansion_model` | O | `{"enum":["None","Medium","Large"],"default":"Medium","type":"string"}` |
| `image_size` | O | `{"default":"square_hd","anyOf":[{"$ref":"#/components/schemas/ImageSize"},{"enum":["square_hd","square","portrait_4_3","portrait_16_9","landscape_4_3","landscape_16_9"],"type":"string"}],"x-fal":{"multiple_of":16,"min_height":512,"max_height":3840,"max_width":3840,"min_width":512}}` |
| `rendering_speed` | O | `{"enum":["TURBO","BALANCED","QUALITY"],"default":"BALANCED","type":"string"}` |
| `acceleration` | O | `{"enum":["none","low","regular","high"],"default":"none","type":"string"}` |
| `num_images` | O | `{"minimum":1,"maximum":4,"type":"integer","default":1}` |
| `seed` | O | `{"anyOf":[{"type":"integer"},{"type":"null"}]}` |
| `sync_mode` | O | `{"default":false,"type":"boolean"}` |
| `enable_safety_checker` | O | `{"default":true,"type":"boolean"}` |
| `output_format` | O | `{"enum":["jpeg","png"],"default":"jpeg","type":"string"}` |
| `loras` | O | `{"items":{"$ref":"#/components/schemas/LoRAInput"},"maxItems":3,"default":[],"type":"array"}` |

**Response** (`object`); no object-level conditional constraints or additionalProperties restriction declared.

| Field | Presence | Complete property constraints (S; x-fal is M) |
| --- | --- | --- |
| `images` | R | `{"items":{"$ref":"#/components/schemas/ImageFile"},"type":"array"}` |
| `timings` | R | `{"type":"object","additionalProperties":{"type":"number"}}` |
| `seed` | R | `{"type":"integer"}` |
| `has_nsfw_concepts` | R | `{"items":{"type":"boolean"},"type":"array"}` |
| `prompt` | R | `{"type":"string"}` |

**Illustrative request (not submitted):**
```json
{
  "prompt": "A blue paper bird on a cream background",
  "loras": [
    {
      "path": "https://example.org/adapter.safetensors",
      "scale": 1
    }
  ]
}
```
**Illustrative response**:
```json
{
  "images": [
    {
      "url": "https://example.org/result.png"
    }
  ],
  "timings": {},
  "seed": 42,
  "has_nsfw_concepts": [
    false
  ],
  "prompt": "A blue paper bird on a cream background"
}
```

<a id="a11"></a>

### A11. ideogram/v4/lora/stream

[Schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=ideogram/v4/lora/stream) · [Guide / pricing](https://fal.ai/models/ideogram/v4/lora/stream/llms.txt). Retrieved 2026-09-25 UTC; OpenAPI `3.0.4`; info.version `1.0.0`. Raw schema SHA-256 `639eb160f80f412a63c1470d0657dceedad9f4a060af594a8765bfec6b09b20e`.

Input component `V4LoraStreamInput`; output component `V4LoraStreamOutput`.

**Request** (`object`); no object-level conditional constraints or additionalProperties restriction declared.

| Field | Presence | Complete property constraints (S; x-fal is M) |
| --- | --- | --- |
| `prompt` | R | `{"type":"string"}` |
| `expansion_model` | O | `{"enum":["None","Medium","Large"],"default":"Medium","type":"string"}` |
| `image_size` | O | `{"default":"square_hd","anyOf":[{"$ref":"#/components/schemas/ImageSize"},{"enum":["square_hd","square","portrait_4_3","portrait_16_9","landscape_4_3","landscape_16_9"],"type":"string"}],"x-fal":{"multiple_of":16,"min_height":512,"max_height":3840,"max_width":3840,"min_width":512}}` |
| `rendering_speed` | O | `{"enum":["TURBO","BALANCED","QUALITY"],"default":"BALANCED","type":"string"}` |
| `acceleration` | O | `{"enum":["none","low","regular","high"],"default":"none","type":"string"}` |
| `seed` | O | `{"anyOf":[{"type":"integer"},{"type":"null"}]}` |
| `sync_mode` | O | `{"default":false,"type":"boolean"}` |
| `enable_safety_checker` | O | `{"default":true,"type":"boolean"}` |
| `output_format` | O | `{"enum":["jpeg","png"],"default":"jpeg","type":"string"}` |
| `loras` | O | `{"items":{"$ref":"#/components/schemas/LoRAInput"},"maxItems":3,"default":[],"type":"array"}` |

**Response:** empty schema `{}` — unconstrained, no documented event/result fields or requiredness.

**Illustrative request (not submitted):**
```json
{
  "prompt": "A blue paper bird on a cream background",
  "loras": [
    {
      "path": "https://example.org/adapter.safetensors",
      "scale": 1
    }
  ]
}
```
**Illustrative response** (structure unknown; this is not a usable stream event):
```json
{}
```

<a id="a12"></a>

### A12. ideogram/v4/stream

[Schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=ideogram/v4/stream) · [Guide / pricing](https://fal.ai/models/ideogram/v4/stream/llms.txt). Retrieved 2026-09-25 UTC; OpenAPI `3.0.4`; info.version `1.0.0`. Raw schema SHA-256 `c5dc0e181f1875f846ebc4d46210500fbca130c7adef5ab52588cd8b10685895`.

Input component `V4StreamInput`; output component `V4StreamOutput`.

**Request** (`object`); no object-level conditional constraints or additionalProperties restriction declared.

| Field | Presence | Complete property constraints (S; x-fal is M) |
| --- | --- | --- |
| `prompt` | R | `{"type":"string"}` |
| `expansion_model` | O | `{"enum":["None","Medium","Large"],"default":"Medium","type":"string"}` |
| `image_size` | O | `{"default":"square_hd","anyOf":[{"$ref":"#/components/schemas/ImageSize"},{"enum":["square_hd","square","portrait_4_3","portrait_16_9","landscape_4_3","landscape_16_9"],"type":"string"}],"x-fal":{"multiple_of":16,"min_height":512,"max_height":3840,"max_width":3840,"min_width":512}}` |
| `rendering_speed` | O | `{"enum":["TURBO","BALANCED","QUALITY"],"default":"BALANCED","type":"string"}` |
| `acceleration` | O | `{"enum":["none","low","regular","high"],"default":"none","type":"string"}` |
| `seed` | O | `{"anyOf":[{"type":"integer"},{"type":"null"}]}` |
| `sync_mode` | O | `{"default":false,"type":"boolean"}` |
| `enable_safety_checker` | O | `{"default":true,"type":"boolean"}` |
| `output_format` | O | `{"enum":["jpeg","png"],"default":"jpeg","type":"string"}` |

**Response:** empty schema `{}` — unconstrained, no documented event/result fields or requiredness.

**Illustrative request (not submitted):**
```json
{
  "prompt": "A blue paper bird on a cream background"
}
```
**Illustrative response** (structure unknown; this is not a usable stream event):
```json
{}
```

<a id="a13"></a>

### A13. ideogram/v4/tiling

[Schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=ideogram/v4/tiling) · [Guide / pricing](https://fal.ai/models/ideogram/v4/tiling/llms.txt). Retrieved 2026-09-25 UTC; OpenAPI `3.0.4`; info.version `1.0.0`. Raw schema SHA-256 `5f1177b1a4302825af51cf729780789de62ec3c5b7775962d4c19a4f707395b0`.

Input component `V4TilingInput`; output component `V4TilingOutput`.

**Request** (`object`); no object-level conditional constraints or additionalProperties restriction declared.

| Field | Presence | Complete property constraints (S; x-fal is M) |
| --- | --- | --- |
| `prompt` | R | `{"type":"string"}` |
| `expansion_model` | O | `{"enum":["None","Medium","Large"],"default":"Medium","type":"string"}` |
| `image_size` | O | `{"default":"square_hd","anyOf":[{"$ref":"#/components/schemas/ImageSize"},{"enum":["square_hd","square","portrait_4_3","portrait_16_9","landscape_4_3","landscape_16_9"],"type":"string"}]}` |
| `rendering_speed` | O | `{"enum":["TURBO","BALANCED","QUALITY"],"default":"BALANCED","type":"string"}` |
| `acceleration` | O | `{"enum":["none","low","regular","high"],"default":"none","type":"string"}` |
| `num_images` | O | `{"minimum":1,"maximum":4,"type":"integer","default":1}` |
| `seed` | O | `{"anyOf":[{"type":"integer"},{"type":"null"}]}` |
| `sync_mode` | O | `{"default":false,"type":"boolean"}` |
| `enable_safety_checker` | O | `{"default":true,"type":"boolean"}` |
| `output_format` | O | `{"enum":["jpeg","png"],"default":"jpeg","type":"string"}` |
| `image_url` | O | `{"anyOf":[{"type":"string"},{"type":"null"}]}` |
| `mask_url` | O | `{"anyOf":[{"type":"string"},{"type":"null"}]}` |
| `strength` | O | `{"minimum":0,"maximum":1,"type":"number","default":0.8}` |
| `tiling_mode` | O | `{"enum":["both","horizontal","vertical"],"default":"both","type":"string"}` |

**Response** (`object`); no object-level conditional constraints or additionalProperties restriction declared.

| Field | Presence | Complete property constraints (S; x-fal is M) |
| --- | --- | --- |
| `images` | R | `{"items":{"$ref":"#/components/schemas/ImageFile"},"type":"array"}` |
| `timings` | R | `{"type":"object","additionalProperties":{"type":"number"}}` |
| `seed` | R | `{"type":"integer"}` |
| `has_nsfw_concepts` | R | `{"items":{"type":"boolean"},"type":"array"}` |
| `prompt` | R | `{"type":"string"}` |

**Illustrative request (not submitted):**
```json
{
  "prompt": "A blue paper bird on a cream background"
}
```
**Illustrative response**:
```json
{
  "images": [
    {
      "url": "https://example.org/result.png"
    }
  ],
  "timings": {},
  "seed": 42,
  "has_nsfw_concepts": [
    false
  ],
  "prompt": "A blue paper bird on a cream background"
}
```

<a id="a14"></a>

### A14. ideogram/v4/tiling/lora

[Schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=ideogram/v4/tiling/lora) · [Guide / pricing](https://fal.ai/models/ideogram/v4/tiling/lora/llms.txt). Retrieved 2026-09-25 UTC; OpenAPI `3.0.4`; info.version `1.0.0`. Raw schema SHA-256 `04c269b6673f5a38a68b0a26fd29893e73048fe3da4a2f36c9d38229219ed474`.

Input component `V4TilingLoraInput`; output component `V4TilingLoraOutput`.

**Request** (`object`); no object-level conditional constraints or additionalProperties restriction declared.

| Field | Presence | Complete property constraints (S; x-fal is M) |
| --- | --- | --- |
| `prompt` | R | `{"type":"string"}` |
| `expansion_model` | O | `{"enum":["None","Medium","Large"],"default":"Medium","type":"string"}` |
| `image_size` | O | `{"default":"square_hd","anyOf":[{"$ref":"#/components/schemas/ImageSize"},{"enum":["square_hd","square","portrait_4_3","portrait_16_9","landscape_4_3","landscape_16_9"],"type":"string"}]}` |
| `rendering_speed` | O | `{"enum":["TURBO","BALANCED","QUALITY"],"default":"BALANCED","type":"string"}` |
| `acceleration` | O | `{"enum":["none","low","regular","high"],"default":"none","type":"string"}` |
| `num_images` | O | `{"minimum":1,"maximum":4,"type":"integer","default":1}` |
| `seed` | O | `{"anyOf":[{"type":"integer"},{"type":"null"}]}` |
| `sync_mode` | O | `{"default":false,"type":"boolean"}` |
| `enable_safety_checker` | O | `{"default":true,"type":"boolean"}` |
| `output_format` | O | `{"enum":["jpeg","png"],"default":"jpeg","type":"string"}` |
| `image_url` | O | `{"anyOf":[{"type":"string"},{"type":"null"}]}` |
| `mask_url` | O | `{"anyOf":[{"type":"string"},{"type":"null"}]}` |
| `strength` | O | `{"minimum":0,"maximum":1,"type":"number","default":0.8}` |
| `tiling_mode` | O | `{"enum":["both","horizontal","vertical"],"default":"both","type":"string"}` |
| `loras` | O | `{"items":{"$ref":"#/components/schemas/LoRAInput"},"maxItems":3,"default":[],"type":"array"}` |

**Response** (`object`); no object-level conditional constraints or additionalProperties restriction declared.

| Field | Presence | Complete property constraints (S; x-fal is M) |
| --- | --- | --- |
| `images` | R | `{"items":{"$ref":"#/components/schemas/ImageFile"},"type":"array"}` |
| `timings` | R | `{"type":"object","additionalProperties":{"type":"number"}}` |
| `seed` | R | `{"type":"integer"}` |
| `has_nsfw_concepts` | R | `{"items":{"type":"boolean"},"type":"array"}` |
| `prompt` | R | `{"type":"string"}` |

**Illustrative request (not submitted):**
```json
{
  "prompt": "A blue paper bird on a cream background",
  "loras": [
    {
      "path": "https://example.org/adapter.safetensors",
      "scale": 1
    }
  ]
}
```
**Illustrative response**:
```json
{
  "images": [
    {
      "url": "https://example.org/result.png"
    }
  ],
  "timings": {},
  "seed": 42,
  "has_nsfw_concepts": [
    false
  ],
  "prompt": "A blue paper bird on a cream background"
}
```

<a id="a15"></a>

### A15. ideogram/v4/tiling/lora/stream

[Schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=ideogram/v4/tiling/lora/stream) · [Guide / pricing](https://fal.ai/models/ideogram/v4/tiling/lora/stream/llms.txt). Retrieved 2026-09-25 UTC; OpenAPI `3.0.4`; info.version `1.0.0`. Raw schema SHA-256 `136968ca1ad745accc469e0a28d0a44476d8dff02aab2a3a8752800f3819d2f5`.

Input component `V4TilingLoraStreamInput`; output component `V4TilingLoraStreamOutput`.

**Request** (`object`); no object-level conditional constraints or additionalProperties restriction declared.

| Field | Presence | Complete property constraints (S; x-fal is M) |
| --- | --- | --- |
| `prompt` | R | `{"type":"string"}` |
| `expansion_model` | O | `{"enum":["None","Medium","Large"],"default":"Medium","type":"string"}` |
| `image_size` | O | `{"default":"square_hd","anyOf":[{"$ref":"#/components/schemas/ImageSize"},{"enum":["square_hd","square","portrait_4_3","portrait_16_9","landscape_4_3","landscape_16_9"],"type":"string"}]}` |
| `rendering_speed` | O | `{"enum":["TURBO","BALANCED","QUALITY"],"default":"BALANCED","type":"string"}` |
| `acceleration` | O | `{"enum":["none","low","regular","high"],"default":"none","type":"string"}` |
| `seed` | O | `{"anyOf":[{"type":"integer"},{"type":"null"}]}` |
| `sync_mode` | O | `{"default":false,"type":"boolean"}` |
| `enable_safety_checker` | O | `{"default":true,"type":"boolean"}` |
| `output_format` | O | `{"enum":["jpeg","png"],"default":"jpeg","type":"string"}` |
| `image_url` | O | `{"anyOf":[{"type":"string"},{"type":"null"}]}` |
| `mask_url` | O | `{"anyOf":[{"type":"string"},{"type":"null"}]}` |
| `strength` | O | `{"minimum":0,"maximum":1,"type":"number","default":0.8}` |
| `tiling_mode` | O | `{"enum":["both","horizontal","vertical"],"default":"both","type":"string"}` |
| `loras` | O | `{"items":{"$ref":"#/components/schemas/LoRAInput"},"maxItems":3,"default":[],"type":"array"}` |

**Response:** empty schema `{}` — unconstrained, no documented event/result fields or requiredness.

**Illustrative request (not submitted):**
```json
{
  "prompt": "A blue paper bird on a cream background",
  "loras": [
    {
      "path": "https://example.org/adapter.safetensors",
      "scale": 1
    }
  ]
}
```
**Illustrative response** (structure unknown; this is not a usable stream event):
```json
{}
```

<a id="a16"></a>

### A16. ideogram/v4/tiling/stream

[Schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=ideogram/v4/tiling/stream) · [Guide / pricing](https://fal.ai/models/ideogram/v4/tiling/stream/llms.txt). Retrieved 2026-09-25 UTC; OpenAPI `3.0.4`; info.version `1.0.0`. Raw schema SHA-256 `6272afc4cca2d3aedb8729f203f5f15e873cba46e49cd1c09e91a050f8ad432f`.

Input component `V4TilingStreamInput`; output component `V4TilingStreamOutput`.

**Request** (`object`); no object-level conditional constraints or additionalProperties restriction declared.

| Field | Presence | Complete property constraints (S; x-fal is M) |
| --- | --- | --- |
| `prompt` | R | `{"type":"string"}` |
| `expansion_model` | O | `{"enum":["None","Medium","Large"],"default":"Medium","type":"string"}` |
| `image_size` | O | `{"default":"square_hd","anyOf":[{"$ref":"#/components/schemas/ImageSize"},{"enum":["square_hd","square","portrait_4_3","portrait_16_9","landscape_4_3","landscape_16_9"],"type":"string"}]}` |
| `rendering_speed` | O | `{"enum":["TURBO","BALANCED","QUALITY"],"default":"BALANCED","type":"string"}` |
| `acceleration` | O | `{"enum":["none","low","regular","high"],"default":"none","type":"string"}` |
| `seed` | O | `{"anyOf":[{"type":"integer"},{"type":"null"}]}` |
| `sync_mode` | O | `{"default":false,"type":"boolean"}` |
| `enable_safety_checker` | O | `{"default":true,"type":"boolean"}` |
| `output_format` | O | `{"enum":["jpeg","png"],"default":"jpeg","type":"string"}` |
| `image_url` | O | `{"anyOf":[{"type":"string"},{"type":"null"}]}` |
| `mask_url` | O | `{"anyOf":[{"type":"string"},{"type":"null"}]}` |
| `strength` | O | `{"minimum":0,"maximum":1,"type":"number","default":0.8}` |
| `tiling_mode` | O | `{"enum":["both","horizontal","vertical"],"default":"both","type":"string"}` |

**Response:** empty schema `{}` — unconstrained, no documented event/result fields or requiredness.

**Illustrative request (not submitted):**
```json
{
  "prompt": "A blue paper bird on a cream background"
}
```
**Illustrative response** (structure unknown; this is not a usable stream event):
```json
{}
```

<a id="a17"></a>

### A17. ideogram/v4/trainer

[Schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=ideogram/v4/trainer) · [Guide / pricing](https://fal.ai/models/ideogram/v4/trainer/llms.txt). Retrieved 2026-09-25 UTC; OpenAPI `3.0.4`; info.version `1.0.0`. Raw schema SHA-256 `b35fcc12da58c1ba01a36fd76534a1cc11555ff7ce7d67ae748c1accab91c604`.

Input component `V4TrainerInput`; output component `V4TrainerOutput`.

**Request** (`object`); no object-level conditional constraints or additionalProperties restriction declared.

| Field | Presence | Complete property constraints (S; x-fal is M) |
| --- | --- | --- |
| `images_data_url` | R | `{"type":"string"}` |
| `steps` | O | `{"default":1000,"type":"integer","maximum":40000,"minimum":100}` |
| `default_caption` | O | `{"anyOf":[{"type":"string"},{"type":"null"}]}` |
| `resolution` | O | `{"default":"auto","type":"string"}` |
| `learning_rate` | O | `{"default":0.0001,"type":"number","maximum":0.01,"minimum":1e-06}` |
| `output_lora_format` | O | `{"default":"fal","type":"string","enum":["fal","comfy"]}` |

**Response** (`object`); no object-level conditional constraints or additionalProperties restriction declared.

| Field | Presence | Complete property constraints (S; x-fal is M) |
| --- | --- | --- |
| `diffusers_lora_file` | R | `{"$ref":"#/components/schemas/File"}` |
| `config_file` | R | `{"$ref":"#/components/schemas/File"}` |

**Illustrative request (not submitted):**
```json
{
  "images_data_url": "https://example.org/dataset.zip"
}
```
**Illustrative response**:
```json
{
  "diffusers_lora_file": {
    "url": "https://example.org/adapter.safetensors"
  },
  "config_file": {
    "url": "https://example.org/config.json"
  }
}
```

<a id="a18"></a>

### A18. fal-ai/ideogram/character

[Schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/ideogram/character) · [Guide / pricing](https://fal.ai/models/fal-ai/ideogram/character/llms.txt). Retrieved 2026-09-25 UTC; OpenAPI `3.0.4`; info.version `1.0.0`. Raw schema SHA-256 `7f6721951cd7ca4b025b06f92dfeab3c3db40efef3b9507da09153ae812a05a3`.

Input component `IdeogramCharacterInput`; output component `IdeogramCharacterOutput`.

**Request** (`object`); no object-level conditional constraints or additionalProperties restriction declared.

| Field | Presence | Complete property constraints (S; x-fal is M) |
| --- | --- | --- |
| `image_urls` | O | `{"anyOf":[{"items":{"type":"string"},"type":"array"},{"type":"null"}]}` |
| `rendering_speed` | O | `{"enum":["TURBO","BALANCED","QUALITY"],"default":"BALANCED","type":"string"}` |
| `color_palette` | O | `{"anyOf":[{"$ref":"#/components/schemas/ColorPalette"},{"type":"null"}]}` |
| `style_codes` | O | `{"anyOf":[{"items":{"type":"string"},"type":"array"},{"type":"null"}]}` |
| `style` | O | `{"enum":["AUTO","REALISTIC","FICTION"],"default":"AUTO","type":"string"}` |
| `expand_prompt` | O | `{"default":true,"type":"boolean"}` |
| `num_images` | O | `{"minimum":1,"maximum":8,"type":"integer","default":1}` |
| `seed` | O | `{"anyOf":[{"type":"integer"},{"type":"null"}]}` |
| `sync_mode` | O | `{"default":false,"type":"boolean"}` |
| `prompt` | R | `{"type":"string"}` |
| `image_size` | O | `{"default":"square_hd","anyOf":[{"$ref":"#/components/schemas/ImageSize"},{"enum":["square_hd","square","portrait_4_3","portrait_16_9","landscape_4_3","landscape_16_9"],"type":"string"},{"type":"null"}]}` |
| `negative_prompt` | O | `{"default":"","type":"string"}` |
| `reference_image_urls` | R | `{"items":{"type":"string"},"type":"array"}` |
| `reference_mask_urls` | O | `{"items":{"type":"string"},"type":"array"}` |

**Response** (`object`); no object-level conditional constraints or additionalProperties restriction declared.

| Field | Presence | Complete property constraints (S; x-fal is M) |
| --- | --- | --- |
| `images` | R | `{"items":{"$ref":"#/components/schemas/File"},"type":"array"}` |
| `seed` | R | `{"type":"integer"}` |

**Illustrative request (not submitted):**
```json
{
  "prompt": "A blue paper bird on a cream background",
  "reference_image_urls": [
    "https://example.org/character.png"
  ]
}
```
**Illustrative response**:
```json
{
  "images": [
    {
      "url": "https://example.org/result.png"
    }
  ],
  "seed": 42
}
```

<a id="a19"></a>

### A19. fal-ai/ideogram/character/edit

[Schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/ideogram/character/edit) · [Guide / pricing](https://fal.ai/models/fal-ai/ideogram/character/edit/llms.txt). Retrieved 2026-09-25 UTC; OpenAPI `3.0.4`; info.version `1.0.0`. Raw schema SHA-256 `bf5d47d8b9130f77fbad1db0430d982e07d4bc6f857a5182d936bc45f852bf06`.

Input component `IdeogramCharacterEditInput`; output component `IdeogramCharacterEditOutput`.

**Request** (`object`); no object-level conditional constraints or additionalProperties restriction declared.

| Field | Presence | Complete property constraints (S; x-fal is M) |
| --- | --- | --- |
| `image_urls` | O | `{"anyOf":[{"items":{"type":"string"},"type":"array"},{"type":"null"}]}` |
| `rendering_speed` | O | `{"enum":["TURBO","BALANCED","QUALITY"],"default":"BALANCED","type":"string"}` |
| `color_palette` | O | `{"anyOf":[{"$ref":"#/components/schemas/ColorPalette"},{"type":"null"}]}` |
| `style_codes` | O | `{"anyOf":[{"items":{"type":"string"},"type":"array"},{"type":"null"}]}` |
| `expand_prompt` | O | `{"default":true,"type":"boolean"}` |
| `num_images` | O | `{"minimum":1,"maximum":8,"type":"integer","default":1}` |
| `seed` | O | `{"anyOf":[{"type":"integer"},{"type":"null"}]}` |
| `sync_mode` | O | `{"default":false,"type":"boolean"}` |
| `prompt` | R | `{"type":"string"}` |
| `image_url` | R | `{"type":"string"}` |
| `mask_url` | R | `{"type":"string"}` |
| `reference_image_urls` | R | `{"items":{"type":"string"},"type":"array"}` |
| `reference_mask_urls` | O | `{"items":{"type":"string"},"type":"array"}` |

**Response** (`object`); no object-level conditional constraints or additionalProperties restriction declared.

| Field | Presence | Complete property constraints (S; x-fal is M) |
| --- | --- | --- |
| `images` | R | `{"items":{"$ref":"#/components/schemas/File"},"type":"array"}` |
| `seed` | R | `{"type":"integer"}` |

**Illustrative request (not submitted):**
```json
{
  "prompt": "A blue paper bird on a cream background",
  "image_url": "https://example.org/image.png",
  "mask_url": "https://example.org/mask.png",
  "reference_image_urls": [
    "https://example.org/character.png"
  ]
}
```
**Illustrative response**:
```json
{
  "images": [
    {
      "url": "https://example.org/result.png"
    }
  ],
  "seed": 42
}
```

<a id="a20"></a>

### A20. fal-ai/ideogram/character/remix

[Schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/ideogram/character/remix) · [Guide / pricing](https://fal.ai/models/fal-ai/ideogram/character/remix/llms.txt). Retrieved 2026-09-25 UTC; OpenAPI `3.0.4`; info.version `1.0.0`. Raw schema SHA-256 `62caceba22724896a4c7436e0e4e2fbc8ad9ef49c46a75d278886bbf767926b4`.

Input component `IdeogramCharacterRemixInput`; output component `IdeogramCharacterRemixOutput`.

**Request** (`object`); no object-level conditional constraints or additionalProperties restriction declared.

| Field | Presence | Complete property constraints (S; x-fal is M) |
| --- | --- | --- |
| `image_urls` | O | `{"anyOf":[{"items":{"type":"string"},"type":"array"},{"type":"null"}]}` |
| `rendering_speed` | O | `{"enum":["TURBO","BALANCED","QUALITY"],"default":"BALANCED","type":"string"}` |
| `color_palette` | O | `{"anyOf":[{"$ref":"#/components/schemas/ColorPalette"},{"type":"null"}]}` |
| `style_codes` | O | `{"anyOf":[{"items":{"type":"string"},"type":"array"},{"type":"null"}]}` |
| `style` | O | `{"enum":["AUTO","REALISTIC","FICTION"],"default":"AUTO","type":"string"}` |
| `expand_prompt` | O | `{"default":true,"type":"boolean"}` |
| `num_images` | O | `{"minimum":1,"maximum":8,"type":"integer","default":1}` |
| `seed` | O | `{"anyOf":[{"type":"integer"},{"type":"null"}]}` |
| `sync_mode` | O | `{"default":false,"type":"boolean"}` |
| `prompt` | R | `{"type":"string"}` |
| `image_url` | R | `{"type":"string"}` |
| `strength` | O | `{"minimum":0.01,"maximum":1,"type":"number","default":0.8}` |
| `image_size` | O | `{"default":"square_hd","anyOf":[{"$ref":"#/components/schemas/ImageSize"},{"enum":["square_hd","square","portrait_4_3","portrait_16_9","landscape_4_3","landscape_16_9"],"type":"string"},{"type":"null"}]}` |
| `negative_prompt` | O | `{"default":"","type":"string"}` |
| `reference_image_urls` | R | `{"items":{"type":"string"},"type":"array"}` |
| `reference_mask_urls` | O | `{"items":{"type":"string"},"type":"array"}` |

**Response** (`object`); no object-level conditional constraints or additionalProperties restriction declared.

| Field | Presence | Complete property constraints (S; x-fal is M) |
| --- | --- | --- |
| `images` | R | `{"items":{"$ref":"#/components/schemas/File"},"type":"array"}` |
| `seed` | R | `{"type":"integer"}` |

**Illustrative request (not submitted):**
```json
{
  "prompt": "A blue paper bird on a cream background",
  "image_url": "https://example.org/image.png",
  "reference_image_urls": [
    "https://example.org/character.png"
  ]
}
```
**Illustrative response**:
```json
{
  "images": [
    {
      "url": "https://example.org/result.png"
    }
  ],
  "seed": 42
}
```

<a id="a21"></a>

### A21. fal-ai/ideogram/upscale

[Schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/ideogram/upscale) · [Guide / pricing](https://fal.ai/models/fal-ai/ideogram/upscale/llms.txt). Retrieved 2026-09-25 UTC; OpenAPI `3.0.4`; info.version `1.0.0`. Raw schema SHA-256 `057ab35accce215c4728907864dffc0919f1d36fdbd2c68830e7dc4eae5d92c6`.

Input component `IdeogramUpscaleInput`; output component `IdeogramUpscaleOutput`.

**Request** (`object`); no object-level conditional constraints or additionalProperties restriction declared.

| Field | Presence | Complete property constraints (S; x-fal is M) |
| --- | --- | --- |
| `image_url` | R | `{"type":"string"}` |
| `prompt` | O | `{"default":"","anyOf":[{"type":"string"},{"type":"null"}]}` |
| `resemblance` | O | `{"minimum":1,"maximum":100,"type":"integer","default":50}` |
| `detail` | O | `{"minimum":1,"maximum":100,"type":"integer","default":50}` |
| `expand_prompt` | O | `{"default":false,"type":"boolean"}` |
| `seed` | O | `{"anyOf":[{"type":"integer"},{"type":"null"}]}` |
| `sync_mode` | O | `{"default":false,"type":"boolean"}` |

**Response** (`object`); no object-level conditional constraints or additionalProperties restriction declared.

| Field | Presence | Complete property constraints (S; x-fal is M) |
| --- | --- | --- |
| `images` | R | `{"items":{"$ref":"#/components/schemas/File"},"type":"array"}` |
| `seed` | R | `{"type":"integer"}` |

**Illustrative request (not submitted):**
```json
{
  "image_url": "https://example.org/image.png"
}
```
**Illustrative response**:
```json
{
  "images": [
    {
      "url": "https://example.org/result.png"
    }
  ],
  "seed": 42
}
```

<a id="a22"></a>

### A22. fal-ai/ideogram/v3

[Schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/ideogram/v3) · [Guide / pricing](https://fal.ai/models/fal-ai/ideogram/v3/llms.txt). Retrieved 2026-09-25 UTC; OpenAPI `3.0.4`; info.version `1.0.0`. Raw schema SHA-256 `32fd0734e70cc437db13bd6bf093eaf72c8597d7a45d16030ad1c57e0c73aa7d`.

Input component `IdeogramV3Input`; output component `IdeogramV3Output`.

**Request** (`object`); no object-level conditional constraints or additionalProperties restriction declared.

| Field | Presence | Complete property constraints (S; x-fal is M) |
| --- | --- | --- |
| `image_urls` | O | `{"anyOf":[{"items":{"type":"string"},"type":"array"},{"type":"null"}]}` |
| `rendering_speed` | O | `{"enum":["TURBO","BALANCED","QUALITY"],"default":"BALANCED","type":"string"}` |
| `color_palette` | O | `{"anyOf":[{"$ref":"#/components/schemas/ColorPalette"},{"type":"null"}]}` |
| `style_codes` | O | `{"anyOf":[{"items":{"type":"string"},"type":"array"},{"type":"null"}]}` |
| `style` | O | `{"anyOf":[{"enum":["AUTO","GENERAL","REALISTIC","DESIGN"],"type":"string"},{"type":"null"}]}` |
| `expand_prompt` | O | `{"default":true,"type":"boolean"}` |
| `num_images` | O | `{"minimum":1,"maximum":8,"type":"integer","default":1}` |
| `seed` | O | `{"anyOf":[{"type":"integer"},{"type":"null"}]}` |
| `sync_mode` | O | `{"default":false,"type":"boolean"}` |
| `style_preset` | O | `{"anyOf":[{"enum":["80S_ILLUSTRATION","90S_NOSTALGIA","ABSTRACT_ORGANIC","ANALOG_NOSTALGIA","ART_BRUT","ART_DECO","ART_POSTER","AURA","AVANT_GARDE","BAUHAUS","BLUEPRINT","BLURRY_MOTION","BRIGHT_ART","C4D_CARTOON","CHILDRENS_BOOK","COLLAGE","COLORING_BOOK_I","COLORING_BOOK_II","CUBISM","DARK_AURA","DOODLE","DOUBLE_EXPOSURE","DRAMATIC_CINEMA","EDITORIAL","EMOTIONAL_MINIMAL","ETHEREAL_PARTY","EXPIRED_FILM","FLAT_ART","FLAT_VECTOR","FOREST_REVERIE","GEO_MINIMALIST","GLASS_PRISM","GOLDEN_HOUR","GRAFFITI_I","GRAFFITI_II","HALFTONE_PRINT","HIGH_CONTRAST","HIPPIE_ERA","ICONIC","JAPANDI_FUSION","JAZZY","LONG_EXPOSURE","MAGAZINE_EDITORIAL","MINIMAL_ILLUSTRATION","MIXED_MEDIA","MONOCHROME","NIGHTLIFE","OIL_PAINTING","OLD_CARTOONS","PAINT_GESTURE","POP_ART","RETRO_ETCHING","RIVIERA_POP","SPOTLIGHT_80S","STYLIZED_RED","SURREAL_COLLAGE","TRAVEL_POSTER","VINTAGE_GEO","VINTAGE_POSTER","WATERCOLOR","WEIRD","WOODBLOCK_PRINT"],"type":"string"},{"type":"null"}]}` |
| `prompt` | R | `{"type":"string"}` |
| `image_size` | O | `{"default":"square_hd","anyOf":[{"$ref":"#/components/schemas/ImageSize"},{"enum":["square_hd","square","portrait_4_3","portrait_16_9","landscape_4_3","landscape_16_9"],"type":"string"},{"type":"null"}]}` |
| `negative_prompt` | O | `{"default":"","type":"string"}` |

**Response** (`object`); no object-level conditional constraints or additionalProperties restriction declared.

| Field | Presence | Complete property constraints (S; x-fal is M) |
| --- | --- | --- |
| `images` | R | `{"items":{"$ref":"#/components/schemas/File"},"type":"array"}` |
| `seed` | R | `{"type":"integer"}` |

**Illustrative request (not submitted):**
```json
{
  "prompt": "A blue paper bird on a cream background"
}
```
**Illustrative response**:
```json
{
  "images": [
    {
      "url": "https://example.org/result.png"
    }
  ],
  "seed": 42
}
```

<a id="a23"></a>

### A23. fal-ai/ideogram/v3/edit

[Schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/ideogram/v3/edit) · [Guide / pricing](https://fal.ai/models/fal-ai/ideogram/v3/edit/llms.txt). Retrieved 2026-09-25 UTC; OpenAPI `3.0.4`; info.version `1.0.0`. Raw schema SHA-256 `35e9c93f9c9b2c5a1a2b8e27496efe16dc763108340e13b209021c4f05000d1c`.

Input component `IdeogramV3EditInput`; output component `IdeogramV3EditOutput`.

**Request** (`object`); no object-level conditional constraints or additionalProperties restriction declared.

| Field | Presence | Complete property constraints (S; x-fal is M) |
| --- | --- | --- |
| `image_urls` | O | `{"anyOf":[{"items":{"type":"string"},"type":"array"},{"type":"null"}]}` |
| `rendering_speed` | O | `{"enum":["TURBO","BALANCED","QUALITY"],"default":"BALANCED","type":"string"}` |
| `color_palette` | O | `{"anyOf":[{"$ref":"#/components/schemas/ColorPalette"},{"type":"null"}]}` |
| `style_codes` | O | `{"anyOf":[{"items":{"type":"string"},"type":"array"},{"type":"null"}]}` |
| `expand_prompt` | O | `{"default":true,"type":"boolean"}` |
| `num_images` | O | `{"minimum":1,"maximum":8,"type":"integer","default":1}` |
| `seed` | O | `{"anyOf":[{"type":"integer"},{"type":"null"}]}` |
| `sync_mode` | O | `{"default":false,"type":"boolean"}` |
| `style_preset` | O | `{"anyOf":[{"enum":["80S_ILLUSTRATION","90S_NOSTALGIA","ABSTRACT_ORGANIC","ANALOG_NOSTALGIA","ART_BRUT","ART_DECO","ART_POSTER","AURA","AVANT_GARDE","BAUHAUS","BLUEPRINT","BLURRY_MOTION","BRIGHT_ART","C4D_CARTOON","CHILDRENS_BOOK","COLLAGE","COLORING_BOOK_I","COLORING_BOOK_II","CUBISM","DARK_AURA","DOODLE","DOUBLE_EXPOSURE","DRAMATIC_CINEMA","EDITORIAL","EMOTIONAL_MINIMAL","ETHEREAL_PARTY","EXPIRED_FILM","FLAT_ART","FLAT_VECTOR","FOREST_REVERIE","GEO_MINIMALIST","GLASS_PRISM","GOLDEN_HOUR","GRAFFITI_I","GRAFFITI_II","HALFTONE_PRINT","HIGH_CONTRAST","HIPPIE_ERA","ICONIC","JAPANDI_FUSION","JAZZY","LONG_EXPOSURE","MAGAZINE_EDITORIAL","MINIMAL_ILLUSTRATION","MIXED_MEDIA","MONOCHROME","NIGHTLIFE","OIL_PAINTING","OLD_CARTOONS","PAINT_GESTURE","POP_ART","RETRO_ETCHING","RIVIERA_POP","SPOTLIGHT_80S","STYLIZED_RED","SURREAL_COLLAGE","TRAVEL_POSTER","VINTAGE_GEO","VINTAGE_POSTER","WATERCOLOR","WEIRD","WOODBLOCK_PRINT"],"type":"string"},{"type":"null"}]}` |
| `prompt` | R | `{"type":"string"}` |
| `image_url` | R | `{"type":"string"}` |
| `mask_url` | R | `{"type":"string"}` |

**Response** (`object`); no object-level conditional constraints or additionalProperties restriction declared.

| Field | Presence | Complete property constraints (S; x-fal is M) |
| --- | --- | --- |
| `images` | R | `{"items":{"$ref":"#/components/schemas/File"},"type":"array"}` |
| `seed` | R | `{"type":"integer"}` |

**Illustrative request (not submitted):**
```json
{
  "prompt": "A blue paper bird on a cream background",
  "image_url": "https://example.org/image.png",
  "mask_url": "https://example.org/mask.png"
}
```
**Illustrative response**:
```json
{
  "images": [
    {
      "url": "https://example.org/result.png"
    }
  ],
  "seed": 42
}
```

<a id="a24"></a>

### A24. fal-ai/ideogram/v3/layerize-text

[Schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/ideogram/v3/layerize-text) · [Guide / pricing](https://fal.ai/models/fal-ai/ideogram/v3/layerize-text/llms.txt). Retrieved 2026-09-25 UTC; OpenAPI `3.0.4`; info.version `1.0.0`. Raw schema SHA-256 `3bc21c1d0458314e858786ea01b40fa65ab076ee038a54b8a8b7d4c5992d3539`.

Input component `IdeogramV3LayerizeTextInput`; output component `IdeogramV3LayerizeTextOutput`.

**Request** (`object`); no object-level conditional constraints or additionalProperties restriction declared.

| Field | Presence | Complete property constraints (S; x-fal is M) |
| --- | --- | --- |
| `image_url` | R | `{"type":"string"}` |
| `prompt` | O | `{"anyOf":[{"type":"string"},{"type":"null"}]}` |
| `seed` | O | `{"anyOf":[{"type":"integer"},{"type":"null"}]}` |
| `font_file_h1_url` | O | `{"anyOf":[{"type":"string"},{"type":"null"}]}` |
| `font_name_h1` | O | `{"anyOf":[{"type":"string"},{"type":"null"}]}` |
| `font_file_h2_url` | O | `{"anyOf":[{"type":"string"},{"type":"null"}]}` |
| `font_name_h2` | O | `{"anyOf":[{"type":"string"},{"type":"null"}]}` |
| `font_file_body_url` | O | `{"anyOf":[{"type":"string"},{"type":"null"}]}` |
| `font_name_body` | O | `{"anyOf":[{"type":"string"},{"type":"null"}]}` |
| `font_file_small_url` | O | `{"anyOf":[{"type":"string"},{"type":"null"}]}` |
| `font_name_small` | O | `{"anyOf":[{"type":"string"},{"type":"null"}]}` |
| `sync_mode` | O | `{"default":false,"type":"boolean"}` |

**Response** (`object`); no object-level conditional constraints or additionalProperties restriction declared.

| Field | Presence | Complete property constraints (S; x-fal is M) |
| --- | --- | --- |
| `image` | R | `{"$ref":"#/components/schemas/File"}` |
| `prompt` | R | `{"type":"string"}` |
| `text_containers` | O | `{"anyOf":[{"items":{"type":"object"},"type":"array"},{"type":"null"}]}` |
| `text_html` | O | `{"anyOf":[{"type":"string"},{"type":"null"}]}` |
| `image_layers` | O | `{"items":{"type":"object"},"type":"array"}` |
| `seed` | R | `{"type":"integer"}` |

**Illustrative request (not submitted):**
```json
{
  "image_url": "https://example.org/image.png"
}
```
**Illustrative response**:
```json
{
  "image": {
    "url": "https://example.org/image.png"
  },
  "prompt": "A blue paper bird on a cream background",
  "seed": 42
}
```

<a id="a25"></a>

### A25. fal-ai/ideogram/v3/reframe

[Schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/ideogram/v3/reframe) · [Guide / pricing](https://fal.ai/models/fal-ai/ideogram/v3/reframe/llms.txt). Retrieved 2026-09-25 UTC; OpenAPI `3.0.4`; info.version `1.0.0`. Raw schema SHA-256 `4e2d693f10b8a9d76100e53ec408641aff6399017e562ad0213027fbc3d01596`.

Input component `IdeogramV3ReframeInput`; output component `IdeogramV3ReframeOutput`.

**Request** (`object`); no object-level conditional constraints or additionalProperties restriction declared.

| Field | Presence | Complete property constraints (S; x-fal is M) |
| --- | --- | --- |
| `image_urls` | O | `{"anyOf":[{"items":{"type":"string"},"type":"array"},{"type":"null"}]}` |
| `rendering_speed` | O | `{"enum":["TURBO","BALANCED","QUALITY"],"default":"BALANCED","type":"string"}` |
| `color_palette` | O | `{"anyOf":[{"$ref":"#/components/schemas/ColorPalette"},{"type":"null"}]}` |
| `style_codes` | O | `{"anyOf":[{"items":{"type":"string"},"type":"array"},{"type":"null"}]}` |
| `style` | O | `{"anyOf":[{"enum":["AUTO","GENERAL","REALISTIC","DESIGN"],"type":"string"},{"type":"null"}]}` |
| `num_images` | O | `{"minimum":1,"maximum":8,"type":"integer","default":1}` |
| `seed` | O | `{"anyOf":[{"type":"integer"},{"type":"null"}]}` |
| `sync_mode` | O | `{"default":false,"type":"boolean"}` |
| `style_preset` | O | `{"anyOf":[{"enum":["80S_ILLUSTRATION","90S_NOSTALGIA","ABSTRACT_ORGANIC","ANALOG_NOSTALGIA","ART_BRUT","ART_DECO","ART_POSTER","AURA","AVANT_GARDE","BAUHAUS","BLUEPRINT","BLURRY_MOTION","BRIGHT_ART","C4D_CARTOON","CHILDRENS_BOOK","COLLAGE","COLORING_BOOK_I","COLORING_BOOK_II","CUBISM","DARK_AURA","DOODLE","DOUBLE_EXPOSURE","DRAMATIC_CINEMA","EDITORIAL","EMOTIONAL_MINIMAL","ETHEREAL_PARTY","EXPIRED_FILM","FLAT_ART","FLAT_VECTOR","FOREST_REVERIE","GEO_MINIMALIST","GLASS_PRISM","GOLDEN_HOUR","GRAFFITI_I","GRAFFITI_II","HALFTONE_PRINT","HIGH_CONTRAST","HIPPIE_ERA","ICONIC","JAPANDI_FUSION","JAZZY","LONG_EXPOSURE","MAGAZINE_EDITORIAL","MINIMAL_ILLUSTRATION","MIXED_MEDIA","MONOCHROME","NIGHTLIFE","OIL_PAINTING","OLD_CARTOONS","PAINT_GESTURE","POP_ART","RETRO_ETCHING","RIVIERA_POP","SPOTLIGHT_80S","STYLIZED_RED","SURREAL_COLLAGE","TRAVEL_POSTER","VINTAGE_GEO","VINTAGE_POSTER","WATERCOLOR","WEIRD","WOODBLOCK_PRINT"],"type":"string"},{"type":"null"}]}` |
| `image_url` | R | `{"type":"string"}` |
| `image_size` | R | `{"anyOf":[{"$ref":"#/components/schemas/ImageSize"},{"enum":["square_hd","square","portrait_4_3","portrait_16_9","landscape_4_3","landscape_16_9"],"type":"string"}]}` |

**Response** (`object`); no object-level conditional constraints or additionalProperties restriction declared.

| Field | Presence | Complete property constraints (S; x-fal is M) |
| --- | --- | --- |
| `images` | R | `{"items":{"$ref":"#/components/schemas/File"},"type":"array"}` |
| `seed` | R | `{"type":"integer"}` |

**Illustrative request (not submitted):**
```json
{
  "image_url": "https://example.org/image.png",
  "image_size": "square_hd"
}
```
**Illustrative response**:
```json
{
  "images": [
    {
      "url": "https://example.org/result.png"
    }
  ],
  "seed": 42
}
```

<a id="a26"></a>

### A26. fal-ai/ideogram/v3/remix

[Schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/ideogram/v3/remix) · [Guide / pricing](https://fal.ai/models/fal-ai/ideogram/v3/remix/llms.txt). Retrieved 2026-09-25 UTC; OpenAPI `3.0.4`; info.version `1.0.0`. Raw schema SHA-256 `31d93c5fb63685678347d8055a870c9bf75f4f75867353b006b6af376aa09c4d`.

Input component `IdeogramV3RemixInput`; output component `IdeogramV3RemixOutput`.

**Request** (`object`); no object-level conditional constraints or additionalProperties restriction declared.

| Field | Presence | Complete property constraints (S; x-fal is M) |
| --- | --- | --- |
| `image_urls` | O | `{"anyOf":[{"items":{"type":"string"},"type":"array"},{"type":"null"}]}` |
| `rendering_speed` | O | `{"enum":["TURBO","BALANCED","QUALITY"],"default":"BALANCED","type":"string"}` |
| `color_palette` | O | `{"anyOf":[{"$ref":"#/components/schemas/ColorPalette"},{"type":"null"}]}` |
| `style_codes` | O | `{"anyOf":[{"items":{"type":"string"},"type":"array"},{"type":"null"}]}` |
| `style` | O | `{"anyOf":[{"enum":["AUTO","GENERAL","REALISTIC","DESIGN"],"type":"string"},{"type":"null"}]}` |
| `expand_prompt` | O | `{"default":true,"type":"boolean"}` |
| `num_images` | O | `{"minimum":1,"maximum":8,"type":"integer","default":1}` |
| `seed` | O | `{"anyOf":[{"type":"integer"},{"type":"null"}]}` |
| `sync_mode` | O | `{"default":false,"type":"boolean"}` |
| `prompt` | R | `{"type":"string"}` |
| `image_url` | R | `{"type":"string"}` |
| `strength` | O | `{"minimum":0.01,"maximum":1,"type":"number","default":0.8}` |
| `image_size` | O | `{"default":"square_hd","anyOf":[{"$ref":"#/components/schemas/ImageSize"},{"enum":["square_hd","square","portrait_4_3","portrait_16_9","landscape_4_3","landscape_16_9"],"type":"string"},{"type":"null"}]}` |
| `negative_prompt` | O | `{"default":"","type":"string"}` |

**Response** (`object`); no object-level conditional constraints or additionalProperties restriction declared.

| Field | Presence | Complete property constraints (S; x-fal is M) |
| --- | --- | --- |
| `images` | R | `{"items":{"$ref":"#/components/schemas/File"},"type":"array"}` |
| `seed` | R | `{"type":"integer"}` |

**Illustrative request (not submitted):**
```json
{
  "prompt": "A blue paper bird on a cream background",
  "image_url": "https://example.org/image.png"
}
```
**Illustrative response**:
```json
{
  "images": [
    {
      "url": "https://example.org/result.png"
    }
  ],
  "seed": 42
}
```

<a id="a27"></a>

### A27. fal-ai/ideogram/v3/replace-background

[Schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/ideogram/v3/replace-background) · [Guide / pricing](https://fal.ai/models/fal-ai/ideogram/v3/replace-background/llms.txt). Retrieved 2026-09-25 UTC; OpenAPI `3.0.4`; info.version `1.0.0`. Raw schema SHA-256 `a430f9bfc1a34bf8c9ad3e147aa282c2d2129aab5c5ea48ae71eae906886a551`.

Input component `IdeogramV3ReplaceBackgroundInput`; output component `IdeogramV3ReplaceBackgroundOutput`.

**Request** (`object`); no object-level conditional constraints or additionalProperties restriction declared.

| Field | Presence | Complete property constraints (S; x-fal is M) |
| --- | --- | --- |
| `image_urls` | O | `{"anyOf":[{"items":{"type":"string"},"type":"array"},{"type":"null"}]}` |
| `rendering_speed` | O | `{"enum":["TURBO","BALANCED","QUALITY"],"default":"BALANCED","type":"string"}` |
| `color_palette` | O | `{"anyOf":[{"$ref":"#/components/schemas/ColorPalette"},{"type":"null"}]}` |
| `style_codes` | O | `{"anyOf":[{"items":{"type":"string"},"type":"array"},{"type":"null"}]}` |
| `style` | O | `{"anyOf":[{"enum":["AUTO","GENERAL","REALISTIC","DESIGN"],"type":"string"},{"type":"null"}]}` |
| `expand_prompt` | O | `{"default":true,"type":"boolean"}` |
| `num_images` | O | `{"minimum":1,"maximum":8,"type":"integer","default":1}` |
| `seed` | O | `{"anyOf":[{"type":"integer"},{"type":"null"}]}` |
| `sync_mode` | O | `{"default":false,"type":"boolean"}` |
| `style_preset` | O | `{"anyOf":[{"enum":["80S_ILLUSTRATION","90S_NOSTALGIA","ABSTRACT_ORGANIC","ANALOG_NOSTALGIA","ART_BRUT","ART_DECO","ART_POSTER","AURA","AVANT_GARDE","BAUHAUS","BLUEPRINT","BLURRY_MOTION","BRIGHT_ART","C4D_CARTOON","CHILDRENS_BOOK","COLLAGE","COLORING_BOOK_I","COLORING_BOOK_II","CUBISM","DARK_AURA","DOODLE","DOUBLE_EXPOSURE","DRAMATIC_CINEMA","EDITORIAL","EMOTIONAL_MINIMAL","ETHEREAL_PARTY","EXPIRED_FILM","FLAT_ART","FLAT_VECTOR","FOREST_REVERIE","GEO_MINIMALIST","GLASS_PRISM","GOLDEN_HOUR","GRAFFITI_I","GRAFFITI_II","HALFTONE_PRINT","HIGH_CONTRAST","HIPPIE_ERA","ICONIC","JAPANDI_FUSION","JAZZY","LONG_EXPOSURE","MAGAZINE_EDITORIAL","MINIMAL_ILLUSTRATION","MIXED_MEDIA","MONOCHROME","NIGHTLIFE","OIL_PAINTING","OLD_CARTOONS","PAINT_GESTURE","POP_ART","RETRO_ETCHING","RIVIERA_POP","SPOTLIGHT_80S","STYLIZED_RED","SURREAL_COLLAGE","TRAVEL_POSTER","VINTAGE_GEO","VINTAGE_POSTER","WATERCOLOR","WEIRD","WOODBLOCK_PRINT"],"type":"string"},{"type":"null"}]}` |
| `prompt` | R | `{"type":"string"}` |
| `image_url` | R | `{"type":"string"}` |

**Response** (`object`); no object-level conditional constraints or additionalProperties restriction declared.

| Field | Presence | Complete property constraints (S; x-fal is M) |
| --- | --- | --- |
| `images` | R | `{"items":{"$ref":"#/components/schemas/File"},"type":"array"}` |
| `seed` | R | `{"type":"integer"}` |

**Illustrative request (not submitted):**
```json
{
  "prompt": "A blue paper bird on a cream background",
  "image_url": "https://example.org/image.png"
}
```
**Illustrative response**:
```json
{
  "images": [
    {
      "url": "https://example.org/result.png"
    }
  ],
  "seed": 42
}
```

## Appendix B — all nested definitions

These definitions were compared across every referencing endpoint; the stripped validation/metadata definitions match wherever the same name appears. References do not import fields across operations. All definitions have object type and no required properties unless listed in `required`.

### QueueStatus
```json
{
  "type": "object",
  "properties": {
    "status": {
      "type": "string",
      "enum": [
        "IN_QUEUE",
        "IN_PROGRESS",
        "COMPLETED"
      ]
    },
    "request_id": {
      "type": "string"
    },
    "response_url": {
      "type": "string"
    },
    "status_url": {
      "type": "string"
    },
    "cancel_url": {
      "type": "string"
    },
    "logs": {
      "type": "object",
      "additionalProperties": true
    },
    "metrics": {
      "type": "object",
      "additionalProperties": true
    },
    "queue_position": {
      "type": "integer"
    }
  },
  "required": [
    "status",
    "request_id"
  ]
}
```
### ImageSize
```json
{
  "properties": {
    "height": {
      "default": 512,
      "maximum": 14142,
      "type": "integer",
      "exclusiveMinimum": 0
    },
    "width": {
      "default": 512,
      "maximum": 14142,
      "type": "integer",
      "exclusiveMinimum": 0
    }
  },
  "type": "object"
}
```
### ImageFile
```json
{
  "properties": {
    "content_type": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ]
    },
    "height": {
      "anyOf": [
        {
          "type": "integer"
        },
        {
          "type": "null"
        }
      ]
    },
    "width": {
      "anyOf": [
        {
          "type": "integer"
        },
        {
          "type": "null"
        }
      ]
    },
    "file_size": {
      "anyOf": [
        {
          "type": "integer"
        },
        {
          "type": "null"
        }
      ]
    },
    "file_name": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ]
    },
    "url": {
      "type": "string"
    }
  },
  "type": "object",
  "required": [
    "url"
  ]
}
```
### LoRAInput
```json
{
  "properties": {
    "scale": {
      "minimum": 0,
      "maximum": 4,
      "type": "number",
      "default": 1
    },
    "path": {
      "type": "string"
    }
  },
  "type": "object",
  "required": [
    "path"
  ]
}
```
### File
```json
{
  "properties": {
    "url": {
      "type": "string"
    },
    "content_type": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ]
    },
    "file_size": {
      "anyOf": [
        {
          "type": "integer"
        },
        {
          "type": "null"
        }
      ]
    },
    "file_name": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "type": "object",
  "required": [
    "url"
  ]
}
```
### ColorPalette
```json
{
  "properties": {
    "name": {
      "anyOf": [
        {
          "enum": [
            "EMBER",
            "FRESH",
            "JUNGLE",
            "MAGIC",
            "MELON",
            "MOSAIC",
            "PASTEL",
            "ULTRAMARINE"
          ],
          "type": "string"
        },
        {
          "type": "null"
        }
      ]
    },
    "members": {
      "anyOf": [
        {
          "items": {
            "$ref": "#/components/schemas/ColorPaletteMember"
          },
          "type": "array"
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "type": "object"
}
```
### ColorPaletteMember
```json
{
  "properties": {
    "rgb": {
      "$ref": "#/components/schemas/RGBColor"
    },
    "color_weight": {
      "default": 0.5,
      "anyOf": [
        {
          "minimum": 0.05,
          "maximum": 1,
          "type": "number"
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "type": "object",
  "required": [
    "rgb"
  ]
}
```
### RGBColor
```json
{
  "properties": {
    "r": {
      "minimum": 0,
      "maximum": 255,
      "type": "integer",
      "default": 0
    },
    "g": {
      "minimum": 0,
      "maximum": 255,
      "type": "integer",
      "default": 0
    },
    "b": {
      "minimum": 0,
      "maximum": 255,
      "type": "integer",
      "default": 0
    }
  },
  "type": "object"
}
```

## Appendix C — source identity ledger

All schema hashes are SHA-256 over exact downloaded bytes, not reformatted JSON. Guide hashes identify the corresponding endpoint `/llms.txt` snapshot, including pricing prose. Retrieval date: 2026-09-25 UTC. Capture occurred during this drafting session; immutable provider historical URLs are not available, so re-fetch drift is expected and must be recorded.

| Endpoint | Raw schema SHA-256 | Guide SHA-256 |
| --- | --- | --- |
| `ideogram/v4` | `d83cf73ad6afecb49c2c1c094e8876674d0b844d0c1bda93b8ec804026653806` | `736e671a2727154af39788e6dbab9ba1bc6bca22142d71bb42e6b6a5e7120a90` |
| `ideogram/v4/fast` | `a6db6ca26a594018c8ad9315d46e09e30a42d18b2483a412502c1a1943e5c91e` | `83d59d915dbdc839aabc7ace0a23c389625a95efb3c1d52e27dbba6a66599730` |
| `ideogram/v4/image-to-image` | `44262f4376e55aead06f8b56cfbc8d8f32d240484b06c7c9164f6867184e9fa6` | `d3651e99d8bbd5c1b7e0ee6968d54767e6389ddf93865d4612adc126642e3072` |
| `ideogram/v4/image-to-image/lora` | `391081e2e09dbf08d8f7db59e9349d23e4d444a8819f8f01213a7929b5e5e193` | `eaaf29bd88c84ddec2b47ec924936f1e6115754db7c5bec1ba1b2de948c253b4` |
| `ideogram/v4/image-to-image/lora/stream` | `21b8009c6d632817855d4252b4bdb78d10c17be633f36af509f77367bb79983e` | `2e7737afb088ba008053c4ad38ef7b0f59cb3f2dfdeb28d0b137f07ff7499adb` |
| `ideogram/v4/image-to-image/stream` | `3f1469685499df946e3a750db792dc5d66c08caca72ed190fb7d9ed2369ce607` | `a69a90d5c9d570c0731930c694af9a6d9b7467e89b66d4bbabdd67ba45cfbdf4` |
| `ideogram/v4/inpaint` | `a04dd440c2ad322730020cd99b1abe07bd16115ab5db1563f44239dc8d27a149` | `953e77dd0c3b6e22fef426717de13aff6af9030b0235437ec0b77facbe750607` |
| `ideogram/v4/inpaint/lora` | `c7a156d6fa86482abf3add45c55dc6cc9b0e7ba58bb77982884cf9cf0e5b8bdb` | `f3bf9df9062754f99843b8d605019f419de1670c5b2ecce039c1e6ebd28d2530` |
| `ideogram/v4/instant` | `e8ddffdfef2072067915ae0a257c60439900e978468d7753bc0cf9176c525027` | `12b5098faaa92e8f29f762e601bfde7b064bdf1e929f960aa1ddb6bbf0ad998f` |
| `ideogram/v4/lora` | `c5c544d3883e7f3392139adac4c2a41cbeae7fd88a9d7762c4733238ba9848b6` | `e9c0c45a93c2a3545675f7e6b41d5ee11a5559a9d7921f6c7dc6e5de55a6b348` |
| `ideogram/v4/lora/stream` | `639eb160f80f412a63c1470d0657dceedad9f4a060af594a8765bfec6b09b20e` | `2469a311e9ec406ad989035ef63c96532ff5a08521ac1a4d4e019e35d9f46d83` |
| `ideogram/v4/stream` | `c5dc0e181f1875f846ebc4d46210500fbca130c7adef5ab52588cd8b10685895` | `a12cf20c3c4fca8896f30e4b0e9e91641e36ef1ac8b332d98b69b027aa492e55` |
| `ideogram/v4/tiling` | `5f1177b1a4302825af51cf729780789de62ec3c5b7775962d4c19a4f707395b0` | `14ecf5c482b4ca9daa224c0e4910c0eb46b5bf2c0fc8684e8b1444da656db502` |
| `ideogram/v4/tiling/lora` | `04c269b6673f5a38a68b0a26fd29893e73048fe3da4a2f36c9d38229219ed474` | `2d40be8e41cbfe05a42332c71cd8d0e9d8bf8e283685d82eb9e686302ce46af2` |
| `ideogram/v4/tiling/lora/stream` | `136968ca1ad745accc469e0a28d0a44476d8dff02aab2a3a8752800f3819d2f5` | `d35ed4c1b6c0850a345d10e3f2e5fd61640ea33baf1b7b949be49ce9123f6cbb` |
| `ideogram/v4/tiling/stream` | `6272afc4cca2d3aedb8729f203f5f15e873cba46e49cd1c09e91a050f8ad432f` | `c991de8ec7ddea2aa3a9999a9ef2ce8a4cff0532bd0ad24a79afc2e73ffc606b` |
| `ideogram/v4/trainer` | `b35fcc12da58c1ba01a36fd76534a1cc11555ff7ce7d67ae748c1accab91c604` | `b1cd1ec6f8279bc2487b78ac6f0ad0fafc5d0c015bf9644cdaedfd529d3821f8` |
| `fal-ai/ideogram/character` | `7f6721951cd7ca4b025b06f92dfeab3c3db40efef3b9507da09153ae812a05a3` | `178a622818b4abffb785cf80c1c6f87c11123b43111c11567c02d7fdab8b1118` |
| `fal-ai/ideogram/character/edit` | `bf5d47d8b9130f77fbad1db0430d982e07d4bc6f857a5182d936bc45f852bf06` | `087b20ae45c14f2fe46486aa0353573ea1fd75ac68d87c01b37d02be250f5652` |
| `fal-ai/ideogram/character/remix` | `62caceba22724896a4c7436e0e4e2fbc8ad9ef49c46a75d278886bbf767926b4` | `129b51dd7c9a6755ac66c09470483750005c190856999fb79bae194ff0d30ba8` |
| `fal-ai/ideogram/upscale` | `057ab35accce215c4728907864dffc0919f1d36fdbd2c68830e7dc4eae5d92c6` | `961fe95c61520e867b1d65260fcea6d68756decf304d4b483b08c91db529386e` |
| `fal-ai/ideogram/v3` | `32fd0734e70cc437db13bd6bf093eaf72c8597d7a45d16030ad1c57e0c73aa7d` | `cf235e6ce52597c1738ce6715b60cac01d804f160b33324a0d63d409f4d04ec2` |
| `fal-ai/ideogram/v3/edit` | `35e9c93f9c9b2c5a1a2b8e27496efe16dc763108340e13b209021c4f05000d1c` | `8c9ea22a9d847df0298e986961d78282fec1887a3a993d39445a4de0bd7125bd` |
| `fal-ai/ideogram/v3/layerize-text` | `3bc21c1d0458314e858786ea01b40fa65ab076ee038a54b8a8b7d4c5992d3539` | `24205359d86ed701a9572d0ef784fbe781b56c21e03d75554943e770470dce77` |
| `fal-ai/ideogram/v3/reframe` | `4e2d693f10b8a9d76100e53ec408641aff6399017e562ad0213027fbc3d01596` | `b2acb6c583313f773764c27cd776302778afd5941859ab8c2531ae0429f76894` |
| `fal-ai/ideogram/v3/remix` | `31d93c5fb63685678347d8055a870c9bf75f4f75867353b006b6af376aa09c4d` | `13d345bb81d3fedcb6af942dbdccbe18dea7fd9d8c39e28abb5ee6bb56413375` |
| `fal-ai/ideogram/v3/replace-background` | `a430f9bfc1a34bf8c9ad3e147aa282c2d2129aab5c5ea48ae71eae906886a551` | `671df9d7fd90ccbfd0649c8289e922e68c8515f909d436ef1ce7e1b71bef3a9b` |

### Discovery and protocol snapshot identities

| Source | SHA-256 |
| --- | --- |
| [catalog](https://fal.ai/models/ideogram/v4) | `16ad1d8192f529caaa93a4a9f1e6eb59a4cb7e3c36195fc6812082a49c9ed824` |
| [explore](https://fal.ai/explore/ideogram) | `61a04e2d3a93b6177b32d39a9769d7e6526d720912e17f9ecf28149ed7b4cf9c` |
| [family](https://fal.ai/ideogram-4) | `4cf8ff9b19096bf67ed25bb31916ad13951b132930821cfe78e0ca5a56240b8d` |
| [queue](https://fal.ai/docs/documentation/model-apis/inference/queue.md) | `577c207e98e21b13a2a33505feb704562d5e028d7f11e0e480975487cf4313e6` |
| [webhooks](https://fal.ai/docs/documentation/model-apis/inference/webhooks.md) | `bf76cb38c37ebde1d3ed3108648e4a217bad032a39b0b2182435643738d037a6` |
| [cdn](https://fal.ai/docs/documentation/model-apis/fal-cdn.md) | `d2790e48b527f034a228252407cdda087d187e9a7d5ccd79f5cb660fb830365d` |
| [retention](https://fal.ai/docs/documentation/model-apis/media-expiration.md) | `77d6d254a08b1edf7eeda40abe558dcc1d552024e80240738eafcfc2fdd46a09` |
| [headers](https://fal.ai/docs/documentation/model-apis/common-parameters.md) | `33d81720bbb4f0433ef178ae13f48882e3c03a33d08cc16d9e038f791bbff56b` |
| [reliability](https://fal.ai/docs/documentation/model-apis/inference/reliability.md) | `95d277a2917fc362d1df2ce79081ed48056955455939cb03cc01e18cd9669709` |
| [limits](https://fal.ai/docs/documentation/model-apis/concurrency-limits.md) | `0e641fdef47e433f8ade3d8ee5da83b9fc31d27861b43e50992342d449f0ed58` |
| [errors](https://fal.ai/docs/documentation/model-apis/request-errors.md) | `7cf89d6279aca693e8fe162d6cc7ef41654aec91c2fb94da81af575b397c2346` |
| [model-errors](https://fal.ai/docs/documentation/model-apis/errors.md) | `a61c4ef50499d2b26e971377b2a1e5d382ea9078f3ebe550911f09e47ddf8e0c` |
| [streaming](https://fal.ai/docs/documentation/model-apis/inference/streaming.md) | `6674504e8563efd41ac016a8303d7e418f505bff4b5f612df725ddd818a6e0cd` |
| [sdk-retry](https://fal.ai/docs/api-reference/client-libraries/javascript/retry.md) | `0623283a0f3b08f38b6e481ea51ee82419b0ba67aa500a22b714a210509d034b` |
| [sdk-queue](https://fal.ai/docs/api-reference/client-libraries/javascript/queue.md) | `75567f39937f79c7f0d1decb8686bd36429316c3964ef7fd1246ff79f0a46e8f` |
| [arguments](https://fal.ai/docs/documentation/model-apis/model-arguments.md) | `fe8a6f861770c754b15be0874bcbb542d107b58eceb00039587878705a64ed36` |
## API-1.2 amendment — structured composition and native editable text

**API-1.2 evidence amendment, retrieved 2026-09-25 UTC; independently approved for source readiness.** This amendment supersedes API-1.1's blanket “prompt aids only” treatment of V4 style/palette controls and its unresolved product disposition for Fast/native text. It preserves the complete 27-schema inventory, transport/training contracts, corrected editing-LoRA routing, and Appendices A–D. Fast belongs in the initial editor; tiling remains later. Native editable text is an initial app requirement even though the verified Fal responses are raster images. This amendment is API evidence and a downstream contract proposal, not implemented UX/architecture or a passed paid-provider check.

<a id="e1"></a>

### E1. Evidence boundary: three distinct contracts

1. **Fal HTTP contract (S/P):** all 16 captured V4 inference routes accept required `prompt:string`. None declares a top-level `json_prompt`, `compositional_deconstruction`, `elements`, `bbox`, `style_description` or native text/layer output. Ten ordinary inference outputs require `prompt:string`, described as the prompt used for generation. Six stream output schemas remain empty; no structured stream event contract can be inferred. The trainer is separate and has no such inference prompt field.
2. **Ideogram model caption convention (P/code):** the official [model site](https://ideogram.ai/models/4.0) links the [official repository](https://github.com/ideogram-oss/ideogram4). Its pinned [prompting guide](https://github.com/ideogram-oss/ideogram4/blob/990fe1c4e950bb9e9dc90e01c0ad98ba434f83c2/docs/prompting.md) documents structured JSON captions serialized as strings. This is genuine documented input guidance, beyond the Fal response example. The nested vocabulary below comes from that guide and audited source code; it is not a new Fal JSON Schema.
3. **Ideogram's own hosted API (separate S/P):** [V4 generate](https://developer.ideogram.ai/api-reference/generate-images/generate-v4), [Magic Prompt](https://developer.ideogram.ai/api-reference/describe-prompts/magic-prompt-v4) and [Describe](https://developer.ideogram.ai/api-reference/describe-prompts/describe-v4) publish a typed `V4JsonPrompt`. On that service, `text_prompt` enables automatic expansion, whereas mutually exclusive `json_prompt` disables it. Those fields belong to `api.ideogram.ai`, authenticated with `Api-Key`, not Fal. They corroborate the model concept, without authorizing another provider, a describe/OCR call, another credential, or silently transplanting fields into Fal.

**Concrete Fal example, not runtime verification:** the [base model page](https://fal.ai/models/ideogram/v4) publishes a response with keys `images,timings,seed,has_nsfw_concepts,prompt`. Parsing its prompt string yields `high_level_description` and `compositional_deconstruction`; the latter contains `background` and six ordered elements: four `obj` and two `text`. Objects contain `type,desc`; text elements contain `type,text,desc`. This particular example contains no bounding boxes or style block. Therefore it establishes a published example of nested content in a string, not mandatory response shape, text detection accuracy, native font information, element IDs, or per-route support. The [Fal family page](https://fal.ai/ideogram-4) separately advertises bounding-box prompting; it does not define coordinate semantics or an editable document schema.

Evidence labels here extend the original S/M/P/R distinction: **model-guide/code** means pinned upstream source semantics; **app policy** means a proposed local contract; **runtime qualification** means still untested. No generated image, paid inference, training, key, upload, model download or app build was used.

<a id="e2"></a>

### E2. Complete nested caption vocabulary

Use the **model-guide profile** below for app-authored caption serialization, with revision identity kept in the app document/job sidecar. This profile name is ours; it is not a provider version field. Preserve upstream distinctions rather than merging the more permissive hosted API into a false single schema.

| Path | Type / presence in model-guide profile | Constraints, meaning and ordering |
| --- | --- | --- |
| caption root | JSON object, required after parsing the prompt string | Known keys: `high_level_description,style_description,compositional_deconstruction`. Use this order for authored serialization. The verifier does not enforce root order. No provider version discriminator is declared. |
| `high_level_description` | Optional string; strongly recommended by guide | Whole-scene description. Guide recommends one or two sentences; no general enforced character limit/default. Hosted Ideogram V4JsonPrompt instead requires this field. App-authored profile includes it to satisfy both expectations. |
| `style_description` | Optional object | Omit entirely when unused. If present, guide requires aesthetics, lighting, medium and exactly one of photo/art_style. No null representation is documented. |
| `style_description.aesthetics` | Required string within guide style block | Mood/aesthetic description; no fixed enum/default/length bound. |
| `style_description.lighting` | Required string within guide style block | Lighting description; no fixed enum/default/length bound. |
| `style_description.photo` | String, exactly one of photo/art_style | Photographic camera/lens/style guidance. Guide pairs photo with medium photograph; the verifier checks key presence/order, not this value relationship. |
| `style_description.medium` | Required string within guide style block | Examples include photograph, illustration, painting, 3d_render and graphic_design; these are examples, not a closed enum. |
| `style_description.art_style` | String, exactly one of art_style/photo | Non-photographic style description. A value such as vector illustration does not request vector output. |
| `style_description.color_palette` | Optional array of strings | At most 16 entries; uppercase `#RRGGBB`, no shorthand or alpha. Final style key. Empty array is not prohibited by verifier; no default palette. |
| `compositional_deconstruction` | Required object | Exactly background followed by elements in guide profile. It describes the scene; it is not a raster layer container. |
| `…background` | Required string | Scene/background description; not a background image URL, transparent layer, or background-removal operation. |
| `…elements` | Required array of element objects | Preserve array order. No documented maximum/minimum count; verifier accepts empty array. No nested children/groups are defined. |
| `…elements[*].type` | Required string | Closed enum `obj` or `text`; first element key. |
| `…elements[*].bbox` | Optional array of four integers | `[y_min,x_min,y_max,x_max]`; each 0–1000 inclusive, normalized separately to image height/width; top-left origin. Appears immediately after type. Omission leaves placement to the caption/model; it does not imply a full-frame box. No null is documented. |
| `…elements[*].text` | Required string for text; forbidden for obj in guide profile | Literal in-image text, before desc. Preserve Unicode and explicit line breaks. No language enum, maximum length or exact rendering guarantee is declared. |
| `…elements[*].desc` | Required string for both variants | Object description or text appearance/role/placement guidance. No structured font family/size/weight/line-height/alignment fields are defined. |
| `…elements[*].color_palette` | Optional array of strings | At most five uppercase `#RRGGBB` entries; last key. Describes a color preference, not exact color segmentation or pixel replacement. |

Exact nested key orders, omitting only optional keys:

- Photo style: `aesthetics,lighting,photo,medium,color_palette`.
- Other style: `aesthetics,lighting,medium,art_style,color_palette`.
- Object: `type,bbox,desc,color_palette`.
- Text: `type,bbox,text,desc,color_palette`.

Optional does not mean nullable. The guide gives no automatic defaults for missing strings/objects/boxes/palettes; do not insert guessed descriptions or silently turn null into empty text. A stricter app-authored profile may require nonempty user content and positive-area boxes, but must label those as app rules.

**Hosted API differences:** its documented V4JsonPrompt requires high_level_description and composition. It describes all style children as optional and does not state the guide's photo/art_style XOR or key-order requirements. Its palette prose calls color conditioning a soft bias; its type listing does not state 16/5 caps or uppercase-only syntax. Both sources agree on obj/text descriptions, literal text, and four row-first integer coordinates in 0–1000. Preserve source-specific constraints. Do not claim that every shape accepted by the hosted type listing follows the model-guide profile, or that Fal enforces either nested contract.

**Element order is not a layer order guarantee.** The hosted type describes an ordered list. An upstream expansion prompt suggests putting wall-mounted decoration first to encourage rendering behind foreground objects. That is guidance to an expansion model, not evidence of deterministic painter's-order compositing, stable element identity, isolated alpha layers, or guaranteed occlusion. Preserve order for provenance and editing; do not infer the app's layer stack solely from it.

<a id="e3"></a>

### E3. Expansion and full-family applicability audit

On 2026-09-25 at 20:51 UTC, all 17 V4 schema documents were downloaded again and compared byte-for-byte with API-1.1: **17 unchanged**. Appendix A remains the full schema source of truth. All inference prompt fields are required non-null strings, with no nested schema or declared maxLength. Expansion is optional, non-null string, default Medium. Stream route selection changes transport; it does not create a distinct editor operation.

| Fal route under `ideogram/v4` | Expansion enum | Prompt result contract | Scope / caption qualification |
| --- | --- | --- | --- |
| base | None / Medium / Large | required string | Initial; serialized model-caption candidate |
| /instant | None / Medium | required string | Initial; Large invalid; no source/mask/adapters fields |
| /fast | None / Medium | required string | Initial; separate route, not an Instant synonym |
| /image-to-image | None / Medium / Large | required string | Initial; source required |
| /inpaint | None / Medium / Large | required string | Initial; source and mask required |
| /lora | None / Medium / Large | required string | Initial; adapter path; no source/mask fields |
| /image-to-image/lora | None / Medium / Large | required string | Initial; supported source + adapters route |
| /inpaint/lora | None / Medium / Large | required string | Initial; supported source + mask + adapters route |
| /tiling | None / Medium / Large | required string | Later; preserve existing conditional source/mask rules |
| /tiling/lora | None / Medium / Large | required string | Later; preserve existing conditional source/mask rules |
| /stream | None / Medium / Large | empty output schema | Base stream transport; caption semantics runtime-unverified |
| /lora/stream | None / Medium / Large | empty output schema | LoRA stream transport; same qualification |
| /image-to-image/stream | None / Medium / Large | empty output schema | Editing stream transport; same qualification |
| /image-to-image/lora/stream | None / Medium / Large | empty output schema | Editing + LoRA stream transport; same qualification |
| /tiling/stream | None / Medium / Large | empty output schema | Later tiling stream transport |
| /tiling/lora/stream | None / Medium / Large | empty output schema | Later tiling + LoRA stream transport |
| /trainer | Not applicable | weights/config outputs | Training captions/archive are a different contract |

**Published expansion meaning:** Fal base-family prose says None disables expansion and avoids its expansion fee; Medium is fast; Large uses Ideogram's Magic Prompt and is marketed for highest quality. Instant/Fast prose describes Medium as the fast magic-prompt model and None as disabling expansion. These are provider descriptions, not measured latency/quality guarantees. No model/version identifier, exact rewrite algorithm, bbox preservation rule, style preservation rule, nested error response, or deterministic expansion behavior is documented in those fields. The numerical Medium/Large surcharge remains unresolved by the existing cost evidence.

**Proposed app serialization path (not a completed Fal contract test):** construct a caption using the guide profile, serialize it once into the Fal prompt string, and explicitly choose expansion None when requesting preservation of that authored caption. This follows the model's documented string input and Fal's no-expansion setting. Fal's schema/prose does not explicitly promise byte-for-byte forwarding or identical structured behavior across all routes; that last mile stays a runtime qualification. Never send the parsed object as Fal prompt, nor add json_prompt as a guessed outer field.

**Plain text:** Medium is the declared Fal default; Large is available only on the listed routes. The upstream local-model guide warns that raw natural language without expansion is unsuitable, but that is not proof Fal will reject every plain prompt with None. Show the distinction and do not equate “schema-valid string” with “documented good model caption.” User-authored structured content must not be silently sent through expansion: any requested rewrite can alter text, object count, coordinates, colors or scene detail. Record the chosen expansion and retain both the original caption and the returned actual prompt.

**Instant versus Fast:** both have the smaller expansion enum and 2048-side sizing metadata. Fast retains rendering_speed; Instant does not. Neither declares acceleration, source, mask or loras. Do not silently change route to accommodate source/mask or adapters. Structured captions do not relax operation compatibility or upload requirements.

<a id="e4"></a>

### E4. Example and coordinate mapping

Authored model-guide example (illustration only; not a provider result):

```json
{
  "high_level_description": "A minimal card with a bird and a two-line heading.",
  "style_description": {
    "aesthetics": "Simple and calm",
    "lighting": "Even",
    "medium": "graphic_design",
    "art_style": "Flat shapes",
    "color_palette": ["#F8F0DC", "#145DA0"]
  },
  "compositional_deconstruction": {
    "background": "Cream paper",
    "elements": [
      {"type": "obj", "bbox": [400, 600, 800, 900], "desc": "A blue paper bird"},
      {"type": "text", "bbox": [100, 100, 300, 900], "text": "Café\n東京", "desc": "A dark blue heading", "color_palette": ["#145DA0"]}
    ]
  }
}
```

The app adapter would construct `{prompt: JSON.stringify(caption), expansion_model: "None", ...validatedEndpointFields}`; the SDK serializes that outer request to JSON. There are two structural levels, not two serializations of the caption value. After decoding the HTTP body, prompt must be a string whose single JSON parse yields the caption object. An object in prompt is S-invalid; a string containing another JSON-encoded string is outer-schema-valid but fails the caption profile. Minified JSON with literal Unicode follows upstream guidance; escaping syntax needed for transport or newlines remains ordinary JSON.

For a raster job frame width W and height H, map normalized box to pixels:

`left=x_min×W/1000; top=y_min×H/1000; right=x_max×W/1000; bottom=y_max×H/1000`.

The inverse maps x pixels with 1000/W and y pixels with 1000/H. This is a coordinate derivation, not an assertion about model placement fidelity. Keep original document geometry at full precision; convert to integer caption coordinates only in the derived request. Proposed quantization uses nearest integer after validating/clipping to the resolved job frame, records any changed extent, and rejects collapsed boxes in the app profile. The rounding policy is app-owned, not provider-specified.

On a 1600×900 job frame, `[100,100,300,900]` describes left160, top90, right1440, bottom270. A normalized square need not be a pixel square. For equal pixel spans, normalized x-span/y-span equals H/W. The pinned upstream expansion prompt's contrary W/H heuristic is recorded as a source inconsistency below; do not reproduce it in app math.

Coordinates must refer to the submitted image/crop/output frame, not the editor viewport. Selection crops, padding, image-to-image auto sizing, generated output dimension changes, flips and rotation need explicit frame mappings. A rotated native text box can only be approximated by an axis-aligned caption bbox; preserve its exact native transform separately. A box is neither a source mask nor a hard edit boundary, and cannot substitute for the accepted contribution masks/crop-containment rules. Auto-size rounding/downscale and structured-box behavior across edit routes remain unverified. No contour/mask/polygon schema is introduced by bbox.

<a id="e5"></a>

### E5. App concept map: preserve native text

These are API-informed concepts for downstream authors, not a replacement UX/ARCH design.

| App concept | Caption projection | App-owned data and limitation |
| --- | --- | --- |
| Scene brief | high_level_description | Raw user brief and generated/edited variants remain separately recoverable. |
| Background description | composition.background | Independent from image layer identity, canvas alpha, or source image. |
| Ordered object descriptions | obj element desc, optional bbox/palette | Stable app IDs, selection and native layer relationships are sidecar data; not undocumented provider fields. A semantic object need not map one-to-one to a layer. |
| Native editable text | text element literal text + desc + optional bbox/palette | Text content, font choice/resources, size, style, layout, transform and edit history belong to the document. Caption desc is guidance, not authoritative typography data. Native text remains editable before and after AI work. |
| Style and palette controls | model-guide style_description and element palettes | Legitimate documented model-caption concepts, although absent as dedicated Fal fields. Local color controls and V3 ColorPalette/color_weight are distinct schemas. |
| Output provenance | actual returned prompt string, optionally parsed | Parsed response describes generation intent; it is not OCR or measured output geometry. Never overwrite native text or regenerate the document graph automatically from it. |
| Layers/history/portable project | No caption equivalent | Preserve actual image/text layers and full history/assets per accepted app requirements. Caption metadata cannot stand in for this document model. |

Do not weaken the native-text requirement to raster-only editing. Conversely, raster output plus a text caption does not create native editable output. An explicit “use this described text as editable text” action can be designed, but creates an app object from a description; it does not prove that a baked-in text region was removed or its exact typography reconstructed. Avoid promising clean separation of generated text, perfect font recovery, bounding-box fidelity or isolated object assets.

Downstream UX/ARCH must make the relationship between “render text into the AI raster” and “retain native text over the result” explicit to avoid double-rendered lettering. Whichever workflow is selected, keep the native original and its undo history. No V3 layerize-text, Describe/OCR, other-model fallback, vector layer support or adjustment-layer support is authorized by this amendment.

The accepted app limits remain 25,000,000 pixels, 8192 per side and 100 combined image/text layers. Those are app budgets, not provider caption limits. The number of composition elements is not necessarily the number of document layers and must not automatically inherit the 100-layer cap.

<a id="e6"></a>

### E6. Safe plain/malformed/unknown/versioned handling

**App handling contract (adopted by UX/architecture; runtime qualification pending):** preserve raw requested prompt and raw returned prompt independently. Store derived parse result, validation issues, source/profile revision and explicit user edits alongside them. Read provider text as untrusted data, never executable markup. Parsing/projection must not alter the successful job state, discard the raster output, execute URLs/scripts, or overwrite current document edits.

| Input/result case | Required handling in the app boundary |
| --- | --- |
| Natural-language string | Preserve/display as plain prompt. No invented elements; use explicit expansion choice for a new request. A plain returned prompt is valid under Fal's string schema. |
| JSON object matching known caption profile | Preserve original raw text and key/array order; derive editable composition controls. Serialize canonical order only for an explicit new request; retain original provenance. |
| Parseable root array, null, number, boolean, or JSON-encoded string | Mark as unsupported caption shape; retain/display raw. Do not recursively parse until something seems plausible. |
| Malformed/truncated JSON or surrounding prose/code fences | Keep raw and show a recoverable parse issue; do not silently strip/fix content. A separate user-reviewed conversion may create a new caption version. |
| Missing fields / explicit null / wrong nested types | Identify exact path. Do not coerce null, booleans or numbers into text/coordinates. Keep results usable as raster even when caption interpretation fails. |
| Unknown root/nested keys, new element type, declared provider version | Preserve raw and unknown values; label profile unsupported/partial. Do not silently discard them or forward them in a known-profile request. Offer review/conversion to an authored known-profile copy, without overwriting original data. |
| Duplicate JSON object keys | Treat as ambiguous caption input. Detect before ordinary parsing collapses keys; never silently accept last-key-wins semantics as faithful source preservation. |
| Hosted API object with a partial style block | Identify source/profile difference. Do not fill empty aesthetics/photo keys and call it validated. Explicitly adapt/review for the model-guide profile or retain it as raw provenance. |
| App document from an older/newer caption profile version | Keep app envelope version/source revision separate from caption. Apply only an explicit tested migration; unsupported future versions remain inspectable without sending guessed fields to Fal. |
| Unknown/missing output prompt event in stream | Follow actual transport evidence; do not invent final prompt events from the ordinary response schema. Preserve what is present; show provenance unavailable if absent. |
| Late/duplicate/out-of-order completion | Attach raw/derived caption to its immutable job attempt/result. Existing reconciliation/cancellation rules govern adoption; never overwrite newer text based on arrival order. |

No captured Fal/model-guide payload includes a `version` or `$schema` field. A local profile identifier such as “Ideogram caption guide at 990fe1c, app profile 1” belongs in app storage only. Model name V4 and Fal info.version 1.0.0 are not nested-caption version negotiation. No unbounded parse/resource promise is made: byte/depth/element/text limits must be documented app budgets after PERF review, not misrepresented as measured provider caps.

<a id="e7"></a>

### E7. Source discrepancies and meaningful nested audit

The pinned [CaptionVerifier](https://github.com/ideogram-oss/ideogram4/blob/990fe1c4e950bb9e9dc90e01c0ad98ba434f83c2/src/ideogram4/caption_verifier.py) is useful format evidence, not a complete production validator. Its standalone methods return warning strings. A bounded offline audit executed only that inspected, standard-library-only file, with authored data; it loaded no model and made no requests. **32 fixtures: 20 produced warnings; 12 produced none. “No warning” is not proof of a valid app/provider request.**

| Audited case | Observed standalone verifier result / implication |
| --- | --- |
| obj and Unicode multiline text; palette length5/16 | No warning for these valid illustrations. |
| Missing high_level_description; empty elements | No warning; guide allows these, whereas hosted API requires high_level_description. |
| Missing/null background; unknown element type; unknown version/font_size keys | Warnings. These cannot be silently treated as valid known-profile controls. |
| Element desc=null, text=42; style aesthetics=null | No warning despite guide string types. App must independently check all nested types. |
| bbox booleans | No warning because Python bool satisfies isinstance(int); app must reject booleans as coordinates. |
| Zero-area bbox | No warning; verifier only rejects reversed bounds. App-authored positive-area policy is stricter. |
| Reversed, wrong-length, floating or out-of-range bbox | Warnings. |
| Lowercase palette; sixth element color; seventeenth style color | Warnings. Max5/max16 accepted; no invented V3 weights in V4 caption arrays. |
| Wrong text-key order; photo plus art_style; palette-only style block | Warnings; ordinary JSON-schema validity alone cannot express/check authored string ordering. |
| Plain string, malformed JSON, root array/null, double-encoded caption | Warnings; these are separate parse/profile states. |
| Duplicate background keys | No warning after standard JSON parser collapses duplicates. App must detect ambiguity before this point. |

Additional primary-source discrepancies:

- **Guide versus local pipeline errors:** the guide describes format rules as conventions and says the pipeline warns. The pinned [pipeline](https://github.com/ideogram-oss/ideogram4/blob/990fe1c4e950bb9e9dc90e01c0ad98ba434f83c2/src/ideogram4/pipeline_ideogram4.py#L482) actually defaults `raise_on_caption_issues=True`, raising ValueError for reported issues; the [CLI](https://github.com/ideogram-oss/ideogram4/blob/990fe1c4e950bb9e9dc90e01c0ad98ba434f83c2/run_inference.py#L112) offers a warning-only flag. Neither behavior is established for Fal.
- **Guide versus hosted type contract:** high-level-description requiredness, optional style children and order/XOR/palette limits differ, as detailed above. Do not call this a single interchangeable JSON Schema.
- **Expansion intermediate versus model caption:** the public [v1 expansion system prompt](https://github.com/ideogram-oss/ideogram4/blob/990fe1c4e950bb9e9dc90e01c0ad98ba434f83c2/src/ideogram4/magic_prompt_system_prompts/v1.txt) asks for a top-level aspect_ratio; CaptionVerifier does not recognize it. The inspected [magic_prompt.py](https://github.com/ideogram-oss/ideogram4/blob/990fe1c4e950bb9e9dc90e01c0ad98ba434f83c2/src/ideogram4/magic_prompt.py#L256) removes that key and, by default, removes element bboxes before returning captions. Its hosted helper extracts json_prompt from the service envelope and reorders known nested keys, retaining unknowns at the end. Thus neither the public expansion intermediate nor its defaults can be assumed to preserve layout or match Fal Medium/Large.
- **Coordinate heuristic:** the public expansion prompt requires strictly increasing box bounds, while the verifier accepts equality. It also gives normalized span ratio W/H for square physical objects, contrary to its own independent axis normalization. Derived physical-square ratio is H/W. This is a documented discrepancy, not a provider runtime test.
- **Version/configuration:** the public guide says its expansion prompt differs from hosted production. A system-prompt v1 identifier is not a Fal expansion_model version. Config-specific writing advice, such as a short high-level description, is not a Fal general payload bound.
- **Local model token limit:** pinned pipeline config defaults max_text_tokens=2048 and raises when tokenized chat-formatted input exceeds it. This is a local-model implementation limit, not a demonstrated Fal character/token/byte cap. Do not apply it to Fal or to document text content as a provider rule.
- **Spelling:** a README mention of colour_palette does not override the consistently documented/code-supported color_palette key. Use color_palette in the profile; do not send both.

<a id="e8"></a>

### E8. Downstream handoff and unresolved checks

**UX:** model the scene description, background, ordered object/text descriptions, literal text, optional boxes, style and palette without inventing provider fields. Keep native text editable in the initial product. Distinguish authored caption, expansion and returned prompt; identify edits that affect only app layers versus prompt projection. Resolve duplicate raster/native text explicitly. Fast now; tiling later.

**ARCH:** store raw prompt strings plus derived versioned caption data and validation issues; retain immutable job/request/frame provenance, app element IDs and native text data separately. Preserve native text/full history/assets in portable copies. Parse failures must not invalidate raster result adoption. Do not use model element order as guaranteed compositor order or bbox as containment mask. Frame transforms and quantization are local responsibilities. This amendment does not replace F01/F02 contribution/feather repair work.

**PERF / Task6:** distinguish native text layer count from semantic caption element count; include UTF-8 byte growth, serialization escaping, long multilingual text, many elements, parsing depth/duplicate-key detection, raw+derived history storage and font/layout resource retention in proposed budgets. Caption boxes themselves contain four integers but impose no measured memory/latency guarantee. Existing image/job limits stand. No provider prompt maxLength, generic payload cap or model duration is newly established. The latest Spec accepts training admission limits of 1–100 images, 800 MiB total original image bytes, 201 MiB prepared package and 4 KiB UTF-8 per caption. These are app limits, not verified Fal caps or measured capacity; preserve originals/captions and require explicit reviewed fitting changes. Provider limits remain unknown where the earlier evidence says so.

**QA / Task5:** add nested fixtures from E7, all root/unknown/version states in E6, Unicode/newline preservation, single serialization, both style branches, missing/null fields, coordinate axis reversal, non-square frames, integer quantization collapse, crop/auto-size provenance and late-result text preservation. Validate all route expansion enums, including Large rejected for Instant/Fast. Keep schema-valid/guide-valid/app-valid/runtime-success as separate outcomes.

Remaining opt-in provider checks, not completed research: serialized caption + None on each adopted route; exact forwarding/normalization and returned-prompt fidelity; expansion changes to literal text/boxes/palettes under Medium/Large; behavior at edit auto-size/crop boundaries; stream event/final-caption representation; hosted payload limits and nested error surfaces; actual layout/color/text fidelity. No paid call is authorized merely because it appears in this checklist.

**Review checkpoint:** assess the nested profile and source conflicts, the Fal serialization qualification, native-text boundary, unknown/version handling and coordinate math. This bounded author audit was followed by the recorded API-1.2 source approval. Original Task 1 is complete; the assembled revision still requires final independent verification. The training-limit preference is now answered in the latest Spec; it does not approve unfinished technical revisions or resolve provider-limit unknowns.

<a id="e9"></a>

### E9. Retrieval identity and verification receipt

Sources retrieved on **2026-09-25 UTC**. GitHub files are pinned to commit `990fe1c4e950bb9e9dc90e01c0ad98ba434f83c2` in ideogram-oss/ideogram4 (retrieved with gh CLI); this pins the reviewed repository, not Fal deployment/model weights. The live docs do not expose an immutable publication revision; retrieval date is not publication date. The Fal model/family HTML hashes identify the complete captured pages, while the parsed sample is derived evidence. Ideogram model-site content was read via the web tool; no byte hash is asserted for it.

The exact evidence anchors are: model guide, “structured JSON captions” represented as string type; Fal schema, “The prompt used for generating the image”; Fal expansion, “'None' disables prompt expansion and skips its fee”. The structural tables preserve API key spellings and constraints rather than treating marketing prose as runtime validation.

| Snapshot/source URL | Raw-byte SHA-256 |
| --- | --- |
| [Fal base page](https://fal.ai/models/ideogram/v4) | `78f64cf9867b841f6fd2eaab1e0bbb25a031439a2c56f9f4ac8f31f737a21c56` |
| [Fal family page](https://fal.ai/ideogram-4) | `b5d7ca4de3c3dba0b7d395440225afcf6fcd8781ce1b4ad6a39abe92a320ea76` |
| [Ideogram generate Markdown](https://developer.ideogram.ai/api-reference/generate-images/generate-v4.md) | `accc8b67ac87f60cb7261504c184d47568bc71b4058f201f8a1d92c2cbbd7f23` |
| [Ideogram Magic Prompt Markdown](https://developer.ideogram.ai/api-reference/describe-prompts/magic-prompt-v4.md) | `8cd3427b414766f03403607629b98d1d1bc8490043547f2b51a12865b9c821f6` |
| [Ideogram Describe Markdown](https://developer.ideogram.ai/api-reference/describe-prompts/describe-v4.md) | `5b000a1c6ed04007d79a78146df4fa449a6d219be54ddd20a7019f562f8978ef` |
| [Pinned prompting guide](https://github.com/ideogram-oss/ideogram4/blob/990fe1c4e950bb9e9dc90e01c0ad98ba434f83c2/docs/prompting.md) | `6dd30fdbf957d390038aad737cf703bff5adcd02805842b928bb40326d07d7a8` |
| [Pinned CaptionVerifier](https://github.com/ideogram-oss/ideogram4/blob/990fe1c4e950bb9e9dc90e01c0ad98ba434f83c2/src/ideogram4/caption_verifier.py) | `e6808c1068cb16937b26a95c1915900c051f35deea9292cb476bffcd3e7ce2b8` |
| [Pinned magic_prompt.py](https://github.com/ideogram-oss/ideogram4/blob/990fe1c4e950bb9e9dc90e01c0ad98ba434f83c2/src/ideogram4/magic_prompt.py) | `e56b87d9225a8119b90023469de3b77b2c8b62ce387ba38b3f7baebc441619bc` |
| [Pinned expansion system prompt v1](https://github.com/ideogram-oss/ideogram4/blob/990fe1c4e950bb9e9dc90e01c0ad98ba434f83c2/src/ideogram4/magic_prompt_system_prompts/v1.txt) | `5f6386382a1d9676f597be93884fc2346b62b923638da8df8b47d4d94a728f5e` |
| [Pinned pipeline](https://github.com/ideogram-oss/ideogram4/blob/990fe1c4e950bb9e9dc90e01c0ad98ba434f83c2/src/ideogram4/pipeline_ideogram4.py) | `c12ed0f97b814103af3b287e3048dd23ec7fcdb2e014d72d4869d472e9c4a6cd` |
| [Pinned inference CLI](https://github.com/ideogram-oss/ideogram4/blob/990fe1c4e950bb9e9dc90e01c0ad98ba434f83c2/run_inference.py) | `2236dd85c6a72ab48511759f9313d165db7682e5f3564022fd747296bd04167f` |
| [Pinned local inference guide](https://github.com/ideogram-oss/ideogram4/blob/990fe1c4e950bb9e9dc90e01c0ad98ba434f83c2/docs/inference.md) | `ea1697c57066e73ce9e71c84fe23320ca33b1c0c65179820275cad07a246bf5b` |
| [Pinned README](https://github.com/ideogram-oss/ideogram4/blob/990fe1c4e950bb9e9dc90e01c0ad98ba434f83c2/README.md) | `baac6e04de78b700b52942b716b3eff654aa00449a0ae2ba7c43f47868fd1c8e` |

All 17 recaptured V4 schema SHA-256 values equal their existing Appendix A/C values; no new endpoint, renamed field or model version is claimed. The ten comparison schemas and all original evidence remain preserved. The pre-assembly source snapshot preserves original Appendix A through D text with SHA-256 `81abeae6f57fff4e548224bcab912a4734ff59312906a9909d2aab92c57d9305`; preservation is checked independently of the revised prose.

Author verification on 2026-09-25: all 17 V4 schemas compared; published Fal sample structurally parsed; complete documented caption fields/types/order/bounds cross-checked against guide, hosted type definitions and verifier; 32 offline format fixtures recorded; coordinate mapping checked algebraically and against a non-square example; no app/model build or benchmark. Offline fixture record SHA-256 `d861253db319626db33861d1921977355c36bbb3178ae37fac462c33a8715648`. Temporary source/fixture files are in /tmp/ideogram-composition-evidence; the canonical durable deliverable is this note, not those temporary files. Repository mirrors remain Task7 work.
