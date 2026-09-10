# Security posture — Orivane 0.2

This source includes concrete security controls and tests, but has not received an independent audit, penetration test, compliance assessment or production approval. Deployment owners must review it before exposing sensitive data.

## Implemented controls

- Server-authorized room/workspace roles; editor/viewer separation, explicit guest-link policy, invitation rotation, account revocation and final-owner protection. Board object locks are not authorization.
- Salted scrypt password hashes (N=32768, r=8, p=1), random sessions stored by hash, HttpOnly/SameSite cookies, Secure cookies when `PUBLIC_ORIGIN` is HTTPS, and CSRF checks on session-authenticated writes.
- OIDC code+PKCE, nonce/state/browser binding, single-use state, signature and claim validation, configured email-domain policy; authenticated SCIM subset and deactivation.
- Persistent actor/client-secret association, account-bound actors, operation-stamp equivocation rejection, schema/size/clock validation, safe URL schemes and embedded raster restrictions.
- Origin checks, CSP, no-referrer, same-origin resource policy, no arbitrary HTML execution, XML external-entity/DOCTYPE rejection and bounded decompression.
- Outbound DNS/private-address validation and address pinning; no redirects; response/time limits. Private-network IdP/model access is administrator-opt-in. Provider keys stay server-side; external writes require confirmation/idempotency.
- Durable storage acknowledgement after commit, per-directory writer protection, authenticated private storage API and fail-closed storage errors.
- Bounded chained audit metadata and signed, retried webhook jobs. Host administrators still control the store and can rewrite hash chains.

## Deployment requirements

Use HTTPS and exact `PUBLIC_ORIGIN` for public access. Protect storage ports and secrets. Keep secrets out of public files, repositories, screenshots and logs. Use least-privilege provider credentials and allowlists; disable unnecessary registration/guest rooms. Configure IdP MFA/recovery rather than assuming the application provides native MFA.

Do not enable private outbound exceptions for end-user-controlled URLs. Do not expose the shared storage API to browsers or the Internet. HTTP cluster transport is permitted only through an explicit administrator setting/private trust boundary; there is no built-in storage TLS server or service mesh.

Local password registration does not send verification email. Do not use an unverified local email address as proof of enterprise identity. OIDC accounts are not automatically linked to matching local-email accounts. Guest links are bearer capabilities; anyone holding an enabled link can use its role. Tokens in browser-local storage/outboxes are accessible to scripts on that origin; prevent XSS and use a dedicated origin.

## Explicit gaps

No native MFA/SAML, email-reset delivery, enterprise billing, data-loss-prevention engine, KMS/encryption-at-rest service, end-to-end encryption, legal holds, certified retention/erasure, external immutable audit sink, security-key attestation, replicated storage leader or proven global abuse resistance. Rate/size guards are not a comprehensive public multi-tenant abuse solution. Provider adapters use administrator service credentials, not per-user OAuth installations.

Session/job/audit/version/CRDT-history growth requires monitoring and operational retention decisions. Logical board deletion clears current content and named snapshots but is not cryptographic erasure from backups/WAL/storage media. Backups can restore old security state. Snapshot version creation is not a cross-key atomic transaction. Large full snapshots/polls can stress memory and disk under load.

Physical device access, browser storage durability, real customer IdPs, live vendor permissions and container/TLS deployment are not validated by loopback unit tests. Run the supplied acceptance probes on your target environment.

## Reporting

No public security-reporting mailbox or repository is configured by this source delivery. Report privately to the administrator of your deployment; do not publish secrets or live exploit details in board comments. Rotate affected tokens/session versions and preserve restricted evidence during investigation.
