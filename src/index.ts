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
} from "./core/ports.js";
