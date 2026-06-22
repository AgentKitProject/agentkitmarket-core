# AgentKitMarket Self-Hosting Design

Status: **active** · Last updated 2026-06-22 · Owner: AgentKitProject

## Goal & constraints
Let anyone **self-host AgentKitMarket on Kubernetes** using **the same code** as
the hosted service, while:
- keeping the **hosted** deployment on cheap, pay-per-use **serverless** (Amplify
  web + Lambda + DynamoDB + S3 + SQS) — **no EKS/EC2** (cost);
- not maintaining a fork — domain logic has a single source of truth.

## Strategy: "one shared core, two thin runtimes"
All backend **domain logic** (routes, submission/kit state machine, validation,
publishing) lives in `@agentkitforge/market-core` behind a small set of **ports**.
Only two thin layers differ per deployment:

| Layer | Hosted | Self-hosted |
|---|---|---|
| Entrypoint | `entrypoints/lambda` (APIGW event ⇄ core router) | `entrypoints/server` (HTTP) + `entrypoints/worker` (queue consumer) |
| Storage adapter | DynamoDB | Postgres |
| Object store adapter | S3 | MinIO (S3-compatible) |
| Queue adapter | SQS | Redis |
| Web app | Next.js on Amplify | same Next.js image, runtime-configured |
| Auth (web) | WorkOS/AuthKit | generic OIDC (`AUTH_PROVIDER=oidc`) |

DynamoDB is *cheaper than any AWS Postgres at idle*, so hosted keeps it; self-host
uses Postgres because self-hosters won't run DynamoDB.

## Repo topology (0 renames, 1 new repo)
- **`agentkitmarket-core`** *(new, this repo)* — core + ports + **both** adapter
  sets + entrypoints + dual-backend tests + self-host Dockerfile & Helm chart.
- **`agentkitmarket-infra`** — pure CDK: provisions DynamoDB/S3/SQS and deploys
  the Lambda entrypoint from this package. (Domain logic moves *out* of it.)
- **`agentkitmarket-app`** — Next.js web; Amplify hosted, same image self-hosted.
- **`@agentkitforge/contracts`** — cross-boundary shapes (add `/config`, later org fields).

Consumption: `agentkitmarket-infra` depends on this package via **git-dep** while
the repo is private; the self-host path ships as a **public container image**
(repo can stay private). Flip to public npm later if desired.

## Ports (`src/core/ports.ts`)
`ConfigProvider`, `ObjectStore`, `MessageQueue` (+ `ValidationJobMessage`), and
`StorageRepo` (the existing `CatalogRepository` + `AdminRepository`, extracted in
Phase 1). The core depends only on these — never on a cloud SDK.

## Postgres schema (the main work)
Map the 5 DynamoDB tables → relational tables, preserving GSIs as indexes:

| Dynamo | Postgres | Keys / indexes |
|---|---|---|
| Kits | `kits` | PK `kit_id`; unique `slug` |
| KitVersions | `kit_versions` | PK `(kit_id, version)`; idx `sha256` |
| Publishers | `publishers` | PK `publisher_id`; unique `slug` |
| Submissions | `submissions` | PK `submission_id`; idx `kit_id`, `publisher_id`; partial idx for active/expiry |
| ValidationJobs | `validation_jobs` | PK `job_id`; idx `kit_id` |

Two correctness items:
- **TTL** — Dynamo's `expiresAt` on `awaiting_upload` → Postgres `expires_at` +
  a periodic cleanup job.
- **Atomic publish** — today `publishSubmission` does three `Promise.all` writes
  (non-atomic). Use a Postgres `BEGIN/COMMIT` transaction and DynamoDB
  `TransactWriteItems` so both paths are atomic.

Easy swaps: S3→MinIO (same API); SQS→Redis (plain JSON messages); Lambda
event→HTTP adapter (mechanical).

## Web app
Stays on Amplify for hosted. Self-host uses the same Next.js image with the
backend URL as **runtime** config (a server-read `/config` or runtime env), not
the build-time `NEXT_PUBLIC_…`.

**Auth is pluggable** (`AUTH_PROVIDER`): hosted uses WorkOS/AuthKit; self-host
uses **generic OIDC** (`AUTH_PROVIDER=oidc`) against any standards-compliant IdP
(Keycloak, Authentik, Dex, Auth0, Okta, Entra ID, …). The OIDC path needs
`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, an iron-session
`SESSION_SECRET`, and an admin signal — either a group/role claim
(`ADMIN_OIDC_GROUP`) or an email allowlist (`ADMIN_EMAILS`). No WorkOS account is
required to self-host.

## Self-host packaging (Helm)
Chart (`charts/agentkitmarket/`) deploys `web` (agentkitmarket-app), `api`
(server), `worker`, plus bundled `postgres`, `minio`, `redis` (toggleable; BYO
external for HA), Ingress, and a ConfigMap/Secret per tier. The
`values-k3s.yaml` preset is the batteries-included self-host profile: OIDC on,
bundled data services, **plain Kubernetes Secrets** (no Infisical / external
secret manager required), and **chart-generated** `ADMIN_API_KEY`,
`SESSION_SECRET`, and DB/MinIO passwords (persisted via `lookup` across
upgrades, never a `changeme` placeholder). The web tier reuses the backend's
generated `ADMIN_API_KEY` automatically. **Validated end-to-end on the project
owner's homelab k8s** before publishing.

## CI anti-drift
The core test suite runs **twice** — against DynamoDB-local and against a
Postgres container — so the self-host path cannot silently break. This is the
single most important guard for "same code, not a fork."

## Phased plan
1. **Extract core** — move routes/services out of the Lambda handler behind the
   ports; Lambda becomes a thin adapter. *Pure refactor; hosted unchanged.* Ship + verify.
2. **Self-host adapters** — Postgres + MinIO + Redis + the dual-backend CI suite.
3. **Container entrypoints** — `server.ts` + `worker.ts` + Dockerfile.
4. **Helm chart** — deploy + verify on homelab k8s.
5. **Web app runtime config** — self-host web image.
6. **Docs** — a `helm install` self-hosting guide.
7. **OIDC + plain-Secrets self-host** — pluggable web auth (`AUTH_PROVIDER=oidc`),
   chart credential generation, and the `values-k3s.yaml` one-command preset.

Each phase is independently shippable; #1 de-risks everything after it.

## Out of scope here
Org/team/private-catalog features and paid/licensed kits are separate Market
Phase 2 tracks; this design only makes the *current* feature set self-hostable.
Org features layer on after, contracts-first.
