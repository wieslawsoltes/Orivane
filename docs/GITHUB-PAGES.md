# GitHub Pages

The public browser edition is published at https://wieslawsoltes.github.io/Orivane/.

## Build and publish

Run `npm run build:pages`. The dependency-free build first recreates the portable HTML edition, then writes `_site/` containing only public browser assets, `Orivane.html` for download, a `.nojekyll` marker and `build.json` identifying the version and source commit. Server source, tests, `.env`, SQLite files and private runtime data are not included in the Pages artifact. All asset URLs are relative, so the app works at a repository subpath.

The GitHub Pages workflow tests on Node.js 22, builds the site and uses GitHub's official Pages artifact/deployment actions. A successful deployment is followed by an HTTP and Chromium smoke test against the published URL. The repository root also contains a generated portable `index.html`, making the same editor available when Pages is configured to publish directly from `main` instead of using Actions.

```sh
npm run build:pages
python -m http.server 8080 --directory _site
# In another terminal, with Python Playwright and Chromium installed:
python tests/pages.py --url http://localhost:8080
```

The smoke test checks that the actual application boots, creates and edits a sticky note, supports undo/redo, retains a local board through a reload, renders at desktop/mobile sizes, switches theme and reports no uncaught JavaScript exceptions. It records the actual renderer mode; Canvas fallback is not counted as WebGPU validation.

## Backend boundary

GitHub Pages is static hosting. It cannot run the included collaboration server, issue sessions, connect to an identity provider or securely store provider keys. The published app remains usable for local editing; connected features correctly report that their server is unavailable. To use connected features, deploy the full repository using `npm start` or the documented container topology and open the application at that deployment's own HTTPS origin. Never put provider keys, `.env` files, session data or database backups in `_site/` or commit them to this public repository.

## Release provenance

The source import preserves the Orivane 0.2 application, server and test files from the delivered archive. Generated standalone files are rebuilt from those sources. GitHub Pages build/smoke tools and this deployment documentation are added for publication. The original archive's checksum manifest is retained at `docs/verification/original-release-manifest.sha256`; the root `MANIFEST.sha256` describes the current repository files instead. Browser screenshots are regenerated from the supplied suites on the GitHub runner rather than treated as proof that this browser/host was tested previously. Historical verification reports retain their original limitations.
