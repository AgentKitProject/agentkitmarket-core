# Self-Hosting agentkitmarket-core on Kubernetes

This document covers running the market backend on your own Kubernetes cluster.
The web app (`agentkitmarket-app`) is deployed separately (Amplify Hosting or your
own Next.js host) and is NOT covered here.

## Architecture

```
┌────────────────────────┐     ┌────────────────────────┐
│  API server            │     │  Worker                │
│  node dist/entrypoints/│     │  node dist/entrypoints/│
│  server.js             │     │  worker.js             │
│                        │     │                        │
│  Listens :8080         │     │  Redis queue consumer  │
└────────┬───────────────┘     └────────────────────────┘
         │                              │
         ▼                              ▼
  ┌──────────────┐  ┌────────┐  ┌──────────────┐
  │  Postgres 16 │  │ MinIO  │  │   Redis 7    │
  └──────────────┘  └────────┘  └──────────────┘
```

Both the API server and worker run from **the same container image**; you select
which entrypoint runs by overriding the container command.

## Step 1 — Build the image

The GitHub Actions workflow `.github/workflows/image.yml` builds and pushes the
image automatically when you push a version tag:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

The image is pushed to:

```
ghcr.io/<owner>/agentkitmarket-core:<tag>
ghcr.io/<owner>/agentkitmarket-core:latest
```

To build locally:

```bash
docker build -t agentkitmarket-core:local .
```

Note: `npm run build` includes a `copy-sql` step that copies
`src/adapters/selfhost/schema.sql` into `dist/adapters/selfhost/schema.sql` so
the server can find it at runtime relative to the compiled entrypoint.

## Step 2 — Prepare required secrets

Before running `helm install`, decide the values for the required secrets:

| Secret | Env var | Notes |
|---|---|---|
| Admin API key | `ADMIN_API_KEY` | Arbitrary random string, e.g. `openssl rand -hex 32` |
| Postgres URL | `DATABASE_URL` | `postgresql://user:pass@host:5432/db` |
| S3 endpoint | `S3_ENDPOINT` | `http://minio:9000` for in-cluster MinIO |
| Bucket name | `PACKAGE_BUCKET_NAME` | Create the bucket before first start |
| S3 access key | `S3_ACCESS_KEY_ID` | |
| S3 secret key | `S3_SECRET_ACCESS_KEY` | |
| Redis URL | `REDIS_URL` | `redis://redis:6379` |

Store them in a `secrets.yaml` that is NOT committed to git:

```yaml
# secrets.yaml — keep out of version control
secrets:
  adminApiKey: "..."
  databaseUrl: "postgresql://..."
  s3Endpoint: "http://minio:9000"
  packageBucketName: "agentkit-packages"
  s3AccessKeyId: "..."
  s3SecretAccessKey: "..."
  redisUrl: "redis://redis:6379"
```

## Step 3 — helm install

### Dev / staging (in-cluster Postgres, MinIO, Redis)

```bash
helm install market charts/agentkitmarket \
  --namespace agentkit --create-namespace \
  --set image.tag=0.1.0 \
  -f secrets.yaml
```

The chart will deploy single-replica Postgres 16, MinIO, and Redis alongside the
API server and worker with PVCs for persistence.

### Production (external services)

```bash
helm install market charts/agentkitmarket \
  --namespace agentkit --create-namespace \
  --set image.tag=0.1.0 \
  --set postgres.enabled=false \
  --set minio.enabled=false \
  --set redis.enabled=false \
  --set config.s3ForcePathStyle=false \
  --set config.s3Region=us-east-1 \
  --set api.ingress.enabled=true \
  --set api.ingress.host=market-api.example.com \
  --set api.ingress.className=nginx \
  -f secrets.yaml
```

## Step 4 — Verify

```bash
kubectl -n agentkit get pods
kubectl -n agentkit logs deploy/market-api
# Should print: agentkitmarket-core server listening on :8080

# Health check (port-forward if no ingress)
kubectl -n agentkit port-forward svc/market-api 8080:80 &
curl http://localhost:8080/health
```

## Upgrading

```bash
helm upgrade market charts/agentkitmarket \
  --namespace agentkit \
  --set image.tag=<new-version> \
  -f secrets.yaml
```

## Web UI (the full self-host)

The chart also deploys the **web app** (`agentkitmarket-app`, the Next.js UI),
gated by `web.enabled` (default `true`). It is one runtime-configured image —
its server reads the backend URL + WorkOS/admin config from env at request time
(nothing baked at build), so a single image works anywhere.

- The web app's backend URL defaults to the in-cluster API Service
  (`http://<release>-api`) — no rebuild needed. Override with `web.config.apiBaseUrl`.
- **Public catalog browse/detail works with no login.** Auth (WorkOS) only gates
  admin/submit; self-hosters bring their own WorkOS via `web.secrets.*` (or
  `web.secrets.existingSecret`). Without WorkOS configured, the UI still serves
  the public catalog.
- Expose the **web** app (not the API) externally — the API can stay internal;
  the web server calls it in-cluster. Set `web.ingress.*` (e.g. tailscale).

## GitOps with an external secret (recommended)

To keep secrets out of git, set `secrets.existingSecret` to a Secret you manage
externally (e.g. synced by Infisical, Sealed Secrets, or External Secrets). When
set, the chart does **not** create its own secret, the API/worker `envFrom` it,
and the bundled Postgres/MinIO read their passwords from it. The Secret must
provide: `ADMIN_API_KEY`, `DATABASE_URL`, `S3_ENDPOINT`, `PACKAGE_BUCKET_NAME`,
`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `REDIS_URL`, and (if using bundled
data services) `POSTGRES_PASSWORD`, `MINIO_ROOT_PASSWORD`. Ensure
`minio.rootUser` equals `S3_ACCESS_KEY_ID`.

## Notes

- The API server runs `schema.sql` on startup, guarded by a Postgres advisory
  lock so multiple replicas don't race; safe for zero-downtime rolling deploys.
- The self-host server auto-creates the object-store bucket on startup
  (`ObjectStore.ensureBucket()`).
- The worker and API server share all env vars. Only the API server exposes a
  port.
- The web app connects to this backend server-side via its runtime backend URL +
  `AGENTKITMARKET_ADMIN_KEY` (= the backend's `ADMIN_API_KEY`).
