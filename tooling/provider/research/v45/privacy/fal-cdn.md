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

# fal CDN

> Upload files to fal's CDN to use as inputs when calling models.

Models on fal accept file inputs as **URLs**, and model outputs (generated images, videos, audio) are also returned as CDN URLs. If you have a local file you want to pass to a model, upload it to fal's CDN first to get a URL, then pass that URL as input. Some models also accept **data URIs** (`data:image/png;base64,...`) for inline file content, but URLs are the universal format that works with every model.

The CDN is the recommended approach for file inputs. You upload once, get a persistent URL, and reuse it across as many [inference](/docs/documentation/model-apis/inference) requests as you need. The SDK automatically handles reliability by falling back between multiple upload endpoints if one is unavailable. If you already host files on S3, GCS, or your own server, you can skip the upload and pass those URLs directly.

## Uploading Files

<CodeGroup>
  ```python Python theme={null}
  import fal_client

  # Upload a local file
  url = fal_client.upload_file("path/to/image.png")
  print(url)  # https://v3b.fal.media/files/b/0a98f887/YYbm6L.png

  # Upload raw bytes
  url = fal_client.upload(image_bytes, "image/png")
  ```

  ```python Python (async) theme={null}
  import fal_client

  # Upload a local file
  url = await fal_client.upload_file_async("path/to/image.png")
  print(url)  # https://v3b.fal.media/files/b/0a98f887/YYbm6L.png

  # Upload raw bytes
  url = await fal_client.upload_async(image_bytes, "image/png")
  ```

  ```javascript JavaScript theme={null}
  import { fal } from "@fal-ai/client";

  const file = new File(["..."], "image.png", { type: "image/png" });
  const url = await fal.storage.upload(file);
  console.log(url);  // https://v3b.fal.media/files/b/0a98f887/YYbm6L.png
  ```
</CodeGroup>

Then pass the URL to any model:

<CodeGroup>
  ```python Python theme={null}
  result = fal_client.subscribe("fal-ai/flux/dev", arguments={
      "prompt": "a cat wearing sunglasses",
      "image_url": url  # CDN URL from upload
  })
  ```

  ```javascript JavaScript theme={null}
  const result = await fal.subscribe("fal-ai/flux/dev", {
    input: {
      prompt: "a cat wearing sunglasses",
      image_url: url  // CDN URL from upload
    }
  });
  ```
</CodeGroup>

## Using Your Own Storage

You don't have to use fal's CDN. If you already have files hosted elsewhere, pass those URLs directly. The model's runner downloads the file from that URL during processing, so the URL must be accessible without additional authentication headers.

**Presigned URLs** from S3, GCS, or R2 work because the auth credentials are embedded in the URL itself:

```python theme={null}
result = fal_client.subscribe("fal-ai/flux/dev", arguments={
    "prompt": "enhance this image",
    "image_url": "https://your-bucket.s3.amazonaws.com/image.png?X-Amz-Signature=..."
})
```

**Public URLs** from any web server also work, as long as they return the file directly without requiring cookies or auth headers.

**Private URLs** that require `Authorization` headers or other credentials will not work as model inputs when calling Model APIs. If your files are behind authentication, download them first and upload to fal's CDN, or generate a presigned URL with a short expiry. If you are building your own [fal App](/docs/documentation/development/app-setup), you can download authenticated files inside your endpoint using [`download_file` with `request_headers`](/docs/documentation/development/working-with-files).

## Data URIs

Models also accept base64-encoded data URIs:

```python theme={null}
result = fal_client.subscribe("fal-ai/flux/dev", arguments={
    "image_url": "data:image/png;base64,iVBORw0KGgo..."
})
```

<Warning>
  Data URIs embed the entire file in the request payload. This inflates the request size significantly, slows down transmission, and is not recommended for files larger than a few KB. Use CDN uploads or external URLs instead.
</Warning>

## Upload Details

| Property | Value |
| - | - |
| **CDN URL format** | `https://v3b.fal.media/files/b/{prefix}/{filename}` |
| **Large files** | Automatically uses multipart upload for large files (10 MB chunks). Python SDK: threshold 100 MB, up to 10 parallel chunks. JavaScript SDK: threshold 90 MB, sequential chunks. |
| **Retries** | Automatic retry up to 10 attempts on transient errors |
| **Fallback** | If the primary endpoint (`v3.fal.media`) is unavailable, the SDK automatically falls back to `fal.media`, then to the REST API |
| **Auth** | Handled automatically by the SDK using your `FAL_KEY` |
| **Access** | Public by default -- anyone with the URL can download. Override per request with [File ACLs](/docs/documentation/model-apis/file-access-controls) to restrict access to specific users or hide files entirely. |

There are no file type restrictions at the upload level. The SDK handles large files automatically using multipart uploads with chunked transfer. Individual models may enforce their own size and format limits when processing inputs. Check the model's API page for specifics.

## Uploading PIL Images

If you're working with PIL/Pillow images in Python:

```python theme={null}
from PIL import Image
import fal_client

image = Image.open("photo.jpg")
url = fal_client.upload_image(image)
```

This converts the image to JPEG, uploads it, and returns the CDN URL.

## Media Expiration

CDN file retention is configurable. You can set expiration per-request using the `X-Fal-Object-Lifecycle-Preference` header, or configure retention at the account level.

<Card title="Data Retention and Storage" icon="arrow-right" href="/docs/documentation/model-apis/media-expiration">
  Configure how long CDN files are retained
</Card>

## File Access Controls

By default, CDN URLs are publicly readable. You can restrict access to specific users, share files with named teammates, or hide files entirely by setting an ACL on the request that produces the file.

<Card title="File Access Controls" icon="arrow-right" href="/docs/documentation/model-apis/file-access-controls">
  Restrict who can access files on the fal CDN with per-user access rules
</Card>

## Building a Serverless App?

If you're building a fal App and need to handle files inside your endpoint code (returning images, downloading inputs), see the server-side guide:

<Card title="Working with Files" icon="arrow-right" href="/docs/documentation/development/working-with-files">
  Server-side file handling: download\_file, File.from\_path, Image.from\_pil
</Card>
