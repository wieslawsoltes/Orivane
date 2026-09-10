# Orivane 0.2

**A local-first collaborative whiteboard, built with plain HTML, CSS and JavaScript.** Original branding, a spatial editing engine, WebGPU rendering with a real Canvas fallback, character-level collaborative text, and an optional self-hosted connected workspace.

This release extends the original 0.1 application rather than replacing it with a mockup. Runtime dependencies: Node.js 22.16 or newer for the server; no npm packages, framework, hosted SDK or build service is required. The native `node:sqlite` module is used by shared storage and administrator backup tools; the tested Node 22 runtime prints its experimental warning.

**Scope:** executable 0.2 software, not complete feature/file-format parity with another vendor and not an independently audited enterprise service. See [capabilities](docs/CAPABILITIES.md), [verification](docs/VERIFICATION.md), and [security](SECURITY.md) before deployment.

## Live browser edition

Open **[Orivane on GitHub Pages](https://wieslawsoltes.github.io/Orivane/)**. This is the local-first browser editor, served over HTTPS. Browser persistence, imports, exports and canvas editing do not require a server. Cross-device collaboration, private workspaces, accounts, SSO and AI/provider integrations require the included backend; GitHub Pages does not run Node.js services.

Changes to `main` are tested, built and published by the Pages workflow. See [GitHub Pages deployment](docs/GITHUB-PAGES.md) for the deployment layout and verification commands.

## Start

```sh
npm start
# Open http://localhost:4173
```

For configuration:

```sh
cp .env.example .env
# Edit .env; never commit it.
node --env-file=.env server/index.js
```

Click **Workspace** in the board header. The connected interface contains Workspaces, Account, AI assistant, Connections, Interchange and Diagnostics. Create an account, create a private workspace, and publish the current board. Members open workspace boards using their session; guest links are disabled by default within private workspaces. Existing link-based rooms remain available through Share.

The server binds to loopback by default. For another device, deploy behind HTTPS and set `PUBLIC_ORIGIN` to the reachable origin. A localhost invitation is not a remotely reachable address. Static hosting and the standalone HTML support local editing but do not supply the collaboration/identity/provider backend.

## What changed in 0.2

| Area | Delivered implementation |
| --- | --- |
| Collaborative text | RGA character identities, Unicode insert/delete merging, independent inline marks, anchored selection, IME-aware edits, selective character undo. Text, table cells and task descriptions send live operations rather than whole-field replacements. |
| Editing UI | Rich contenteditable toolbar with bold, italic, underline, strike, code, links, color, highlight and simple list prefixes. Shared Canvas/GPU text-atlas rendering. |
| Identity and workspaces | Password accounts, hashed sessions, CSRF, session revocation, membership roles, private boards, per-board ACL API, invitation controls, named server versions, chained audit exports and audit-retention policy. |
| SSO/provisioning | OIDC authorization code + PKCE and signed ID-token validation; SCIM User/Group subset with ETags and deactivation. Requires administrator IdP configuration. |
| AI | Real OpenAI-compatible and Ollama HTTP adapters, selected-content consent, structured response validation and review before applying editable objects. No canned or simulated AI fallback. |
| Integrations | Allowlisted GitHub/Jira issue import/create/update, confirmed Slack posting, supported REST board import, and signed durable outgoing webhooks with retries. |
| Interchange | Native Excalidraw JSON and diagrams.net XML import/export for supported objects; compressed XML decoding, embedded raster assets, connector bindings, preview and conversion warnings. No proprietary RTB archive translator. |
| Multi-worker operation | Shared SQLite WAL authority with authenticated compare-and-swap writes, multiple API workers, cross-worker live room synchronization, durable acknowledgements and reconnect recovery. |
| Operations and validation | Backups, migration and password-recovery CLI, readiness/metrics, two-worker Compose example, CI workflow, actual GPU compute/raster readback probes, IndexedDB reload probe and physical-pointer test pad. |

Existing canvas tools remain: notes, shapes, connectors, text, ink, frames, images, cards, tables, selection, eight box resize grips, rotation, grouping, snapping, alignment, clipboard, search, templates, comments, chat, timers, voting, reactions, presentations, light/dark themes and touch pan/pinch.

## Run the tests

```sh
npm test
npm run build
# With Python Playwright + Chromium installed, and npm start running:
python tests/browser.py --url http://localhost:4173
python tests/browser-connected.py --url http://localhost:4173
```

Pass `--chromium /path/to/chromium` or set `CHROMIUM`. `--require-gpu` on the connected suite makes real application GPU readback mandatory. Browser tooling is a **development-only** dependency.

`npm run test:browser:injected` runs the unmodified standalone app on about:blank in environments that prohibit navigation. It explicitly does **not** validate authenticated browser transport, secure-context GPU or durable IndexedDB. No API mocks or GPU/polyfill substitutions are used.

## Build the portable edition

```sh
npm run build
# dist/Orivane.html and dist/orivane.bundle.js
```

The build tool resolves the named-module syntax used by this repository; it is not a general JavaScript compiler. For reliable local persistence, serve the app from localhost/HTTPS. An opaque file/about:blank context can fall back to clearly labelled volatile storage; export JSON before closing it.

## Deployment and operations

See [DEPLOYMENT.md](docs/DEPLOYMENT.md) for one-process and multi-worker configurations, [INTEGRATIONS.md](docs/INTEGRATIONS.md) for provider setup, [OPERATIONS.md](docs/OPERATIONS.md) for backup/recovery, and [UPGRADE.md](docs/UPGRADE.md) before upgrading existing rooms.

The multi-worker design has **one SQLite storage authority**. API worker failure is tested; storage-leader replication, automatic failover and multi-region operation are not implemented. Do not market the supplied Compose example as a highly available database cluster.

## Architecture

`public/core/` contains the document, character CRDT, history, editor, geometry, storage, interchange and collaboration libraries. `public/render/` contains WGSL, GPU submission, atlas generation and the Canvas fallback. `public/ui/` contains live text bindings; `public/enterprise/` contains the connected UI and diagnostics. `server/` contains HTTP/SSE rooms, identity, provider adapters, durable stores and the storage authority. `tools/` contains build, smoke and recovery commands. [ARCHITECTURE.md](docs/ARCHITECTURE.md) explains invariants and tradeoffs.

## Keyboard and input

V selects; H or Space-drag pans; N creates a note; T text; R/O rectangle/ellipse; C/L connector/line; P ink; E erase; F frame; M comment. Ctrl/Command+Z undoes, Shift+Z redoes; A selects all; C/V copies/pastes; D duplicates; G groups; Shift+G ungroups; F searches; K opens commands; S exports editable JSON. Shift+1 fits the board, Shift+2 fits selection. Ctrl/Command+Enter finishes text editing. Two fingers pan/pinch on touch devices.

## License

MIT. Product/protocol names in interoperability documentation identify supported integrations only. No proprietary graphics, fonts, hosted service credentials or vendor application source is included.
