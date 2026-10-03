# Public editor UI

The [GitHub Pages site](https://westbrook.github.io/ideogram-editor/) opens the actual editor shell with the local editor’s Spectrum 2 inspired En Reve theme. It includes the document bar, tool rail, canvas, Request and Layers panels, activity tray, command search and keyboard help. Appearance, density, responsive panel layout and view controls work in the browser.

The site is deliberately disconnected. Its notice explains that no local workspace or server is connected. Document creation, import, storage, history, save, export and image-generation actions remain unavailable; the editor does not claim that a document is open or saved. Check connection cannot contact a local server, establish a session or create credentials. The Pages build uses a separate offline session boundary while the local editor retains its real session implementation. There are no backend, SSE, WebSocket or provider connections, uploads, analytics or credential entry on the public site. Only same-origin static assets are fetched. The local-only `?progress-report` flag is removed before mounting the public shell.

Choose **Try native text** for the secondary [browser text demo](https://westbrook.github.io/ideogram-editor/?view=text-demo). The real native renderer turns text, font, size, color, alignment and direction into a 960 × 540 transparent canvas. Render is explicit; the current canvas can be downloaded as PNG. Reset and cancellation discard temporary work. Missing-glyph and renderer admission errors remain visible rather than substituting content. A return link opens the full disconnected editor UI.

Demo edits exist only in that page. Reloading or leaving the demo clears them. Appearance and density preferences may remain in browser local storage; the shell can also remember its keyboard shortcut preference. These preferences are not documents or durable history. Font and renderer assets load from the same origin when the demo renders.

The complete editing workflow requires the local Node server and private storage. This static publication demonstrates the real UI and a working native text demo; it does not establish full product, accessibility, performance, hardware or provider qualification. Live Ideogram V4.5 remains blocked pending stronger retention terms.

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

The launcher opens a paired local browser window. Keep its terminal running; type `pair` and Enter there to open a fresh connection. Ctrl-C stops the server. Existing storage is not moved or deleted. See [the launcher instructions](../tooling/SESSION.txt), [storage instructions](../tooling/STORE.txt) and [current validation guide](testing/VALIDATION.md) for details. The disconnected site and native text demo do not require a provider key.

## Separate build and verification

Source lives under `pages/`, with a dedicated `vite.pages.config.ts`, `tsconfig.pages.json` and `tooling/pages/` producer. It reuses the actual production shell, renderer and theme modules, substitutes only a Pages-specific offline session client, and never changes the production app’s `BASE_URL='/'` or its evidence contract. The public build uses `/ideogram-editor/` and writes only a fresh `public-artifact/` inside that validation run’s evidence directory. It never overwrites a prior artifact. Do not publish the repository root, evidence directory, or production `dist/` directory.

The dedicated tests live under `pages/tests/`. Offline Node checks cover session refusal, exact browser-result inventory, artifact boundaries and publication transport; Python checks cover archive extraction. They run before the build. Browser tests retain all ten native text demo cases on the explicit demo route and add five complete editor cases per engine: 45 cases across Chromium, Firefox and WebKit, with one worker and zero retries. The fixture allows only the sealed artifact’s static paths and rejects backend, streaming, WebSocket, credential-bearing and other-origin attempts. Full shell checks cover unavailable actions, connection controls, keyboard search/help/panels, responsive layout, shared theme preferences, the local-only report flag, and navigation to real native rendering and PNG download. Bounded Chromium screenshots retain desktop light/dark and narrow layouts for visual review; automated axe results retain incomplete findings for separate manual review. They are separate from the production qualification inventory. Use the installed browsers matching the repository’s pinned Playwright package; only the hosted setup step installs browsers automatically.

At a validation boundary, provide a fresh output leaf inside a specifically issued Pages evidence allocation, and an exact source commit and UTC timestamp:

```sh
node tooling/pages/validate.mjs \
  --commit "$(git rev-parse HEAD)" \
  --built-at "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" \
  --output "$IE_PAGES_OUTPUT"
```

`IE_EVIDENCE_ALLOCATION` must identify that explicit allocation. The controller owns the shared host lease while it checks types, offline controllers, inputs, build, public artifact and browser behavior. Every input byte must match the selected real Git commit. A detached checkout may validate a reviewed commit available in its shared Git history without changing its own HEAD; in that case supply that exact commit instead of `HEAD`. Uncommitted input changes are refused rather than labelled as a published revision. It retains raw and effective outcomes separately; a browser PASS with an incomplete evidence audit is not publication-ready. Do not run this alongside another exclusive validation or timing campaign. Failed receipts are retained, and a retry requires a new output leaf. Build-only output is not a validated publication.

The public artifact verifier binds the source commit, emitted files, native WASM, bundled fonts and notices. The full shell’s one emitted text profile JSON must exactly match the sealed source profile; unrelated JSON assets are refused. It rejects unexpected files, symlinks, source maps, provider endpoints and private repository/report content. Backend route literals may remain in the real shell’s JavaScript, but the build must prove that the Pages offline session module replaced the real session client; browser tests separately refuse any attempted backend request. API route text is not evidence of a connected service. The public notice index is `notices/index.txt`; all notice bytes come from the checked-in notice selection and exact dependency distribution. Adobe Clean is not distributed.

## GitHub Pages deployment

The workflow in `.github/workflows/pages.yml` builds once from the triggering `main` commit, checks the three browsers and artifact, then uploads only that run’s verified `public-artifact/`. Source stays in `main`. A separate publication job downloads that exact artifact ID and verifies its manifest hash and complete file contents before committing its public tree to `gh-pages`. The branch retains its existing commit as the sole parent and uses an ordinary forward update; it never force-pushes, resets history, repairs races automatically or overwrites an unrecognized branch. A first publication creates the branch. An identical tree leaves the branch unchanged.

The official Pages deployment consumes the same uploaded artifact; it does not rebuild from `gh-pages`. This is deliberate: commits made using `GITHUB_TOKEN` do not trigger a new Pages branch build. The public artifact contains no hidden files or Jekyll marker, so the official uploader’s hidden-file exclusions cannot make the branch and deployed file sets diverge. The `github-pages` environment protects the publication job; only that job receives repository contents write, Pages write and OIDC permissions. The configured origin and base must match `https://westbrook.github.io/ideogram-editor/`; a different domain needs a reviewed configuration change.

After local validation succeeds, repository administration must explicitly select GitHub Actions as the Pages source and assign the hosted capacity before the first publication push reaches `main`. The workflow does not auto-enable Pages or create tokens. `QUALIFICATION_EVIDENCE_CAPACITY_BYTES` must contain an explicitly assigned positive byte capacity for the fresh hosted evidence allocation. No provider secret is supplied to the workflow.

The branch publication receipt records both the source commit and generated artifact commit, plus the tested manifest hash. Branch publication and Pages deployment are separate outcomes: if deployment fails after a branch commit succeeds, that public artifact commit remains retained. A bounded publisher refuses ambiguous remote outcomes and competing branch changes without automatically retrying them.

After a successful deployment, verify the public root’s disconnected editor, displayed source commit, theme and panels, secondary native text demo and PNG download, and asset paths against that deployment’s retained receipts and the `gh-pages` tree. Enabling a workflow or uploading an artifact alone does not prove the site is live.

Official platform references: [GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages), [custom Pages workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages), [publishing sources and token-trigger behavior](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site), and [Vite project-site base paths](https://vite.dev/guide/static-deploy#github-pages).
