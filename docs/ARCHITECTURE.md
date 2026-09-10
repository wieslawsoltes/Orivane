# Architecture and invariants — 0.2

## Layers

The browser loads plain ES modules from `public/index.html`. The generated portable build wraps the same modules without an external runtime. UI chrome is accessible DOM/CSS; the board is a rendered scene with a separate interactive overlay. `BoardDocument` is DOM-independent and also runs in Node, so client/server validation and merge rules use the same implementation.

1. `model.js`: scalar LWW registers, validation, document snapshots and text sequences.
2. `richtext.js`: replicated character tree, deletion/mark registers, safe links and deterministic traversal.
3. `history.js`: selective compensating operations; never roll back an entire remote document.
4. `editor.js`, `ui/rich-editor.js`, `ui/plain-editor.js`: pointer and live text editing with selection/IME anchors.
5. `geometry.js`, `render/scene.js`, `render/gpu.js`, `render/renderer.js`: scene preparation, culling, atlas, WGSL submission and Canvas fallback.
6. `storage.js`, `collaboration.js`: local state, pending operation queue, authenticated HTTP and SSE reconnection.
7. `server/index.js`, `identity.js`, `providers.js`: room API, authorization, identity and real external adapters.
8. `store.js`, `storage-node.js`: fsynced local store or remote SQLite compare-and-swap authority.

## Character CRDT

Each text field has a generation/epoch and immutable character IDs derived from the Lamport stamp, actor and per-operation index. A node identifies its insertion anchor; siblings have deterministic order. Deletion and formatting are independently stamped registers. Unseen anchors and delete-before-insert records are retained, making eventual delivery order irrelevant for valid operations. Traversal is iterative, with cycle/causality/input limits enforced before merge.

Unicode iteration uses code points, not UTF-16 units. Browser selection offsets are converted between UTF-16 and sequence anchors. This prevents splitting surrogate pairs, but does not claim complete grapheme-cluster navigation or complex-script layout parity.

A splice is computed against the editor's displayed basis IDs. During IME composition the local basis is retained; remote characters are not accidentally swept into the deletion range. Concurrent format marks merge independently from geometry and other marks. Explicit `false` is retained, so a range can disable an inherited bold/italic object style.

`orivane/2` snapshots carry scalar records and text sequences. v1 snapshots are accepted and can seed character generations. Newly generated text/table changes use character operations. Upgrade all connected clients together; legacy 0.1 clients do not implement the current actor-secret and rich-text protocol.

## Selective history

History stores forward/reverse field changes and character IDs, not stale document snapshots. Undo is applied only where the targeted register still has the relevant stamp. A collaborator's later edits survive. Reverting a replacement must not revive characters that another author replaced. Created objects with subsequent remote changes are protected from destructive creation undo. Undo is local-session history (150 entries by default); named server versions are a separate facility.

## Rendering

The camera transforms document coordinates. A spatial index narrows visible objects. CPU scene preparation emits packed shape/stroke instances and cached text/image raster tiles. WebGPU submits instanced quads, shape/stroke WGSL and atlas sprites. Canvas uses the same scene representation when WebGPU is unavailable or initialization fails. Rich text is rasterized into the common label atlas, not implemented with a separate fake GPU text layer.

Diagnostics include a compute pipeline with 256 exact output checks and an offscreen draw/readback using the application's actual GPU pipeline. These probes do not establish performance or physical-device coverage until executed on the target device. CPU preparation and whole-snapshot operations remain important performance bounds.

## Durable operation path

```
local edit → validated CRDT operation → local outbox
         → authenticated HTTP POST → validate/authorize inside mutation
         → durable storage commit → acknowledgement + live broadcast
         → retry/reconcile snapshot when disconnected
```

In local mode, keyed transactions serialize within the process; each write creates a new temporary file, fsyncs it, renames atomically and fsyncs the directory. An exclusive writer lock prevents multiple app processes from treating one directory as shared storage. Startup recovery is itself guarded to prevent a stale-lock race.

In shared mode, the worker reads `(version,value)`, calculates a mutation and sends `If-Match`. SQLite executes compare-and-swap in `BEGIN IMMEDIATE` with WAL and `synchronous=FULL`. A 409 causes bounded retry/recalculation. A failure or missing acknowledgement is not a successful edit. Mutation functions must be replay-safe and must not perform external side effects.

Workers keep only transient SSE clients, presence caches and revision hints. They poll shared state (600 ms by default). A worker that discovers another worker's prior revision sends a merged snapshot, not merely its own last operation. Sessions, room ACLs, actor claims and invitation hashes are shared. Revocation is rechecked, including live streams. Presence is ephemeral data persisted with TTL semantics; its expiry is not a durable document deletion.

The SQLite service is a single storage authority. Its crash/restart durability is tested, but no replication/election is present. Per-room snapshot writes and polling trade implementation simplicity for limited scalability. A dedicated operation-log/change-feed backend and replicated authority would be separate work.

## Authentication and boundaries

A session is a random token; the store retains only a token hash, session version and CSRF secret. Cookie authentication and room bearer links are distinct. Workspace membership is checked server-side, with default guest links disabled. Each editing actor is bound to a persistent random client secret and, when signed in, a user ID. Reusing an operation stamp for different content is rejected.

OIDC login validates discovery issuer, token signature and claims and uses PKCE/state/nonce. Provisioning is authenticated by a separate administrator token. User deactivation changes the session version; the final active workspace owner cannot be deactivated without transferring ownership. Audit events contain action metadata and a hash-chain anchor, not external WORM storage.

## External side effects

Provider credentials exist only in the administrator environment. Outbound requests validate scheme and all DNS answers, pin the selected address, prohibit redirects and enforce time/size limits. Administrator-enabled private endpoints are explicit exceptions for self-hosted IdPs/models, not an untrusted URL proxy.

AI sends only selected text with explicit consent and returns a reviewed structured plan. It never executes code or provider-requested tools. Provider write requests require confirmation and persisted idempotency keys. Ambiguous network outcomes are marked uncertain and are not silently replayed.

Webhook events originate in a room's committed outbox. Deterministic event IDs transfer to durable jobs, which are leased by one worker and retried with signed payloads. Delivery is at-least-once; receivers must deduplicate by event ID. A crash between external acceptance and local acknowledgement can produce another delivery.

## Versions, backups and migration

Named versions store an independent snapshot plus room metadata. Saving a version uses multiple key writes and can leave an inaccessible orphan if the later metadata write fails; it is not a cross-key database transaction. Restore generates new collaborative operations, preserving connected-client convergence. Backup and migration tools operate below document level and include account/session state. See OPERATIONS.md for the offline/live distinctions and retention/security implications.
