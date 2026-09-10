# Server API guide — 0.2

The app is its reference client; `tests/` contains executable request examples. APIs exchange JSON unless noted. Errors are non-2xx with a text explanation (SCIM uses protocol error JSON). This is a source-level API guide, not a promised stable vendor-compatible contract.

| Route | Methods and purpose |
| --- | --- |
| `/api/health`, `/api/ready` | GET application identity / storage readiness. |
| `/api/metrics` | GET per-worker JSON metrics, `METRICS_TOKEN` bearer required. |
| `/api/auth/me` | GET user, CSRF and configured auth modes. |
| `/api/auth/register`, `/api/auth/login` | POST account credentials. Registration returns 201/session cookie. |
| `/api/auth/logout`, `/api/auth/password`, `/api/auth/revoke-sessions` | POST session/account operations; CSRF required when authenticated. |
| `/api/auth/oidc/start`, `/api/auth/oidc/callback` | GET authorization redirect and code callback. |
| `/api/workspaces` | GET membership list; POST create `{name}`. |
| `/api/workspaces/:id` | GET detail; PATCH policies/name. |
| `/api/workspaces/:id/members` | PATCH `{userId, role}`; owner/admin restrictions and final-owner guard. |
| `/api/workspaces/:id/invites` | POST `{role,email?}`; returns a single-use token. |
| `/api/workspace-invites/accept` | POST `{token}` as a signed-in user. |
| `/api/workspaces/:id/audit` | GET retained events and chain anchor; admin required. |
| `/api/workspaces/:id/boards` | GET accessible account-backed board summaries. |
| `/api/rooms` | POST `{snapshot,workspaceId?}`; creates a board and returns room invitation tokens. |
| `/api/rooms/:id/snapshot` | GET current collaborative snapshot. |
| `/api/rooms/:id/stream` | GET SSE with initial welcome/snapshot, operations, snapshots, presence/reactions and heartbeats. |
| `/api/rooms/:id/ops` | POST validated operation; success contains `ack` only after durable commit. |
| `/api/rooms/:id/presence`, `/reaction` | POST ephemeral participant/reaction data. |
| `/api/rooms/:id/invites` | POST rotate editor/viewer links, optionally owner token; owner required. |
| `/api/rooms/:id/acl` | POST `{userId,role}` (`editor`, `viewer`, `none`, `inherit`) for a workspace member. |
| `/api/rooms/:id/versions` | GET named versions; POST `{name}` saves a version as owner. |
| `/api/rooms/:id/restore` | POST `{version}` restores using new CRDT operations; owner required. |
| `/api/rooms/:id/delete` | POST `{confirm:true}` performs logical content deletion; owner required. |
| `/api/rooms/:id/audit`, `/webhooks` | GET owner audit or webhook job status. |
| `/api/providers` | GET administrator-enabled provider metadata; signed-in user only, no secrets returned. |
| `/api/rooms/:id/ai` | POST `{task,items,instruction?,consent:true}`; returns a reviewed plan, does not mutate the board. |
| `/api/rooms/:id/integrations` | POST explicit provider action; writes require `confirm:true` and an `Idempotency-Key`. |
| `/scim/v2/*` | Authenticated provisioning subset; see INTEGRATIONS.md. |

Room routes require `X-Orivane-Actor`. Editing/stream claims require a persistent random `X-Orivane-Client` secret (24–100 URL-safe characters). Link-based access uses `Authorization: Bearer <room-token>`; account-backed workspace access uses the session cookie and membership. Session-authenticated mutations must include `X-CSRF-Token` from `/api/auth/me`/login. Do not reuse an actor/clock for different operations.

Snapshots merge through `BoardDocument.merge`; clients must not interpret a reconnect snapshot as permission to discard unacknowledged operations. The client in `public/core/collaboration.js` persists pending work and reconciles it on reconnect. A 503 is not an acknowledgement. A 409 actor conflict requires a new client identity; an uncertain external-action conflict requires checking the provider before retrying.
