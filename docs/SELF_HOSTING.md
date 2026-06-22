# Self-Hosting AgentKitMarket on Kubernetes (k3s)

Run the **entire** Market product — web UI, API, background worker, and data
services — on your own cluster from one Helm chart. No AWS, no WorkOS, no
external secret manager required. Authentication uses **generic OpenID Connect**
(any standards-compliant IdP), and all credentials are stored in **plain
Kubernetes Secrets**, generated for you on first install.

This guide targets a single-node **k3s** cluster, but works on any Kubernetes.

## Topology

```
                         ┌──────────────────────────────────────┐
        Ingress  ─────▶  │  web  (agentkitmarket-app, Next.js)   │
   (your hostname)       │  AUTH_PROVIDER=oidc · talks to your   │
                         │  IdP for sign-in / admin / submit     │
                         └───────────────┬──────────────────────┘
                                         │ in-cluster (ClusterIP)
                                         ▼
        ┌────────────────────────┐     ┌────────────────────────┐
        │  api  (server.js)      │     │  worker  (worker.js)    │
        │  HTTP :8080            │     │  Redis queue consumer   │
        │  ADMIN_API_KEY-gated   │     │  (validation jobs)      │
        └────────┬───────────────┘     └───────────┬─────────────┘
                 │                                  │
                 ▼                                  ▼
        ┌──────────────┐    ┌──────────┐    ┌──────────────┐
        │ Postgres 16  │    │  MinIO   │    │   Redis 7    │
        │ (catalog DB) │    │ (packages│    │ (job queue)  │
        └──────────────┘    │  S3 API) │    └──────────────┘
                            └──────────┘
```

- **web** is the only component you expose publicly. It calls the **api**
  in-cluster and authenticates the operator/admins against **your** OIDC IdP.
- **api** and **worker** run from the **same** `agentkitmarket-core` image,
  differing only in entrypoint. They share env from one ConfigMap + Secret.
- **Postgres / MinIO / Redis** are bundled single-replica deployments (fine for
  a self-host node). Point at external instances and disable the bundles for HA.
- **Public catalog browsing needs no login.** OIDC only gates sign-in, admin
  review, submit, and browser-initiated downloads.

## Images

| Component | Image | Visibility |
|---|---|---|
| api + worker | `ghcr.io/AgentKitProject/agentkitmarket-core` | public GHCR package |
| web | `ghcr.io/AgentKitProject/agentkitmarket-app` | public GHCR package |

Both are multi-arch (`linux/amd64` + `linux/arm64`), so they run on x86 servers
and ARM (Raspberry Pi / Apple-silicon) nodes alike. The `values-k3s.yaml` preset
defaults both to `:latest`; pin to a release tag for reproducible deploys (see
the `TODO` notes in the preset).

## Quickstart (one command)

The `values-k3s.yaml` preset turns on OIDC, the bundled data services, and
credential generation. You only supply your hostname and IdP details.

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

That's it. The chart generates and persists `ADMIN_API_KEY`, `SESSION_SECRET`,
the Postgres password, and the MinIO root password — there are no `changeme`
placeholders, and the web tier automatically reuses the backend admin key, so
you never configure the same key twice.

### Prefer a values file (no secrets on the CLI)

```yaml
# my-values.yaml  (keep out of git)
web:
  config:
    appUrl: https://market.example.com
    oidc:
      issuer: https://idp.example.com
      clientId: agentkitmarket
      adminGroup: agentkit-admins
  secrets:
    oidcClientSecret: "<from your IdP>"
  ingress:
    host: market.example.com
```

```bash
helm install agentkitmarket ./charts/agentkitmarket \
  -f charts/agentkitmarket/values-k3s.yaml -f my-values.yaml \
  --namespace agentkit --create-namespace
```

## Configure your OIDC provider

Register an application / client in your IdP (Keycloak, Authentik, Dex, Auth0,
Okta, Entra ID, …) with:

- **Redirect URI**: `https://market.example.com/auth/callback`
  (or whatever you set via `web.config.oidc.redirectUri`).
- **Scopes**: `openid profile email` (the default; override with
  `web.config.oidc.scopes`).
- A **groups/roles claim** in the ID token if you want group-based admin.

| Helm value | Env var | Purpose |
|---|---|---|
| `web.config.oidc.issuer` | `OIDC_ISSUER` | Discovery base (`/.well-known/openid-configuration` must resolve) |
| `web.config.oidc.clientId` | `OIDC_CLIENT_ID` | OAuth client id |
| `web.secrets.oidcClientSecret` | `OIDC_CLIENT_SECRET` | OAuth client secret |
| `web.config.oidc.scopes` | `OIDC_SCOPES` | Default `openid profile email` |
| `web.config.oidc.redirectUri` | `OIDC_REDIRECT_URI` | Default `<appUrl>/auth/callback` |
| `web.config.oidc.allowInsecure` | `OIDC_ALLOW_INSECURE` | Allow `http://` issuer (dev only) |

### Granting admin

A signed-in user becomes a Market **admin** when **either**:

- the configured `web.config.oidc.adminGroup` (`ADMIN_OIDC_GROUP`) appears in
  their token's `groups`/`roles` claim, **or**
- their email is in `web.config.adminEmails` (emitted as both `ADMIN_EMAILS` and
  `AGENTKITMARKET_ADMIN_EMAILS`).

Use whichever fits your IdP — or both. If neither is set, no one is an admin
(everyone can still browse and submit as a regular user). Admins reach the
backend's `/admin/*` routes via the shared `ADMIN_API_KEY`, which the chart
wires from the backend Secret into the web Secret automatically.

## Secrets model

All secrets are **plain Kubernetes Secrets** created by the chart. With
`secrets.generate=true` (the k3s preset default), any of these left empty are
generated and **persisted** on first install, then preserved across
`helm upgrade` (read back via `lookup`):

| Secret | Generated? | Override |
|---|---|---|
| `ADMIN_API_KEY` | yes | `secrets.adminApiKey` |
| `SESSION_SECRET` (OIDC cookie) | yes | `web.secrets.sessionSecret` |
| Postgres password | yes | `postgres.password` |
| MinIO root password | yes | `minio.rootPassword` |
| `OIDC_CLIENT_SECRET` | no (you supply it) | `web.secrets.oidcClientSecret` |

### Bring-your-own external Secret (GitOps)

To keep secrets fully out of the chart, set `secrets.existingSecret` (backend)
and/or `web.secrets.existingSecret` (web) to Secrets you manage with Sealed
Secrets, External Secrets, SOPS, etc. The chart then `envFrom`s those instead of
rendering its own. The backend Secret must provide `ADMIN_API_KEY`,
`DATABASE_URL`, `S3_ENDPOINT`, `PACKAGE_BUCKET_NAME`, `S3_ACCESS_KEY_ID`,
`S3_SECRET_ACCESS_KEY`, `REDIS_URL`, and — when using the bundled data services —
`POSTGRES_PASSWORD` and `MINIO_ROOT_PASSWORD` (with
`minio.rootUser` == `S3_ACCESS_KEY_ID`).

## External data services (production / HA)

Disable the bundled deployments and point at managed instances:

```bash
helm install agentkitmarket ./charts/agentkitmarket -f charts/agentkitmarket/values-k3s.yaml \
  --set postgres.enabled=false --set minio.enabled=false --set redis.enabled=false \
  --set secrets.databaseUrl="postgresql://user:pass@pg-host:5432/agentkitmarket" \
  --set secrets.s3Endpoint="https://s3.example.com" \
  --set secrets.packageBucketName="agentkit-packages" \
  --set secrets.s3AccessKeyId="<key>" --set secrets.s3SecretAccessKey="<secret>" \
  --set secrets.redisUrl="redis://redis-host:6379" \
  --set config.s3ForcePathStyle=false \
  ...web/oidc flags as above...
```

## Verify

```bash
kubectl -n agentkit get pods
kubectl -n agentkit logs deploy/agentkitmarket-api
# Expect: agentkitmarket-core server listening on :8080

# Health check without ingress:
kubectl -n agentkit port-forward svc/agentkitmarket-api 8080:80 &
curl http://localhost:8080/health

# Open the UI at https://<web.ingress.host> and sign in via your IdP.
```

Notes:
- The api runs `schema.sql` on startup under a Postgres advisory lock (safe for
  rolling deploys / multiple replicas).
- The api auto-creates the object-store bucket on startup
  (`ObjectStore.ensureBucket()`).

## Upgrading

```bash
helm upgrade agentkitmarket ./charts/agentkitmarket -f charts/agentkitmarket/values-k3s.yaml \
  -f my-values.yaml --namespace agentkit
```

Generated credentials persist across upgrades. Pin `image.tag` / `web.image.tag`
to release tags so upgrades are deliberate.

## Build images locally (optional)

The api/worker image builds from this repo's `Dockerfile`:

```bash
docker build -t agentkitmarket-core:local .
```

`npm run build` runs a `copy-sql` step copying
`src/adapters/selfhost/schema.sql` into `dist/` so the server finds it at
runtime. CI (`.github/workflows/image.yml`) builds multi-arch
(`linux/amd64,linux/arm64`) and pushes to GHCR on `v*` tags.
