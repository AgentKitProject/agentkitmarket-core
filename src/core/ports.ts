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
  AddFavoriteInput,
  CatalogPage,
  CatalogDetail,
  CreateSubmissionInput,
  CreateSubmissionResult,
  Entitlement,
  Favorite,
  GrantEntitlementInput,
  KitRecord,
  KitVersionRecord,
  KitVisibility,
  KitPricing,
  PriceModel,
  PriceInterval,
  LicenseType,
  Organization,
  OrgInvite,
  OrgMembership,
  OrgRole,
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
  /**
   * Sets Tier-2 pricing/license metadata on a kit. Caller enforces role gates +
   * validation (paid requires priceCents>0 + priceModel; subscription requires
   * interval); the repository persists the resolved fields and returns the kit.
   */
  setKitPricing(kitId: string, pricing: KitPricingUpdate): Promise<KitRecord | undefined>;
  getKitVersion(kitId: string, version: string): Promise<KitVersionRecord | undefined>;
  listKitVersions(kitId: string): Promise<KitVersionRecord[]>;
  findKitVersionBySha256(sha256: string): Promise<KitVersionRecord | undefined>;
  incrementKitDownloads(kitId: string): Promise<void>;
  /**
   * Validation-worker writes. Mirror the fields the infra validation worker set
   * via direct DynamoDB UpdateItem so the worker writes through the port instead
   * of a cloud SDK. Implemented by both the AWS (DynamoDB) and self-host
   * (Postgres) adapters.
   */
  updateValidationJob(jobId: string, update: ValidationJobUpdate): Promise<void>;
  updateSubmissionValidationResult(submissionId: string, update: SubmissionValidationUpdate): Promise<void>;
}

/**
 * Organizations, memberships, invites + kit-ownership mutations.
 *
 * Backs Market Phase 2 org slices (orgs, team roles, private catalogs). Both the
 * AWS (DynamoDB) and self-host (Postgres) adapters implement this identically;
 * the dual-backend contract suite enforces parity.
 */
export interface OrgRepository {
  /** Creates an org with a unique slug (numeric-suffix dedupe) and an active owner membership. */
  createOrg(input: {
    displayName: string;
    ownerUserId: string;
    type?: 'personal' | 'team';
    slug?: string;
    handle?: string;
  }): Promise<Organization>;
  getOrg(orgId: string): Promise<Organization | undefined>;
  getOrgBySlug(slug: string): Promise<Organization | undefined>;
  /** Idempotently returns the user's personal org, creating it if absent. */
  ensurePersonalOrg(userId: string, displayName: string): Promise<Organization>;
  /** Orgs the user is an active or invited member of. */
  listOrgsForUser(userId: string): Promise<Organization[]>;
  getMembership(orgId: string, userId: string): Promise<OrgMembership | undefined>;
  listMembers(orgId: string): Promise<OrgMembership[]>;
  /** Adds an `invited` membership + a pending invite for the user. */
  addMember(orgId: string, userId: string, role: OrgRole, invitedBy: string): Promise<OrgMembership>;
  /** Flips an `invited` membership to `active` and clears the invite. */
  acceptInvite(orgId: string, userId: string): Promise<OrgMembership | undefined>;
  listInvitesForUser(userId: string): Promise<OrgInvite[]>;
  removeMember(orgId: string, userId: string): Promise<void>;
  /** Hard-deletes an org and all its memberships + invites. Caller enforces guards. */
  deleteOrg(orgId: string): Promise<void>;
  setKitOwnerOrg(kitId: string, orgId: string): Promise<KitRecord | undefined>;
  setKitVisibility(kitId: string, visibility: KitVisibility): Promise<KitRecord | undefined>;
  /** All kits owned by an org, including private ones (for the org's own listing). */
  listKitsForOrg(orgId: string): Promise<KitRecord[]>;
}

/**
 * Resolved Tier-2 pricing/license fields to persist on a kit. The route layer
 * resolves licenseVersion (default-license version when licenseType==='default')
 * and the downloadable default (paid → false, free → true) before calling the
 * repository, so adapters just write what they are given.
 */
export interface KitPricingUpdate {
  pricing: KitPricing;
  priceModel?: PriceModel;
  priceCents?: number;
  currency: string;
  interval?: PriceInterval;
  downloadable: boolean;
  licenseType: LicenseType;
  licenseText?: string;
  licenseVersion: string;
}

/**
 * Buyer entitlements for paid (and explicitly-granted free) kits.
 *
 * Hot path is `getEntitlement(userId, kitId)` ("does U hold K?"). Both the AWS
 * (DynamoDB: PK userId / SK kitId, GSI kitId-index) and self-host (Postgres: PK
 * (user_id, kit_id) + index on kit_id) adapters implement this identically; the
 * dual-backend contract suite enforces parity.
 */
export interface EntitlementRepository {
  /** Idempotent on (userId, kitId): re-granting updates the existing row to active. */
  grantEntitlement(input: GrantEntitlementInput): Promise<Entitlement>;
  getEntitlement(userId: string, kitId: string): Promise<Entitlement | undefined>;
  listEntitlementsForUser(userId: string): Promise<Entitlement[]>;
  /** Flips an active entitlement to `revoked`; returns the updated row or undefined. */
  revokeEntitlement(userId: string, kitId: string): Promise<Entitlement | undefined>;
  listEntitlementsForKit(kitId: string): Promise<Entitlement[]>;
}

/**
 * Cloud-synced kit-reference favorites, shared by desktop + web Forge and the
 * Market web app. Both adapters (AWS DynamoDB: PK userId / SK kitId; self-host
 * Postgres: PK (user_id, kit_id) + index on user_id) implement this identically;
 * the dual-backend contract suite enforces parity. Favorites are references,
 * never kit copies — cached display metadata is best-effort.
 */
export interface FavoritesRepository {
  /** Idempotent on (userId, kitId): re-adding refreshes cached metadata + addedAt is preserved. */
  addFavorite(userId: string, input: AddFavoriteInput): Promise<Favorite>;
  listFavorites(userId: string): Promise<Favorite[]>;
  removeFavorite(userId: string, kitId: string): Promise<void>;
}

/** Fields the validation worker writes to a ValidationJob row. */
export interface ValidationJobUpdate {
  status: string;
  updatedAt: string;
  result?: unknown;
  startedAt?: string;
  completedAt?: string;
}

/** Fields the validation worker writes to a Submission row on completion. */
export interface SubmissionValidationUpdate {
  status: string;
  validationStatus: string;
  validationSummary: unknown;
  updatedAt: string;
  packageSizeBytes?: number;
  sha256?: string;
  contentType?: string;
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
  /**
   * Idempotently ensure the backing bucket exists. Self-host (MinIO) starts
   * empty, so the composition root calls this once on startup; "already
   * exists" / "already owned by you" must be treated as success. Hosted S3
   * buckets are CDK-managed, so the AWS implementation is a safe verify/no-op
   * and the hosted Lambda entrypoint never calls it.
   */
  ensureBucket(): Promise<void>;
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
