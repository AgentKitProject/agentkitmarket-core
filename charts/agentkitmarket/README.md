# agentkitmarket Helm Chart

Self-hosted AgentKit Market: web UI (`agentkitmarket-app`) + API server +
background worker, plus optional bundled Postgres / MinIO / Redis.

## Web app (UI)

The Next.js web app ships as a single runtime-configured image
(`ghcr.io/agentkitproject/agentkitmarket-app`) and is enabled by default
(`web.enabled=true`). One image serves any deployment — nothing about the
backend URL or WorkOS is baked at build time.

- **Backend URL**: server-side only. Defaults to the in-cluster API Service
  (`http://<release>-api`); override with `web.config.apiBaseUrl`.
- **Pluggable auth** (`web.authProvider`): `workos` (hosted default) or `oidc`
  (self-host). **Public browsing works without login** either way — auth only
  gates sign-in, admin review, submit, and browser-initiated downloads.
  - **OIDC self-host** (`web.authProvider=oidc`): set `web.config.oidc.issuer`,
    `web.config.oidc.clientId`, `web.secrets.oidcClientSecret`, and
    `web.config.appUrl`. `SESSION_SECRET` is generated for you. See
    [`docs/SELF_HOSTING.md`](../../docs/SELF_HOSTING.md).
  - **WorkOS** (`web.authProvider=workos`): set `web.secrets.workosApiKey` /
    `workosClientId` / `workosCookiePassword`.
- **Admin**: by OIDC group (`web.config.oidc.adminGroup`) and/or email
  (`web.config.adminEmails`).
- **Admin → backend key**: the web tier reuses the backend's `ADMIN_API_KEY`
  automatically; override only with `web.secrets.adminApiKey` if you split them.
- **Ingress**: `web.ingress` exposes the UI; the API can stay ClusterIP-internal
  since the web app calls it in-cluster. Expose the web ingress to users.

Disable the UI (backend-only) with `--set web.enabled=false`.

## k3s / self-host quickstart

Use the `values-k3s.yaml` preset: OIDC auth, bundled Postgres/MinIO/Redis, plain
Kubernetes Secrets, and chart-generated `ADMIN_API_KEY` / `SESSION_SECRET` /
DB+MinIO passwords (no `changeme`, persisted across upgrades).

```bash
helm install agentkitmarket ./charts/agentkitmarket -f charts/agentkitmarket/values-k3s.yaml \
  --set web.config.appUrl=https://market.example.com \
  --set web.ingress.host=market.example.com \
  --set web.config.oidc.issuer=https://idp.example.com \
  --set web.config.oidc.clientId=agentkitmarket \
  --set web.secrets.oidcClientSecret="$OIDC_CLIENT_SECRET" \
  --set web.config.oidc.adminGroup=agentkit-admins \
  --namespace agentkit --create-namespace
```

See [`docs/SELF_HOSTING.md`](../../docs/SELF_HOSTING.md) for the full guide.

## Quick start

### 1. Build or pull the image

The image is published to GHCR via the `image.yml` workflow on version tags.

```bash
# Pull a release
docker pull ghcr.io/agentkitproject/agentkitmarket-core:0.1.0

# Or build locally
docker build -t agentkitmarket-core:local .
```

### 2. Install with in-cluster Postgres / MinIO / Redis (dev / staging)

```bash
helm install market charts/agentkitmarket \
  --set image.tag=0.1.0 \
  --set secrets.adminApiKey="$(openssl rand -hex 32)" \
  --set secrets.databaseUrl="postgresql://agentkitmarket:changeme@market-postgres:5432/agentkitmarket" \
  --set secrets.s3Endpoint="http://market-minio:9000" \
  --set secrets.packageBucketName="agentkit-packages" \
  --set secrets.s3AccessKeyId="minioadmin" \
  --set secrets.s3SecretAccessKey="changeme" \
  --set secrets.redisUrl="redis://market-redis:6379"
```

> The in-cluster Postgres/MinIO/Redis deployments are single-replica and NOT
> suitable for production. Set `postgres.enabled=false`, `minio.enabled=false`,
> `redis.enabled=false` and supply external connection strings for production.

### 3. Install against external services (production)

```bash
helm install market charts/agentkitmarket \
  --set image.tag=0.1.0 \
  --set postgres.enabled=false \
  --set minio.enabled=false \
  --set redis.enabled=false \
  --set secrets.adminApiKey="<your-admin-key>" \
  --set secrets.databaseUrl="postgresql://user:pass@your-pg-host:5432/agentkitmarket" \
  --set secrets.s3Endpoint="https://s3.amazonaws.com" \
  --set secrets.packageBucketName="your-s3-bucket" \
  --set secrets.s3AccessKeyId="<aws-key-id>" \
  --set secrets.s3SecretAccessKey="<aws-secret>" \
  --set config.s3ForcePathStyle="false" \
  --set config.s3Region="us-east-1" \
  --set secrets.redisUrl="redis://your-redis-host:6379" \
  --set api.ingress.enabled=true \
  --set api.ingress.host="market-api.example.com" \
  --set api.ingress.className="nginx"
```

## Required secrets

| Helm value | Env var | Description |
|---|---|---|
| `secrets.adminApiKey` | `ADMIN_API_KEY` | API key gating `/admin/*` and `/users/*` routes |
| `secrets.databaseUrl` | `DATABASE_URL` | Postgres connection string |
| `secrets.s3Endpoint` | `S3_ENDPOINT` | S3-compatible endpoint (e.g. `http://minio:9000`) |
| `secrets.packageBucketName` | `PACKAGE_BUCKET_NAME` | Bucket for kit packages |
| `secrets.s3AccessKeyId` | `S3_ACCESS_KEY_ID` | S3/MinIO access key |
| `secrets.s3SecretAccessKey` | `S3_SECRET_ACCESS_KEY` | S3/MinIO secret key |
| `secrets.redisUrl` | `REDIS_URL` | Redis connection string |

## Optional config

| Helm value | Env var | Default | Description |
|---|---|---|---|
| `config.allowedOrigins` | `API_ALLOWED_ORIGINS` | `""` | Comma-separated CORS origins |
| `config.s3Region` | `S3_REGION` | `us-east-1` | S3/MinIO region |
| `config.s3ForcePathStyle` | `S3_FORCE_PATH_STYLE` | `true` | Force path-style URLs (required for MinIO) |
| `config.port` | `PORT` | `8080` | HTTP listen port |

## Worker

The worker runs the same image with a different command. It shares all env vars
from the same ConfigMap and Secret. Scale it independently via `worker.replicas`.

## Ingress

Set `api.ingress.enabled=true` and configure `api.ingress.host`. Add annotations
for your ingress controller (nginx, traefik, etc.) and TLS via cert-manager:

```yaml
api:
  ingress:
    enabled: true
    className: nginx
    host: market-api.example.com
    annotations:
      cert-manager.io/cluster-issuer: letsencrypt-prod
    tls:
      - secretName: market-api-tls
        hosts:
          - market-api.example.com
```

## Storage classes

If your cluster requires a specific storage class for PVCs, set it:

```bash
--set postgres.storage.storageClassName=standard \
--set minio.storage.storageClassName=standard \
--set redis.storage.storageClassName=standard
```
