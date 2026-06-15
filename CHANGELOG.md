# Changelog

## [0.5.0](https://github.com/AgentKitProject/agentkitmarket-core/compare/v0.4.0...v0.5.0) (2026-06-15)


### Features

* route hosted Lambda by request path for {proxy+} integration ([a5a152a](https://github.com/AgentKitProject/agentkitmarket-core/commit/a5a152a9922afa9b21bf5f75ef388c5c963fa609))


### Bug Fixes

* **schema:** ALTER ADD COLUMN owner_org_id/visibility for upgrade-safety ([79d7a62](https://github.com/AgentKitProject/agentkitmarket-core/commit/79d7a62c65250d963d29b7c0c7adb9903f15f73a))

## [0.4.0](https://github.com/AgentKitProject/agentkitmarket-core/compare/v0.3.0...v0.4.0) (2026-06-15)


### Features

* implement AgentKitMarket Organizations (all 3 slices) ([6278e7d](https://github.com/AgentKitProject/agentkitmarket-core/commit/6278e7d05dd9a972a86dd6ff2dfc8e00594ff43b))

## [0.3.0](https://github.com/AgentKitProject/agentkitmarket-core/compare/v0.2.0...v0.3.0) (2026-06-15)


### Features

* **chart:** auto-default DB/S3/Redis URLs to bundled in-cluster services ([d84bbbc](https://github.com/AgentKitProject/agentkitmarket-core/commit/d84bbbc43f67733fb41a7ec1af785554b56e175a))
* **chart:** imagePullSecrets support + default image tag to latest ([efc4a41](https://github.com/AgentKitProject/agentkitmarket-core/commit/efc4a417f3d22ec9e78be034e5eaaf3b9c6528f8))
* **chart:** optional ADMIN_API_KEY from an existing (Infisical-synced) Secret ([7fce520](https://github.com/AgentKitProject/agentkitmarket-core/commit/7fce520b5629e319420b53cc4161b300cae9dd7c))
* **chart:** optional web (agentkitmarket-app) Deployment/Service/Ingress ([bfc696d](https://github.com/AgentKitProject/agentkitmarket-core/commit/bfc696dbdc35882b1670b8c3fb520246e53a9de5))
* **chart:** secrets.existingSecret — full external secret for app + bundled creds ([8ced879](https://github.com/AgentKitProject/agentkitmarket-core/commit/8ced8794432b308759c8c0662566a6850c531d24))
* ensureBucket() on object store (self-host MinIO auto-create) + dynamodb-local contract CI leg ([9b65090](https://github.com/AgentKitProject/agentkitmarket-core/commit/9b65090b776b240b1f390a3b795517593bf0bbb9))
* self-host packaging — Dockerfile, image CI, Helm chart ([152f2d3](https://github.com/AgentKitProject/agentkitmarket-core/commit/152f2d303b9464c2180174dc1793f361d1eb4347))


### Bug Fixes

* --ignore-scripts in Docker npm ci (prepare runs build before src copied) ([1f6eeb3](https://github.com/AgentKitProject/agentkitmarket-core/commit/1f6eeb3454f02cfc786456ba437c01bbc92325cc))
* **aws:** archive/cancelSubmission gracefully refuse published (catch ConditionalCheckFailedException) ([3ca6396](https://github.com/AgentKitProject/agentkitmarket-core/commit/3ca6396b4a94eb2a8af9f3d9791d3dc2a54790e6))
* **chart:** ingress defaultBackend when no host (tailscale compatibility) ([f7db5d8](https://github.com/AgentKitProject/agentkitmarket-core/commit/f7db5d89defc322b7ca86b9390859325b956cb22))
* **server:** advisory-lock schema init so concurrent replicas don't race ([5e15ae0](https://github.com/AgentKitProject/agentkitmarket-core/commit/5e15ae0d291a18c8445c74fd4598f354995af149))


### Documentation

* **self-hosting:** web UI, external-secret GitOps, advisory-lock + ensureBucket notes ([8de1be7](https://github.com/AgentKitProject/agentkitmarket-core/commit/8de1be78055470e25f9d713d9b4d695cf974fd48))

## [0.2.0](https://github.com/AgentKitProject/agentkitmarket-core/compare/v0.1.0...v0.2.0) (2026-06-15)


### Features

* container runtime + shared validation worker ([fde72cf](https://github.com/AgentKitProject/agentkitmarket-core/commit/fde72cf58101f00a2e71b6b1edc1c91c8d4fbd49))
* self-host adapters (Postgres, MinIO, Redis) + repository contract suite ([5981a48](https://github.com/AgentKitProject/agentkitmarket-core/commit/5981a48d146b82d5564fcb553a3992f1090ec9dc))

## 0.1.0 (2026-06-15)


### chore

* seed first release at 0.1.0 ([6aec82c](https://github.com/AgentKitProject/agentkitmarket-core/commit/6aec82c7c2fefd2775bab0e1a02baed02c3cf039))


### Features

* extract market backend core (services, routes, AWS adapters, Lambda entrypoint) ([bdce157](https://github.com/AgentKitProject/agentkitmarket-core/commit/bdce1573f649877c3c97958e459e063c5b1eda4d))
