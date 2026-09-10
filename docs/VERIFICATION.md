# Orivane 0.2 — verification report

**Release:** 0.2.0  
**Execution date:** 2026-09-10  
**Environment:** Linux; Node.js 22.16.0; Python 3.13.5; Chromium 144.0.7559.96; Python Playwright.

## Result summary

| Layer | Actual result | Scope |
| --- | --- | --- |
| Core/server Node suite | **74 passed; 0 failed; 0 skipped** | Original 24 tests plus 50 new tests; real server, storage and local protocol-fixture traffic |
| Original browser suite | **16 grouped checks passed** | Actual standalone app, Canvas rendering, editing, exports and emulated touch |
| Connected browser suite | **13 grouped checks passed** | New workspace UI, rich text, live bindings, format conversions and diagnostics |
| Combined browser errors | **No uncaught JavaScript errors observed** | Executed desktop/mobile sequences only |
| Direct Node deployment smoke | **Passed** | Readiness, version, temporary room creation, character edit, repeated durable reads and deletion |
| Standalone build | **Passed: 19 isolated modules; 363,056 HTML bytes** | Build from the delivered source; no runtime packages |
| JavaScript syntax | **Passed** | Every delivered JavaScript source and built bundle checked with Node |
| Multi-process operation | **Passed** | Real SQLite authority and separate API child processes, including process crash and recovery |
| Deployment/CI YAML | **Parsed successfully** | Syntax only; Docker, Caddy and hosted CI were not available/executed |
| WebGPU compute and application raster readback | **Not runtime-verified** | No available navigable secure browser context; Canvas fallback actually ran |
| IndexedDB durable reload | **Not runtime-verified** | Opaque test origin; actual application used labelled memory-only storage |
| Physical touch/stylus and other browser engines | **Not verified** | Synthetic touch and Chromium do not certify physical devices, Safari or Firefox |
| Live external services/customer identity providers | **Not verified** | Adapters were exercised against local HTTP/signed-token fixtures, not customer credentials |

Counts are test counts, not feature counts, a mathematical correctness proof, an independent security audit or a performance guarantee. Tests do not make the remaining unsupported capabilities complete.

## Node test coverage

The TAP log is [verification/node.tap](verification/node.tap).

| File | Tests | Coverage |
| --- | ---: | --- |
| `tests/core.test.js` | 13 | Document convergence, validation, history, geometry, spatial queries and templates |
| `tests/server.test.js` | 11 | Actual HTTP/SSE collaboration, roles, invites, offline replay, workshop records and persistence |
| `tests/richtext.test.js` | 17 | Character insertion/deletion convergence, marks, Unicode, out-of-order delivery and selective undo/redo |
| `tests/identity.test.js` | 7 | Accounts, sessions, private workspaces, signed OIDC flow validation and SCIM subset |
| `tests/cluster.test.js` | 3 | Atomic network CAS, cross-process collaboration/identity/revocation, crashes and storage outage |
| `tests/providers.test.js` | 7 | Real HTTP adapters, structured AI validation, supported issue operations, security and webhook delivery |
| `tests/interchange.test.js` | 5 | Supported native JSON/XML conversions, geometry, bindings, raster assets and validation |
| `tests/versions.test.js` | 4 | Rich-text server restore, board access controls, audit retention and last-owner protection |
| `tests/admin.test.js` | 7 | Backups, migration, password recovery, provisioning invariants and file-store startup locking |
| **Total** | **74** | **All passed** |

The shared-storage test runs 48 concurrent network compare-and-swap updates, kills the storage process with SIGKILL, restarts it and checks the committed counter. Another test uses two independent API processes and the actual frontend Collaboration class to merge simultaneous text edits, propagate presence, share account sessions, recover after an API process crash and enforce invitation revocation across workers. A storage-outage test verifies HTTP 503 rather than acknowledging an uncommitted edit, followed by a successful durable retry after recovery.

The original transport suite also instantiates the actual frontend Collaboration class with native Node fetch and its SSE parser. Browser persistence adapters inside Node fixtures are in-memory test adapters: serialization/replay checks are **not IndexedDB durability checks**. Server file/SQLite persistence tests use real temporary disk storage.

Identity tests use a local signed-token identity provider fixture and exercise the implementation's HTTP redirects, PKCE/state/nonce and token verification. Provider tests exchange real HTTP requests with local fixture endpoints and validate payloads, permissions, failures and delivery behavior. This is protocol-level integration testing, not a claim of live OpenAI/Ollama, GitHub, Jira, Slack or customer-IdP certification.

## Browser constraints and executed method

The available Chromium has a managed navigation policy blocking URL navigation, including localhost and file URLs. That policy was not changed or bypassed. Both browser suites therefore used their explicit `--injected` mode: Playwright loads the **unmodified built standalone HTML** into the existing blank page with `page.set_content`.

No application renderer, browser API, network response or storage implementation was replaced to manufacture a pass. The application itself reports its real fallback state:

```text
origin: null
isSecureContext: false
renderer: Canvas 2D
storage: Memory only
WebGPU compute/readback: unavailable
application GPU raster/readback: unavailable
IndexedDB durability: unavailable
physical touch/stylus: pending
```

See [verification/environment.json](verification/environment.json). The diagnostics UI's correct reporting of an unavailable capability passes its reporting check; the unavailable capability itself does **not** pass.

### Original browser checks: 16 passed

The sequence exercises initial boot and its 42 editable objects; the board/template library; sticky creation and editing; pointer drag and side resize; rotation and duplication; group/delete/undo/redo; attached connector creation/reconnection; freehand input; task/table controls; comments/timers/voting; search/preferences/dark theme/minimap; frame presentation; raster import and actual PNG/SVG/JSON output; local serialization/reopening; a 2,000-object culling workload; and mobile share/layout/pan/pinch. Desktop and mobile uncaught-error checks are included in the count.

The tests use actual pointer, keyboard and DOM interactions plus application APIs for selected fixture setup and output inspection. They do not imply every path was exercised solely through clicks. Local serialization/reopening in this origin uses memory, not physical browser-database persistence.

### Connected browser checks: 13 passed

These cover six-section workspace navigation and the genuine local/setup state; Unicode contenteditable editing with bold/italic/safe links and collapsed-caret marks; remote character-operation refresh and selective undo; live table/task text bindings; actual Excalidraw file-input preview and undoable import; actual `.excalidraw` and `.drawio` downloads/re-import with raster assets; compressed XML decoding using the browser's real deflate-raw implementation; rejection of XML external entities; honest environment diagnostics; dark dialog bounds; a 390-pixel mobile dialog; and no uncaught errors.

Remote editing within these injected browser checks is applied through the actual document/character APIs. It does **not** verify browser-cookie authentication, SSO redirect transport or browser SSE over a normal HTTP origin. Those backend/transport paths have separate Node tests, and the normal-origin browser branch is supplied but was not executed here. The connected JSON report records those two environment exclusions explicitly; they are not silently included as successful checks.

External-format tests exercise supported converters and their round trips. The external vendor applications were not launched to certify general interchange fidelity. Proprietary RTB archives are not supported.

## Workload observation, not a benchmark claim

In the final 2,000-object browser fixture, 40 objects were visible and 160 rendering primitives were prepared. The recorded CPU preparation sample was approximately 3 ms. End-to-end fixture elapsed time was approximately 792.9 ms **including an intentional 300 ms settling wait**. These figures are one Canvas-path observation in headless Chromium, not GPU timing, sustained FPS, a production capacity limit or a portable speed promise. Exact values are in [verification/browser.json](verification/browser.json).

## Deployment and operational verification

The direct Node server was started locally and `tools/smoke.js --allow-write` successfully checked readiness, room creation, a character-level edit, repeated persisted reads and cleanup. See [verification/deployment-smoke.log](verification/deployment-smoke.log).

Administrator tests cover SQLite live backup with integrity checking, offline file-store backup, migration into empty shared storage, recovery of an account password with session revocation, last-owner protection and startup-lock races. SQLite backups and server restart are real disk/process operations; not a guarantee about power loss on every filesystem.

The Dockerfile, two-worker Compose file, Caddy configuration and GitHub Actions workflow are included. YAML parsing succeeded, but Docker/Caddy binaries and hosted CI execution were unavailable. **No container build, public TLS deployment, live-provider account transaction or hosted CI run is claimed.** The distributed design still has one SQLite storage authority: automatic storage failover, replication and multi-region operation are absent.

## Reproduce

```sh
npm test
npm run build

# Commands used for the delivered browser evidence:
python tests/browser.py --injected
python tests/browser-connected.py --injected

# On a normal machine, with npm start running:
python tests/browser.py --url http://localhost:4173
python tests/browser-connected.py --url http://localhost:4173

# Require an actual WebGPU application raster/readback pass:
python tests/browser-connected.py --url http://localhost:4173 --require-gpu

# Explicitly creates, edits and deletes a temporary server board:
BASE_URL=http://localhost:4173 node tools/smoke.js --allow-write
```

Browser suites require separately installed Python Playwright and Chromium. Set `CHROMIUM` or use `--chromium` to select the executable. These are development-only dependencies. The normal-origin connected suite contains account/room transport and IndexedDB reload checks; it must be run on the actual target origin before asserting that those browser paths passed.

## Remaining verification and capability boundaries

Run actual GPU shader/atlas/raster and device-loss tests on supported adapters; validate IndexedDB reload/quota/crash behavior on the deployed origin; test physical touch, stylus pressure, IME and accessibility with target devices; and run normal-origin browser, container/TLS, live-provider, load and independent security reviews. The delivered diagnostics contain actual probes, not substitutes for those executions.

This release implements the major new subsystems but is not complete third-party feature parity or a production-audited platform. Outstanding capabilities include proprietary RTB translation, SAML/native MFA, a complete enterprise provisioning schema, continuously bidirectional provider synchronization, full word-processor behavior, replicated storage/high availability and broader vendor integrations. See [CAPABILITIES.md](CAPABILITIES.md), [DEPLOYMENT.md](DEPLOYMENT.md) and [../SECURITY.md](../SECURITY.md) for exact supported scopes.

## Evidence included in the source archive

`docs/verification/` contains the final Node TAP, both browser JSON reports and logs, environment diagnostics, deployment smoke log and packaging checks. `docs/screenshots/` contains actual desktop, mobile, rich-text, connected-workspace, dark and diagnostics captures. The local-edition/memory-only labels in screenshots reflect the test environment, not fabricated signed-in accounts or GPU status.
