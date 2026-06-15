/**
 * @agentkitforge/market-core — public surface.
 *
 * Phase 1 (in progress) exports the domain types + data-access ports. Subsequent
 * steps add the core router + services (shared domain logic) and the adapter
 * factories (aws, selfhost). Entrypoints are exposed via the package subpath
 * exports (./entrypoints/lambda | server | worker), not from this index.
 */
export type * from "./core/types.js";
export type {
  ConfigProvider,
  CatalogRepository,
  AdminRepository,
  PackageUploadService,
  ObjectStore,
  MessageQueue,
  ValidationJobMessage,
  ValidationJobUpdate,
  SubmissionValidationUpdate,
} from "./core/ports.js";

// Config + validation service (cloud-free) — usable by both runtimes.
export { EnvConfigProvider, loadSelfHostConfig } from "./core/config.js";
export type { SelfHostConfig, SelfHostObjectStoreConfig } from "./core/config.js";
export { runValidationJob } from "./core/services/validation.js";
export type { ValidationSummary, RunValidationDeps } from "./core/services/validation.js";

// Domain services (pure shaping + state-machine helpers) and the
// runtime-agnostic router. Entrypoints remain exposed only via the package
// subpath exports (./entrypoints/lambda | server | worker).
export * from "./core/services/index.js";
export * from "./core/services/constants.js";
export { routeRequest } from "./core/routes/index.js";
export type { CoreRequest, CoreResponse, RouterDeps } from "./core/routes/types.js";
