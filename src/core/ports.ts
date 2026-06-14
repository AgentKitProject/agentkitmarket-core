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
 *
 * `CatalogRepository`, `AdminRepository`, and `PackageUploadService` are moved
 * verbatim (Phase 1) from agentkitmarket-infra's Lambda handler so the data-access
 * contract has a single home. The AWS adapter wraps the existing DynamoDB/S3/SQS
 * code; the self-host adapter (Phase 2) implements the same interfaces over
 * Postgres/MinIO/Redis.
 */

import type {
  CatalogPage,
  CatalogDetail,
  CreateSubmissionInput,
  CreateSubmissionResult,
  KitRecord,
  KitVersionRecord,
  SubmissionRecord,
  ValidationJobRecord,
} from "./types.js";

/** Application configuration + secrets, sourced per runtime (env, k8s Secret, AWS Secrets Manager). */
export interface ConfigProvider {
  /** Returns a config value; throws if `required` and missing. */
  get(key: string, required?: boolean): string | undefined;
}

/** Read side: public catalog queries. */
export interface CatalogRepository {
  listKits(limit: number, nextToken: string | undefined): Promise<CatalogPage>;
  getKitBySlug(slug: string): Promise<CatalogDetail>;
}

/** Write side + admin/user mutations: the submission + kit state machine. */
export interface AdminRepository {
  createSubmission(input: CreateSubmissionInput): Promise<CreateSubmissionResult>;
  findActiveDuplicateSubmission(input: CreateSubmissionInput): Promise<SubmissionRecord | undefined>;
  getSubmission(submissionId: string): Promise<SubmissionRecord | undefined>;
  listSubmissions(): Promise<SubmissionRecord[]>;
  createValidationJob(submission: SubmissionRecord): Promise<ValidationJobRecord>;
  markSubmissionValidationQueued(submissionId: string, validationJobId: string): Promise<void>;
  approveSubmission(submissionId: string, reviewNotes: string | null, reviewedAt: string): Promise<SubmissionRecord | undefined>;
  rejectSubmission(submissionId: string, reviewNotes: string, reviewedAt: string): Promise<SubmissionRecord | undefined>;
  archiveSubmission(submissionId: string, archivedAt: string): Promise<SubmissionRecord | undefined>;
  cancelSubmission(submissionId: string, canceledAt: string): Promise<SubmissionRecord | undefined>;
  publishSubmission(submission: SubmissionRecord, publishedAt: string): Promise<KitRecord>;
  hideKit(kitId: string): Promise<KitRecord | undefined>;
  unhideKit(kitId: string): Promise<KitRecord | undefined>;
  removeKit(kitId: string, removedAt: string): Promise<KitRecord | undefined>;
  getKit(kitId: string): Promise<KitRecord | undefined>;
  getKitBySlug(slug: string): Promise<KitRecord | undefined>;
  getKitVersion(kitId: string, version: string): Promise<KitVersionRecord | undefined>;
  listKitVersions(kitId: string): Promise<KitVersionRecord[]>;
  findKitVersionBySha256(sha256: string): Promise<KitVersionRecord | undefined>;
  incrementKitDownloads(kitId: string): Promise<void>;
}

/**
 * Package upload/download + validation enqueue. Today this is one combined port
 * (matching the existing Lambda implementation). Phase 2 decomposes it into the
 * cleaner `ObjectStore` + `MessageQueue` ports below so the self-host adapter can
 * implement object storage (MinIO) and queueing (Redis) independently.
 */
export interface PackageUploadService {
  createUploadUrl(packageS3Key: string): Promise<string>;
  createDownloadUrl(packageS3Key: string): Promise<string>;
  packageExists(packageS3Key: string): Promise<boolean>;
  enqueueValidationJob(job: ValidationJobRecord): Promise<void>;
}

// --- Phase 2 decomposition target (not yet wired) -------------------------------
// PackageUploadService will be split into these two ports so storage and queueing
// can be swapped independently (S3↔MinIO, SQS↔Redis).

/** The validation job envelope passed through the queue (transport-agnostic). */
export interface ValidationJobMessage {
  jobId: string;
  submissionId: string;
  kitId: string;
  packageKey: string;
}

/** Object storage for kit packages (`.agentkit.zip`). S3 in hosted, MinIO in self-host. */
export interface ObjectStore {
  createUploadUrl(key: string): Promise<string>;
  createDownloadUrl(key: string): Promise<string>;
  exists(key: string): Promise<boolean>;
  readStream(key: string): Promise<AsyncIterable<Uint8Array>>;
}

/** Async work queue for validation jobs. SQS in hosted, Redis in self-host. */
export interface MessageQueue {
  enqueue(payload: ValidationJobMessage): Promise<void>;
  subscribe(handler: (payload: ValidationJobMessage) => Promise<void>): Promise<void>;
}
