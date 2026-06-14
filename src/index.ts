/**
 * @agentkitforge/market-core — public surface.
 *
 * Phase 0 exports the ports only. Subsequent phases add:
 *   - core router + services (the shared domain logic)
 *   - adapter factories (aws, selfhost)
 * Entrypoints are exposed via the package subpath exports
 * (./entrypoints/lambda | server | worker), not from this index.
 */
export type {
  ConfigProvider,
  ObjectStore,
  MessageQueue,
  ValidationJobMessage,
  StorageRepo,
} from "./core/ports.js";
