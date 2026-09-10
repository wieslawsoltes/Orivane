# Orivane 0.2 publication verification

The full application, servers, tests and standalone build were imported to main. Original source verification is recorded in `source-recovery.json` (43 source files matched the original release manifest).

The first successful Pages publication used commit `f61b195fea2e6c7dd25cd572ec8ee32716e7bcae` and [workflow run 34527149414](https://github.com/wieslawsoltes/Orivane/actions/runs/34527149414). The build, deployment and live-site smoke jobs all succeeded on September 10, 2026. The live HTTP/Chromium test verified all seven groups: published commit identity and HTML, application startup, sticky editing/undo/redo, committed IndexedDB data surviving reload, dark theme, mobile layout, and absence of uncaught JavaScript exceptions. Chromium used the real Canvas 2D fallback; this is not GPU hardware validation.

The same source passed all 74 Node tests on Node 22 and Node 24, and the two-worker Docker Compose health/readiness/room-write smoke test in [verification run 34527149662](https://github.com/wieslawsoltes/Orivane/actions/runs/34527149662). Its backend browser job initially stopped at a Playwright predicate-polling eval blocked by the server's strict Content Security Policy. This repository therefore includes `tools/run-browser-tests.py`, which runs both original suites unchanged using external automation-protocol predicate polling. It does not set `bypass_csp`, weaken server headers, replace application APIs, fake storage or remove assertions. Later workflow results record whether those complete browser suites passed.

```sh
python tools/run-browser-tests.py tests/browser.py --url http://localhost:4173
python tools/run-browser-tests.py tests/browser-connected.py --url http://localhost:4173
```

The deployment serves only the public local-editor edition at https://wieslawsoltes.github.io/Orivane/. Server-dependent collaboration, authentication, SSO and provider integrations remain self-hosted features, not hosted backend services supplied by GitHub Pages. No live customer-provider credentials or physical mobile/stylus hardware were tested as part of publication. The historical 0.2 verification report remains unchanged; consult the current workflow run for current deployment results and screenshots.
