# @agentkitforge/market-core

Runtime- and cloud-agnostic **AgentKitMarket backend core**. The market's domain
logic (routes, submission/kit state machine, validation, publishing) lives here
exactly once and runs in two places via thin adapters + entrypoints:

| Deployment | Entrypoint | Adapters | Where |
|---|---|---|---|
| **Hosted** | `entrypoints/lambda` | DynamoDB · S3 · SQS | AWS Lambda (wired by `agentkitmarket-infra`), Amplify web |
| **Self-hosted** | `entrypoints/server` + `entrypoints/worker` | Postgres · MinIO · Redis | container + Helm chart on Kubernetes |

The core depends only on the **ports** in `src/core/ports.ts`; never on a cloud
SDK directly. The same test suite runs against both adapter sets in CI — that's
the anti-drift guarantee that keeps "hosted" and "self-hosted" the *same* code.

See **[docs/SELF_HOSTING_DESIGN.md](docs/SELF_HOSTING_DESIGN.md)** for the full
design and phased plan.

## Layout
```
src/
  core/        ports.ts (interfaces); routes/ services/ (added in phase 1)
  adapters/    aws/ (DynamoDB/S3/SQS)   selfhost/ (Postgres/MinIO/Redis)
  entrypoints/ lambda.ts  server.ts  worker.ts
```

## Develop
```bash
npm install
npm run build       # tsc
npm test            # vitest (dual-backend suite added in phase 2)
npm run typecheck
```

Status: **Phase 0 — scaffold.** Ports + structure committed; extraction of the
domain logic from `agentkitmarket-infra` is Phase 1.
