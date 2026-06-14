/**
 * Ports: the runtime- and cloud-agnostic interfaces the market core depends on.
 *
 * Each port has two adapters (see ../adapters):
 *   - aws/      → DynamoDB / S3 / SQS         (hosted deployment, behind Lambda)
 *   - selfhost/ → Postgres / MinIO / Redis    (self-hosted deployment, container on k8s)
 *
 * The core/services and core/routes layers MUST depend only on these ports,
 * never on a concrete adapter or any cloud SDK. That is what keeps the domain
 * logic identical across the hosted and self-hosted runtimes.
 */

/** Application configuration + secrets, sourced per runtime (env, k8s Secret, AWS Secrets Manager). */
export interface ConfigProvider {
  /** Returns a config value; throws if `required` and missing. */
  get(key: string, required?: boolean): string | undefined;
}

/** Object storage for kit packages (`.agentkit.zip`). S3 in hosted, MinIO (S3-compatible) in self-host. */
export interface ObjectStore {
  /** Presigned/temporary URL the client uses to PUT the package. */
  createUploadUrl(key: string): Promise<string>;
  /** Presigned/temporary URL the client uses to GET (download) the package. */
  createDownloadUrl(key: string): Promise<string>;
  /** Whether an object exists at `key`. */
  exists(key: string): Promise<boolean>;
  /** Stream the object's bytes (used by the validation worker to hash + inspect). */
  readStream(key: string): Promise<AsyncIterable<Uint8Array>>;
}

/** Async work queue for validation jobs. SQS in hosted, Redis in self-host. JSON payloads only. */
export interface MessageQueue {
  /** Enqueue a validation job payload. */
  enqueue(payload: ValidationJobMessage): Promise<void>;
  /**
   * Long-running consumer (self-host worker entrypoint). In hosted, the SQS→Lambda
   * event source replaces this; the handler body it calls is the same core logic.
   */
  subscribe(handler: (payload: ValidationJobMessage) => Promise<void>): Promise<void>;
}

/** The validation job envelope passed through the queue (transport-agnostic). */
export interface ValidationJobMessage {
  jobId: string;
  submissionId: string;
  kitId: string;
  packageKey: string;
}

/**
 * StorageRepo is the data-access port. In Phase 1 the existing
 * `CatalogRepository` + `AdminRepository` interfaces from
 * `agentkitmarket-infra/src/lambda/api/index.ts` are moved here verbatim and
 * re-exported, then implemented by both `adapters/aws` (DynamoDB) and
 * `adapters/selfhost` (Postgres). Defined as a placeholder now so the package
 * shape and the design intent are committed before the extraction.
 *
 * TODO(phase-1): replace this stub with the extracted CatalogRepository +
 * AdminRepository definitions.
 */
export interface StorageRepo {
  readonly __extractedInPhase1?: never;
}
