# Capability matrix — 0.2

“Implemented” means working source paths, not universal vendor equivalence. “Tested” means the evidence described in [VERIFICATION.md](VERIFICATION.md), not a certification. External services require real credentials; unsupported conversions produce warnings rather than fabricated objects.

## Requested remaining areas

| Area | Delivered scope | Verification / remaining boundary |
| --- | --- | --- |
| Character collaboration | RGA per text field/cell, Unicode atoms, independent deletion/format marks, offline/out-of-order merging, live contenteditable/input controls, selective undo and version restoration. | Node convergence tests and real browser editing. Not a complete word processor: no arbitrary nested block schema, arbitrary HTML paste, pagination or full bidirectional/complex-script typography certification. |
| Enterprise accounts | Scrypt passwords; HttpOnly, SameSite sessions; CSRF; private workspaces; owner/admin/member/viewer; invitations; board access overrides; revocation; audit; named versions. | Real HTTP tests. No billing, email delivery/verification, self-service email reset or native MFA. Recovery CLI exists; use the IdP for MFA and managed recovery. |
| SSO | Confidential OIDC code flow, PKCE S256, browser-bound single-use state, nonce, issuer/audience/time checks, RS256/PS256/ES256 signatures, verified-email/domain policy. | Real local HTTP IdP and signed-token fixture tested. Actual customer IdPs and their policies have not been exercised. No SAML or OIDC conformance certification. |
| Provisioning | SCIM v2 Users/Groups subset, eq filters, pagination, ETags, deactivation/session revocation, last-owner protection. | HTTP tests. Group resources are directory data, not dynamic group-based board authorization. No complete SCIM extension/filter/conformance coverage. |
| AI services | OpenAI-compatible/Ollama adapters; summarize, rewrite, brainstorm, cluster, mind-map and diagram plans; consent and reviewed application. | Real HTTP contract fixtures, not live paid/vendor calls. Structured board reasoning, not a multimodal autonomous agent or custom model-training service. |
| Integrations | GitHub/Jira issue reads and confirmed writes, Slack webhook posting, supported REST board import, outgoing signed webhook outbox. | HTTP fixtures with authentication and idempotency checks. Not a marketplace, OAuth app-install flow or background bidirectional issue mirroring. |
| Native open formats | Excalidraw JSON and diagrams.net compressed/uncompressed XML; supported geometry, text, raster assets and attachments; export downloads and import previews. | Converter and real browser round-trip tests. External applications were not opened here; full version-to-version visual/semantic fidelity is unverified. |
| Native proprietary format | REST item converter/import adapter provided. | **No `.rtb` archive reader/writer**, arbitrary native vendor archive support or full vendor board-history translation. |
| Distributed service | Multiple independent API processes over one authenticated durable SQLite CAS authority; cross-worker snapshots/presence, shared account sessions, revocation and recovery. | Separate-process tests include forced crashes and storage outage. **No replicated storage authority, automatic database failover or multi-region guarantees.** |
| GPU validation | Real compute-output and actual application-raster readback diagnostics; strict browser test option. | Implemented, but no secure GPU context available in this environment. GPU runtime remains unverified here. |
| IndexedDB | Existing storage plus committed write/read/delete and across-navigation probes. | Probe code and normal-origin test branch supplied. Opaque-origin browser tests cannot establish durability; target-origin execution still required. |
| Touch/stylus | Touch gestures, pressure samples, coalesced-event handling and diagnostic test pad. | Synthetic interaction and mobile layout tested; **physical hardware/OS/driver behavior not certified**. |
| Deployment | Node server, non-root Dockerfile, two-worker Compose, proxy configurations, readiness/smoke/CI, backups and migration. | Direct Node topology and backups tested; YAML parsed. **Docker images, Caddy/TLS and CI jobs were not executed here.** |

## Canvas and workshops retained

| Feature | Scope / limits |
| --- | --- |
| Canvas | Continuous bounded coordinates ±10,000,000; zoom 3.5–800%, minimap, pan/zoom, spatial index and viewport culling. |
| Rendering | Instanced WebGPU shape/stroke pipeline and texture atlas; actual Canvas fallback shares scene primitives. Text rasterization and much geometry preparation remain CPU work. No 60/120-FPS or million-object promise. |
| Notes, shapes, text | Sticky, rectangle, ellipse, diamond, triangle, text, frame, image, task, table; fills, strokes, opacity, transforms. Triangle hit testing is approximate. |
| Selection | Marquee/multi-select, eight grips for box-like objects, rotate, snap, alignment/distribution, flat groups, locks, duplicate and editable clipboard. Object locks are an editing convenience, not an ACL. |
| Ink | Pressure-width freehand/highlight, move/restyle and whole-object erase. No general path-node editing, Boolean path operations or complete brush engine. |
| Connectors | Attached/reconnectable ends, straight/elbow/curve routing, labels, solid/dashed lines, start/end arrows. No general obstacle-avoidance router, buses or full port constraint solver. |
| Mind maps | Connected nodes and Tab-child creation. No full collapsing/automatic layout system. |
| Tables | Live character-level plain cell text; up to 100×30. No formula engine, merged cells or independent per-cell rich formatting UI. |
| Tasks | Live collaborative description, owner/status/tag/due fields and explicit issue-tracker actions. No workflow automation engine. |
| Media | Embedded PNG/JPEG/WebP/GIF data; no video conferencing, video/audio editing, media object store or arbitrary active embeds. |
| Workshop | Threaded pinned comments, chat, reactions, shared timer/voting, presentations and participant following. No voice/video calls, recording or complete facilitation analytics. |
| Files | Orivane JSON, PNG/SVG/CSV plus supported open formats. Basic SVG import is not a general SVG renderer; unsupported structures do not become equivalent editable vectors. |
| Workspace | Local board library, ten original templates, search, command palette, themes, responsive tool surfaces; separate account-backed workspace library. |

## Important operational limits

Document input has bounded object/text/image sizes. Native imports are capped at 10,000 objects and 25 MB; a raster source is capped at roughly 3 MB of data-URI characters. A room has a 65 MB snapshot limit and 100,000 object records; text tombstones count toward sequence/document limits. Ordinary operation bodies are smaller than snapshots (8 MB; at most 10,000 object changes, 3,000 text fields and 100,000 character actions). A large version restore can exceed the single-operation limit even when the saved document fits.

The server defaults to 1,000 room records, 100 local live streams per room per worker and 100 named versions per board. These are safety guards, **not tested capacity commitments**. Deleted room metadata still counts toward room storage keys. The central store serializes full JSON snapshots per key; cross-worker snapshots are polled, not served by a globally replicated operation log. Large text histories and completed outbox/session records require operational monitoring; no automatic CRDT tombstone compactor or general database garbage collector is included.

Audit retention trims audit metadata (default 365 days, configurable 7–3650 within a workspace), not board content or backups. Audits have a bounded retained chain with an anchor; a host administrator can rewrite the store, so the chain is not external tamper-proof evidence. There is no legal-hold, compliance, data-residency or security-audit certification.
