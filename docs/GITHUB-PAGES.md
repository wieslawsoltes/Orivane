# GitHub Pages

Open the browser edition at **https://wieslawsoltes.github.io/Orivane/**. Deployment status and test evidence are available in the repository's **Deploy GitHub Pages** workflow.

## Build and publish

Run `npm run build:pages`. The dependency-free build first recreates the portable HTML edition, then writes `_site/` containing only public browser assets, `Orivane.html` for download, a `.nojekyll` marker and `build.json` identifying the version, source commit and public-file SHA-256 hashes. Server source, tests, `.env`, SQLite files and private runtime data are not included in the Pages artifact. All asset URLs are relative, so the app works at a repository subpath.

The GitHub Pages workflow tests on Node.js 22, builds the site and uses GitHub's official Pages artifact/deployment actions. A successful deployment is followed by HTTP and Chromium smoke tests against the published URL. The repository root also has an `index.html` redirect to `public/` for simple branch-based static hosting, although the supplied Actions workflow publishes the editor directly at the site root.

```sh
npm run build:pages
python -m http.server 8080 --directory _site
# In another terminal, with Python Playwright and Chromium installed:
python tests/pages.py --url http://localhost:8080
```

The smoke test checks the exact published source commit, application startup, sticky-note editing, undo/redo, an IndexedDB-saved board surviving reload, desktop/mobile rendering, dark theme and uncaught JavaScript errors. Reports and screenshots are uploaded as the `pages-browser-evidence` Actions artifact. The actual renderer is recorded; a Canvas fallback does not count as WebGPU validation.

The independent `Verify Orivane` workflow runs Node 22/24 tests, normal-origin browser collaboration/storage checks and a two-worker Docker Compose smoke test. Its status distinguishes executed checks from historical verification reports.

## Backend boundary

GitHub Pages is static hosting. It cannot run the included collaboration server, issue sessions, connect to an identity provider or securely store provider keys. The published app remains usable for local editing; connected features report that their server is unavailable. To use connected features, deploy the full repository using `npm start` or the documented container topology and open the application at that deployment's own HTTPS origin. Never put provider keys, `.env` files, session data or database backups in `_site/` or commit them to this public repository.

## Release provenance

The source import preserves the Orivane 0.2 application, server and test files from the delivered archive. Generated standalone files are rebuilt from those sources. Pages build/smoke tools and deployment documentation are added for publication. The original archive's checksum manifest is retained at `docs/verification/original-release-manifest.sha256`; `docs/verification/source-recovery.json` records original-source verification. The original manifest is historical, not a manifest of later repository changes. Temporary transfer chunks and the recovery workflow were removed after successful import. Browser screenshots are regenerated in CI rather than treated as proof that the original build environment tested this host.
