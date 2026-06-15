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

## Notes

- The API server runs `schema.sql` via `CREATE TABLE IF NOT EXISTS` on every
  startup, so it is safe to run with zero downtime rolling deploys.
- The worker and API server share all env vars. Only the API server exposes a
  port.
- The web app (`agentkitmarket-app`) connects to this backend via
  `NEXT_PUBLIC_AGENTKITMARKET_API_BASE_URL` and `AGENTKITMARKET_ADMIN_KEY`.
  The admin key is the same value as `ADMIN_API_KEY` set above.
