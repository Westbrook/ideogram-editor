# Public editor preview

The GitHub Pages build presents the editor’s real Spectrum 2 inspired En Reve theme and native browser text renderer. Text, font, size, color, alignment and direction controls prepare a 960 × 540 transparent canvas. Render is explicit. The current canvas can be downloaded as PNG; reset and cancellation discard temporary work.

Edits exist only in this page. Reloading closes the preview’s work; appearance and density preferences may remain in browser local storage. The preview does not create durable documents, retain history, import projects, connect to a local workspace or call an image-generation provider. There is no credential field, analytics service or backend API. Font and renderer assets load from the same origin when rendering is requested. Missing-glyph and renderer admission errors remain visible rather than substituting other content.

The complete editor uses a local Node server and private storage. GitHub Pages serves static files, so this publication is a separate supported preview of the project. It does not establish full product, accessibility, performance, hardware or provider qualification. Live Ideogram V4.5 remains blocked pending stronger retention terms.

## Run the local editor

From a checkout of this repository, provision the pinned Node 26.10.0/npm 12.1.0 toolchain and exact dependencies:

```sh
python3 tooling/bootstrap-toolchain.py
export PATH="$PWD/.toolchain/bin:$PATH"
python3 tooling/verify-vendor.py
npm ci
npm run typecheck
npm run verify:text
IDEOGRAM_PROVIDER_MODE=disabled npm run dev
```

The launcher opens a paired local browser window. Keep its terminal running; type `pair` and Enter there to open a fresh connection. Ctrl-C stops the server. Existing storage is not moved or deleted. See [the launcher instructions](../tooling/SESSION.txt), [storage instructions](../tooling/STORE.txt) and [current validation guide](testing/VALIDATION.md) for details. This preview does not require a provider key.

## Separate build and verification

Source lives under `pages/`, with a dedicated `vite.pages.config.ts`, `tsconfig.pages.json` and `tooling/pages/` producer. It reuses the production renderer and theme modules but never changes the production app’s `BASE_URL='/'` or its evidence contract. The public build uses `/ideogram-editor/` and writes only a fresh `public-artifact/` inside that validation run’s evidence directory. It never overwrites a prior artifact. Do not publish the repository root, evidence directory, or production `dist/` directory.

The dedicated controller and browser tests live under `pages/tests/`. Offline Node and Python boundary tests run before the build. Browser tests are owned by the Pages deployment gate and run in Chromium, Firefox and WebKit with one worker and zero retries. They are separate from the production qualification inventory. Use the installed browsers matching the repository’s pinned Playwright package; only the hosted setup step installs browsers automatically.

At a validation boundary, provide a fresh output leaf inside a specifically issued Pages evidence allocation, and an exact source commit and UTC timestamp:

```sh
node tooling/pages/validate.mjs \
  --commit "$(git rev-parse HEAD)" \
  --built-at "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" \
  --output "$IE_PAGES_OUTPUT"
```

`IE_EVIDENCE_ALLOCATION` must identify that explicit allocation. The controller owns the shared host lease while it checks types, offline controllers, inputs, build, public artifact and browser behavior. Every input byte must match the selected real Git commit. A detached checkout may validate a reviewed commit available in its shared Git history without changing its own HEAD; in that case supply that exact commit instead of `HEAD`. Uncommitted input changes are refused rather than labelled as a published revision. It retains raw and effective outcomes separately; a browser PASS with an incomplete evidence audit is not publication-ready. Do not run this alongside another exclusive validation or timing campaign. Failed receipts are retained, and a retry requires a new output leaf. Build-only output is not a validated publication.

The public artifact verifier binds the source commit, emitted files, native WASM, bundled fonts and notices. It rejects unexpected files, symlinks, source maps, API/provider references and private repository/report content. The public notice index is `notices/index.txt`; all notice bytes come from the checked-in notice selection and exact dependency distribution. Adobe Clean is not distributed.

## GitHub Pages deployment

The workflow in `.github/workflows/pages.yml` builds once from the triggering `main` commit, checks the three browsers and artifact, then uploads only that run’s verified `public-artifact/`. Source stays in `main`. A separate publication job downloads that exact artifact ID and verifies its manifest hash and complete file contents before committing its public tree to `gh-pages`. The branch retains its existing commit as the sole parent and uses an ordinary forward update; it never force-pushes, resets history, repairs races automatically or overwrites an unrecognized branch. A first publication creates the branch. An identical tree leaves the branch unchanged.

The official Pages deployment consumes the same uploaded artifact; it does not rebuild from `gh-pages`. This is deliberate: commits made using `GITHUB_TOKEN` do not trigger a new Pages branch build. The public artifact contains no hidden files or Jekyll marker, so the official uploader’s hidden-file exclusions cannot make the branch and deployed file sets diverge. The `github-pages` environment protects the publication job; only that job receives repository contents write, Pages write and OIDC permissions. The configured origin and base must match `https://westbrook.github.io/ideogram-editor/`; a different domain needs a reviewed configuration change.

After local validation succeeds, repository administration must explicitly select GitHub Actions as the Pages source and assign the hosted capacity before the first publication push reaches `main`. The workflow does not auto-enable Pages or create tokens. `QUALIFICATION_EVIDENCE_CAPACITY_BYTES` must contain an explicitly assigned positive byte capacity for the fresh hosted evidence allocation. No provider secret is supplied to the workflow.

The branch publication receipt records both the source commit and generated artifact commit, plus the tested manifest hash. Branch publication and Pages deployment are separate outcomes: if deployment fails after a branch commit succeeds, that public artifact commit remains retained. A bounded publisher refuses ambiguous remote outcomes and competing branch changes without automatically retrying them.

After a successful deployment, verify the public URL, displayed source commit, renderer, theme controls and asset paths against that deployment’s retained receipts and the `gh-pages` tree. Enabling a workflow or uploading an artifact alone does not prove the site is live.

Official platform references: [GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages), [custom Pages workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages), [publishing sources and token-trigger behavior](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site), and [Vite project-site base paths](https://vite.dev/guide/static-deploy#github-pages).
