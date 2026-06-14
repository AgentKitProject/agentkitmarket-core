/**
 * Domain types for the AgentKitMarket backend core.
 *
 * Moved verbatim from agentkitmarket-infra's Lambda handler in Phase 1 so the
 * record/value shapes have a single home shared by both deployments. These are
 * pure data types — no cloud SDK, no runtime coupling.
 */

export type JsonRecord = Record<string, unknown>;

export interface SafeInput {
  name: string;
  label?: string;
  type?: string;
  description?: string;
}

export interface SafePreparedPrompt {
  name: string;
  title?: string;
  summary?: string;
}

export interface SafeSkill {
  name: string;
  title?: string;
  summary?: string;
}

export interface SafeValidationSummary {
  status?: string;
  summary?: string;
  checkedAt?: string;
  errors?: string[];
}

export interface PublisherSnapshot {
  displayName?: string | null;
  handle?: string | null;
  avatarInitials?: string | null;
  verified?: boolean;
}

export interface PublicPublisherSnapshot extends PublisherSnapshot {
  publisherId: string;
}

export interface KitRecord {
  kitId: string;
  slug: string;
  name: string;
  summary: string;
  publisherId: string;
  ownerUserId?: string;
  publisher?: unknown;
  status: string;
  validationStatus: string;
  reviewStatus: string;
  categories?: unknown;
  tags?: unknown;
  currentVersion?: string;
  verificationStatus?: string;
  badges?: unknown;
  requiredInputs?: unknown;
  preparedPrompts?: unknown;
  skills?: unknown;
  description?: string;
  validationSummary?: unknown;
  importUrl?: string;
  downloadUrl?: string;
  createdAt?: string;
  updatedAt?: string;
  publishedAt?: string;
  removedAt?: string;
  downloads?: number;
  featured?: boolean;
  featuredRank?: number | null;
  latestVersion?: unknown;
}

export interface PublisherRecord {
  publisherId: string;
  displayName: string;
  handle?: string;
  avatarInitials?: string;
  verified?: boolean;
}

export interface KitVersionRecord {
  kitId: string;
  version: string;
  fileName?: string | null;
  packageFileName?: string | null;
  packageSizeBytes?: number | null;
  summary?: string;
  schemaVersion?: string;
  publishedAt?: string;
  packageS3Key?: string;
  sha256?: string;
  contentType?: string;
  validationSummary?: unknown;
  validationResult?: unknown;
  releaseNotes?: string;
}

export interface CatalogPage {
  kits: KitRecord[];
  publishers: Map<string, PublisherRecord>;
  nextToken: string | null;
}

export interface CatalogDetail {
  kit: KitRecord | undefined;
  publisher: PublisherRecord | undefined;
  versions: KitVersionRecord[];
}

export interface ListingDraft {
  name: string;
  summary: string;
  description?: string;
  categories?: string[];
  tags?: string[];
}

export interface SubmissionRecord {
  submissionId: string;
  kitId: string;
  version?: string;
  publisherId: string;
  submittedByUserId?: string;
  submittedByEmail?: string;
  publisherSnapshot?: PublisherSnapshot;
  packageS3Key: string;
  fileName?: string;
  packageFileName?: string;
  packageSizeBytes?: number;
  sha256?: string;
  contentType?: string;
  schemaVersion?: string;
  status: string;
  validationStatus: string;
  reviewStatus: string;
  submissionType?: string;
  targetKitId?: string;
  reviewNotes?: string | null;
  listingDraft: ListingDraft;
  validationSummary?: JsonRecord;
  expiresAt?: number;
  reviewedAt?: string;
  publishedAt?: string;
  archivedAt?: string;
  canceledAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ValidationJobRecord {
  jobId: string;
  submissionId: string;
  kitId: string;
  packageS3Key: string;
  status: string;
  result?: JsonRecord;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSubmissionInput {
  fileName: string;
  version: string;
  publisherId: string;
  submittedByUserId?: string;
  submittedByEmail?: string;
  publisherSnapshot?: PublisherSnapshot;
  listingDraft: ListingDraft;
  submissionType?: string;
  targetKitId?: string;
  allowDuplicate?: boolean;
}

export interface CreateSubmissionResult {
  submission: SubmissionRecord;
  version: string;
}
