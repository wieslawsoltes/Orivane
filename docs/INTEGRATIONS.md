# Identity, AI and integration configuration — 0.2

All credentials are administrator-supplied server environment values. No keys are embedded in the standalone file. An unconfigured provider is labelled unavailable; the app does not simulate results. Users must sign in and have edit access to the current live room for provider actions. External writes require confirmation and idempotency keys. Real credentials, organization permissions, provider billing and network access are outside the offline delivery.

## OIDC single sign-on

Set `PUBLIC_ORIGIN`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, and, for a confidential client, `OIDC_CLIENT_SECRET`. Register `${PUBLIC_ORIGIN}/api/auth/oidc/callback` as the redirect URI. `OIDC_AUTH_METHOD` accepts the implemented client-secret posting/basic modes; `OIDC_SCOPES` defaults to `openid profile email`. `OIDC_EMAIL_DOMAINS` is a comma-separated optional allowlist. Discovery must report the exact issuer. ID tokens must have a supported signed algorithm and verified email.

Private-network/self-hosted identity endpoints require the administrator-only `OIDC_ALLOW_PRIVATE=true` exception. Keep it false for public providers. Existing password accounts are not silently merged with SSO users based solely on matching email. Sign in through the IdP, create/join the workspace, confirm another owner can recover access, and only then enable the workspace SSO requirement. Use your IdP for MFA, account recovery and lifecycle controls. The package has no SAML service provider.

SCIM is exposed under `/scim/v2`. Set an independent strong `SCIM_TOKEN` and the target `SCIM_WORKSPACE_ID`. Supported routes include ServiceProviderConfig, Schemas, ResourceTypes, Users and Groups. Users' `externalId` must correspond to the configured OIDC subject for SSO provisioning association. The implemented subset supports User/Group CRUD/PATCH, simple eq filters, pagination and ETags. Group membership is directory data rather than automatic board roles. Deactivate/remove the final owner only after ownership transfer. Customer IdP/SCIM connector certification is not claimed.

## AI assistant

For an OpenAI-compatible chat-completion endpoint:

```dotenv
AI_PROVIDER=openai-compatible
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=<a-model-your-provider-enables>
AI_API_KEY=<server-key>
```

The adapter calls `/chat/completions` with structured JSON response mode and a completion-token bound; the selected model/server must support those parameters. For local Ollama:

```dotenv
AI_PROVIDER=ollama
AI_BASE_URL=http://127.0.0.1:11434
AI_MODEL=<an-installed-model>
AI_ALLOW_PRIVATE=true
```

Ollama receives `/api/chat`, `stream:false` and `format:json`. Within containers, localhost means that container; use a reachable protected model host and review network permissions. The private-address exception is intentional and should never be enabled for arbitrary end-user URL input.

Select objects, choose a task in AI assistant, review the disclosure, grant consent and run. At most 100 selected text objects / 60,000 serialized characters are sent. Responses are reduced to a plain summary and bounded node/edge plan (60 nodes, 100 edges), previewed, then explicitly applied. Geometry/images, whole-board context, passwords and provider secrets are not automatically included. Prompt-injection-resistant structure limits do not make model prose authoritative; users must review it.

## GitHub and Jira

Set `GITHUB_TOKEN` and `GITHUB_REPOSITORIES=owner/repo,owner/another`. The adapter imports issues (not pull requests), refreshes a linked card and creates/updates issues with explicit confirmation. Use least-privilege repository-scoped credentials.

For Jira set `JIRA_BASE_URL=https://your-site.atlassian.net`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, and `JIRA_PROJECTS=PROJ,OTHER`. Search uses the enhanced REST search route and descriptions use structured ADF text. Only allowlisted projects are accepted. Import is bounded to 500 results. GitHub/Jira actions are explicit user actions, not perpetual two-way sync or an OAuth installation marketplace.

## Slack, board REST import and webhooks

`SLACK_WEBHOOK_URL` configures a specific incoming webhook. A user confirms the message before it is posted. The application does not request arbitrary Slack workspace/chat access.

`MIRO_ACCESS_TOKEN` and `MIRO_BOARDS` allow supported item import from selected boards (500-item fetch bound). The converter supports selected notes, text, shapes, cards, frames and connectors. It does not fetch arbitrary assets or decode proprietary `.rtb` backups; unsupported item types are listed.

`OUTGOING_WEBHOOK_URL` and a 32+ character `OUTGOING_WEBHOOK_SECRET` enable durable room-operation event delivery. Headers are `X-Orivane-Event`, `X-Orivane-Timestamp`, and `X-Orivane-Signature`. Verify HMAC-SHA256 over `timestamp + '.' + exact_request_body`; reject stale timestamps and use constant-time signature comparison. Deduplicate the event ID. Retries are bounded to eight attempts with backoff; failed jobs become `dead`. Owner-facing webhook status is available through the room API. No exactly-once external delivery guarantee is made.

Provider write outcomes may be marked `uncertain` after a network/storage failure. Inspect the external service before issuing a new idempotency key. A new key can cause a duplicate external action; the system deliberately does not guess that a failed response means the service did nothing.

## Protocol references

Implementation was checked against primary specifications/documentation. These are external references, not bundled SDK dependencies or proof of conformance:

- OpenID Connect Core: https://openid.net/specs/openid-connect-core-1_0.html
- SCIM protocol: https://www.rfc-editor.org/rfc/rfc7644
- OpenAI chat API: https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
- Ollama chat: https://docs.ollama.com/api/chat
- GitHub issues: https://docs.github.com/en/rest/issues/issues
- Jira issue search: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/
- Slack incoming webhooks: https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/
- Excalidraw JSON: https://docs.excalidraw.com/docs/codebase/json-schema
- diagrams.net editable XML: https://www.drawio.com/doc/faq/diagram-source-edit
- Native image-style/deflate conventions were checked against the public diagrams.net/mxGraph format implementation; no vendor rendering library is shipped.
