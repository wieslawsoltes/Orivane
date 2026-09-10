# Deployment — 0.2

The application process and shared-storage process have been exercised directly in Node. Docker/Caddy configurations are supplied and YAML-parsed, **not container/TLS runtime-validated in this environment**. The included CI job will run the real container smoke when executed in a suitable repository runner.

## Single process

Requires Node 22.16 or newer. From the extracted `Orivane` directory:

```sh
npm test
cp .env.example .env
node --env-file=.env server/index.js
```

Open `http://localhost:4173`. No npm install is needed. Default local settings permit account registration and link-based guest rooms. The local store directory must have exactly one writer. Do not share it between API processes or run migration/backup against the live local writer.

For Internet access, keep Node on loopback, configure a TLS reverse proxy (example: `Caddyfile.example`) and set `PUBLIC_ORIGIN=https://your-real-host`. Configure allowed registration, membership and identity before exposing the service. Set `ALLOW_GUEST_ROOMS=false` for authenticated room creation; private workspace guest links are separately disabled by default. Disable password registration once authorized accounts/SSO are ready. A missing `PUBLIC_ORIGIN` is acceptable for localhost development, not the recommended production configuration.

## Two API workers with shared storage

Generate a secret of at least 32 random characters:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Set the same `CLUSTER_SECRET` in the storage service and all API workers. Start storage first:

```sh
CLUSTER_SECRET='<generated-secret>' CLUSTER_DB=./data/cluster.sqlite \
  node server/storage-node.js
```

In separate shells start workers, using different ports but the same shared storage and public origin:

```sh
PORT=4173 CLUSTER_STORAGE_URL=http://127.0.0.1:4174 CLUSTER_SECRET='<generated-secret>' \
  node server/index.js
PORT=4175 CLUSTER_STORAGE_URL=http://127.0.0.1:4174 CLUSTER_SECRET='<generated-secret>' \
  node server/index.js
```

Do not place both commands on a shared local `DATA_DIR` without `CLUSTER_STORAGE_URL`. A reverse proxy can route to both workers without session affinity. SSE responses must not be buffered. The storage endpoint must remain private: it has authority over all workspaces and identities and is not a browser API. Cross-machine storage requires HTTPS unless the administrator explicitly accepts a protected private-network HTTP link with `CLUSTER_ALLOW_HTTP=true`.

This topology tolerates API worker replacement. It does **not** eliminate the storage authority as a single point of failure.

## Compose example

```sh
cp .env.example .env
# Set CLUSTER_SECRET in .env; optionally configure IdP/provider credentials.
docker compose config --quiet
docker compose up --build --wait
```

The topology is `proxy → api1/api2 → storage`. Only the proxy is published, by default on `127.0.0.1:4173`; storage data is in `storage-data`. Configure host TLS using `Caddyfile.example` before public access and change `PUBLIC_ORIGIN` in `.env` to that HTTPS origin. Leave `ORIVANE_BIND=127.0.0.1` when using a host proxy. Do not simply expose the example's HTTP port publicly with passwords.

The image runs as the non-root Node user. API containers have read-only roots and no Linux capabilities; the storage service has one persistent data volume. Caddy needs its own data/config volumes. Base image and CI action tags are supplied for portability, not pinned supply-chain attestations; pin reviewed image/action digests in your deployment.

## Health and smoke

`GET /api/health` identifies the app; `GET /api/ready` checks storage reachability. The Dockerfile probes readiness. `GET /api/metrics` requires `Authorization: Bearer <METRICS_TOKEN>` and returns per-worker JSON counters; it is not a full Prometheus/observability stack.

On a **disposable deployment with guest rooms enabled**, run:

```sh
BASE_URL=http://localhost:4173 node tools/smoke.js --allow-write
```

The script creates one temporary board, sends a character edit, checks repeated durable reads and deletes that board. It is intentionally gated because it performs writes. The container CI job uses this script; that CI job has not been run as part of this delivery.

## Browser acceptance on the target origin

Run both browser suites on actual localhost/HTTPS. Then open Workspace → Diagnostics: perform checks, reload, perform checks again, export the report. `--require-gpu` fails rather than silently counting Canvas as GPU validation. Run the pointer pad on physical touch/stylus hardware and inspect pressure/tilt/sample behavior. Test storage eviction/recovery and accessibility with the target browser/OS; one synthetic touch run is not hardware certification.
