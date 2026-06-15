/**
 * Domain services for the market core: the pure shaping functions, the
 * submission/kit state-machine helpers, validation/duplicate rules, version
 * helpers, and the type guards.
 *
 * Moved verbatim (Phase 1) from agentkitmarket-infra's Lambda handler. These
 * functions MUST NOT import any AWS SDK or aws-lambda types — they operate only
 * on the domain types from ../types.js. Behavior is identical to the original
 * handler; only the location changed.
 */

import { randomUUID } from 'node:crypto';
import type {
  CreateSubmissionInput,
  JsonRecord,
  KitRecord,
  KitVersionRecord,
  PublicPublisherSnapshot,
  PublisherRecord,
  PublisherSnapshot,
  SafeInput,
  SafePreparedPrompt,
  SafeSkill,
  SafeValidationSummary,
  SubmissionRecord,
} from '../types.js';
import {
  ARCHIVED_STATUS,
  AWAITING_UPLOAD_TTL_MS,
  CANCELED_STATUS,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  PUBLIC_REVIEW_STATUS,
  PUBLIC_STATUS,
  PUBLIC_VALIDATION_STATUS,
  REVIEW_QUEUE_RETENTION_MS,
} from './constants.js';

/**
 * Builds a new submission record. The server owns the submissionId, kitId, and
 * packageS3Key — client-provided slugs/kit ids are never used for a new_kit. A
 * version_update reuses the (already owner-verified) targetKitId. Exported for
 * unit tests of the ownership/versioning/TTL behavior.
 */
export function buildSubmissionRecord(input: CreateSubmissionInput): SubmissionRecord {
  const now = new Date().toISOString();
  const submissionId = `submission_${randomUUID()}`;
  const submissionType = input.submissionType === 'version_update' ? 'version_update' : 'new_kit';
  const kitId = submissionType === 'version_update' && input.targetKitId
    ? input.targetKitId
    : `kit_${slugify(input.listingDraft.name)}_${randomUUID().slice(0, 8)}`;
  const packageS3Key = `submissions/${submissionId}/package.agentkit.zip`;

  return {
    submissionId,
    kitId,
    version: input.version,
    publisherId: input.publisherId,
    submittedByUserId: input.submittedByUserId,
    submittedByEmail: input.submittedByEmail,
    publisherSnapshot: safePublisherSnapshot(input.publisherSnapshot),
    packageS3Key,
    fileName: sanitizeOriginalFileName(input.fileName),
    packageFileName: safeDownloadFileName(slugifyForUrl(input.listingDraft.name), input.version),
    contentType: 'application/zip',
    status: 'awaiting_upload',
    validationStatus: 'pending',
    reviewStatus: 'pending',
    submissionType,
    targetKitId: submissionType === 'version_update' ? input.targetKitId : undefined,
    listingDraft: input.listingDraft,
    // TTL: never-finished awaiting_upload rows expire ~1h out; cleared on upload.
    expiresAt: Math.floor((Date.now() + AWAITING_UPLOAD_TTL_MS) / 1000),
    createdAt: now,
    updatedAt: now,
  };
}

export function toPublicKit(kit: KitRecord, publisher: PublisherRecord | undefined): JsonRecord {
  const safePublisher = safePublicPublisher(kit.publisher, kit.publisherId, publisher);

  return {
    kitId: kit.kitId,
    slug: kit.slug,
    name: kit.name,
    summary: kit.summary,
    publisher: safePublisher,
    categories: stringArray(kit.categories),
    tags: stringArray(kit.tags),
    currentVersion: kit.currentVersion ?? null,
    latestVersion: safeLatestVersion(kit),
    verificationStatus: kit.verificationStatus ?? 'reviewed',
    badges: stringArray(kit.badges, defaultBadges(kit)),
    requiredInputs: safeInputs(kit.requiredInputs),
    preparedPrompts: safePreparedPrompts(kit.preparedPrompts),
    skills: safeSkills(kit.skills),
    downloadCount: typeof kit.downloads === 'number' ? kit.downloads : 0,
    featured: kit.featured === true,
    featuredRank: typeof kit.featuredRank === 'number' ? kit.featuredRank : null,
    publishedAt: kit.publishedAt ?? null,
    updatedAt: kit.updatedAt ?? null,
    // Tier-2: surface price metadata so the catalog can display it. Defaults keep
    // free kits behaving exactly as before. License text/body is NOT surfaced here.
    pricing: kit.pricing === 'paid' ? 'paid' : 'free',
    priceModel: kit.pricing === 'paid' ? (kit.priceModel ?? null) : null,
    priceCents: kit.pricing === 'paid' && typeof kit.priceCents === 'number' ? kit.priceCents : null,
    currency: kit.currency ?? 'USD',
    interval: kit.pricing === 'paid' && kit.priceModel === 'subscription' ? (kit.interval ?? null) : null,
    downloadable: kit.pricing === 'paid' ? kit.downloadable === true : true,
    licenseType: kit.licenseType === 'custom' ? 'custom' : 'default',
    licenseVersion: kit.licenseType === 'custom' ? 'custom' : (kit.licenseVersion ?? null),
  };
}

export function toPublicKitDetail(
  kit: KitRecord,
  publisher: PublisherRecord | undefined,
  versions: KitVersionRecord[],
): JsonRecord {
  const latestVersion = versions.find((version) => version.version === kit.currentVersion) ?? versions[0];

  return {
    ...toPublicKit(kit, publisher),
    description: kit.description ?? null,
    latestVersion: latestVersion
      ? toPublicVersion(latestVersion)
      : null,
    validationSummary: safeValidationSummary(kit.validationSummary),
    versions: versions.map(toPublicVersion),
    importUrl: safeUrl(kit.importUrl),
  };
}

export function toPublicVersion(version: KitVersionRecord): JsonRecord {
  return {
    version: version.version,
    summary: version.summary ?? null,
    schemaVersion: version.schemaVersion ?? null,
    packageSizeBytes: typeof version.packageSizeBytes === 'number' ? version.packageSizeBytes : null,
    sha256: typeof version.sha256 === 'string' ? version.sha256 : null,
    publishedAt: version.publishedAt ?? null,
  };
}

export function safeLatestVersion(kit: KitRecord): JsonRecord | null {
  const record = kit.latestVersion as Partial<KitVersionRecord> | undefined;
  if (record && typeof record.version === 'string') {
    return toPublicVersion({
      kitId: kit.kitId,
      version: record.version,
      summary: typeof record.summary === 'string' ? record.summary : undefined,
      schemaVersion: typeof record.schemaVersion === 'string' ? record.schemaVersion : undefined,
      packageSizeBytes: typeof record.packageSizeBytes === 'number' ? record.packageSizeBytes : null,
      sha256: typeof record.sha256 === 'string' ? record.sha256 : undefined,
      publishedAt: typeof record.publishedAt === 'string' ? record.publishedAt : undefined,
    });
  }

  if (kit.currentVersion) {
    return toPublicVersion({
      kitId: kit.kitId,
      version: kit.currentVersion,
      publishedAt: kit.publishedAt,
    });
  }

  return null;
}

export function toAdminSubmission(submission: SubmissionRecord): JsonRecord {
  return {
    submissionId: submission.submissionId,
    kitId: submission.kitId,
    version: submission.version ?? null,
    publisherId: submission.publisherId,
    submittedByUserId: submission.submittedByUserId ?? null,
    submittedByEmail: submission.submittedByEmail ?? null,
    publisherSnapshot: safePublisherSnapshot(submission.publisherSnapshot),
    packageS3Key: submission.packageS3Key,
    fileName: submission.fileName ?? null,
    packageFileName: submission.packageFileName ?? null,
    packageSizeBytes: submission.packageSizeBytes ?? null,
    sha256: submission.sha256 ?? null,
    contentType: submission.contentType ?? null,
    schemaVersion: submission.schemaVersion ?? null,
    status: submission.status,
    validationStatus: submission.validationStatus,
    reviewStatus: submission.reviewStatus,
    submissionType: submission.submissionType ?? 'new_kit',
    targetKitId: submission.targetKitId ?? null,
    reviewNotes: submission.reviewNotes ?? null,
    listingDraft: submission.listingDraft,
    validationSummary: safeValidationSummary(submission.validationSummary),
    reviewedAt: submission.reviewedAt ?? null,
    publishedAt: submission.publishedAt ?? null,
    archivedAt: submission.archivedAt ?? null,
    canceledAt: submission.canceledAt ?? null,
    createdAt: submission.createdAt,
    updatedAt: submission.updatedAt,
  };
}

export function validateUploadUrlRequest(value: unknown): string | null {
  const request = value as Partial<CreateSubmissionInput> | undefined;
  if (!request || typeof request !== 'object') {
    return 'Invalid JSON body';
  }

  if (typeof request.fileName !== 'string' || !request.fileName.endsWith('.agentkit.zip')) {
    return 'fileName must end with .agentkit.zip';
  }

  if (typeof request.version !== 'string' || request.version.trim().length === 0) {
    return 'version is required';
  }

  if (typeof request.publisherId !== 'string' || request.publisherId.trim().length === 0) {
    return 'publisherId is required';
  }

  if (request.submittedByUserId !== undefined
    && (typeof request.submittedByUserId !== 'string' || request.submittedByUserId.trim().length === 0)) {
    return 'submittedByUserId must be a non-empty string when provided';
  }

  if (request.submittedByEmail !== undefined
    && (typeof request.submittedByEmail !== 'string' || !isReasonableEmail(request.submittedByEmail))) {
    return 'submittedByEmail must be a valid email string when provided';
  }

  if (!publisherSnapshotOrUndefined(request.publisherSnapshot)) {
    return 'publisherSnapshot must contain public-safe profile strings when provided';
  }

  if (request.allowDuplicate !== undefined && typeof request.allowDuplicate !== 'boolean') {
    return 'allowDuplicate must be a boolean when provided';
  }

  if (request.submissionType !== undefined
    && request.submissionType !== 'new_kit'
    && request.submissionType !== 'version_update') {
    return 'submissionType must be new_kit or version_update when provided';
  }

  if (request.submissionType === 'version_update'
    && (typeof request.targetKitId !== 'string' || request.targetKitId.trim().length === 0)) {
    return 'targetKitId is required for version_update submissions';
  }

  if (request.submissionType !== 'version_update' && request.targetKitId !== undefined) {
    return 'targetKitId is only allowed for version_update submissions';
  }

  const draft = request.listingDraft;
  if (!draft || typeof draft !== 'object') {
    return 'listingDraft is required';
  }

  if (typeof draft.name !== 'string' || draft.name.trim().length === 0) {
    return 'listingDraft.name is required';
  }

  if (typeof draft.summary !== 'string' || draft.summary.trim().length === 0) {
    return 'listingDraft.summary is required';
  }

  if (!stringArrayOrUndefined(draft.categories) || !stringArrayOrUndefined(draft.tags)) {
    return 'listingDraft.categories and listingDraft.tags must be string arrays when provided';
  }

  return null;
}

export function isSubmissionRecord(item: unknown): item is SubmissionRecord {
  const record = item as Partial<SubmissionRecord> | undefined;

  return Boolean(
    record
      && typeof record.submissionId === 'string'
      && typeof record.kitId === 'string'
      && optionalString(record.version)
      && typeof record.publisherId === 'string'
      && optionalString(record.submittedByUserId)
      && optionalString(record.submittedByEmail)
      && publisherSnapshotOrUndefined(record.publisherSnapshot)
      && typeof record.packageS3Key === 'string'
      && optionalString(record.fileName)
      && optionalString(record.packageFileName)
      && optionalNumber(record.packageSizeBytes)
      && optionalString(record.sha256)
      && optionalString(record.contentType)
      && optionalString(record.schemaVersion)
      && typeof record.status === 'string'
      && typeof record.validationStatus === 'string'
      && typeof record.reviewStatus === 'string'
      && optionalNullableString(record.reviewNotes)
      && optionalString(record.reviewedAt)
      && optionalString(record.publishedAt)
      && optionalString(record.archivedAt)
      && optionalString(record.canceledAt)
      && typeof record.createdAt === 'string'
      && typeof record.updatedAt === 'string'
      && record.listingDraft
      && typeof record.listingDraft.name === 'string'
      && typeof record.listingDraft.summary === 'string',
  );
}

export function isPublicKit(kit: KitRecord): boolean {
  return kit.status === PUBLIC_STATUS
    && kit.validationStatus === PUBLIC_VALIDATION_STATUS
    && kit.reviewStatus === PUBLIC_REVIEW_STATUS;
}

export function isKitRecord(item: unknown): item is KitRecord {
  const record = item as Partial<KitRecord> | undefined;

  return Boolean(
    record
      && typeof record.kitId === 'string'
      && typeof record.slug === 'string'
      && typeof record.name === 'string'
      && typeof record.summary === 'string'
      && typeof record.publisherId === 'string'
      && optionalString(record.ownerUserId)
      && optionalString(record.removedAt)
      && typeof record.status === 'string'
      && typeof record.validationStatus === 'string'
      && typeof record.reviewStatus === 'string',
  );
}

export function isPublisherRecord(item: unknown): item is PublisherRecord {
  const record = item as Partial<PublisherRecord> | undefined;

  return Boolean(
    record
      && typeof record.publisherId === 'string'
      && typeof record.displayName === 'string',
  );
}

export function publisherSnapshotOrUndefined(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }

  const record = value as Partial<PublisherSnapshot> | undefined;
  return Boolean(
    record
      && typeof record === 'object'
      && optionalNullableString(record.displayName)
      && optionalNullableString(record.handle)
      && optionalNullableString(record.avatarInitials)
      && (record.verified === undefined || typeof record.verified === 'boolean'),
  );
}

export function isKitVersionRecord(item: unknown): item is KitVersionRecord {
  const record = item as Partial<KitVersionRecord> | undefined;

  return Boolean(
    record
      && typeof record.kitId === 'string'
      && typeof record.version === 'string',
  );
}

export function optionalReviewNotes(value: unknown): string | null | Error {
  if (value === undefined) {
    return null;
  }

  const record = value as { reviewNotes?: unknown } | undefined;
  if (!record || typeof record !== 'object' || record.reviewNotes === undefined || record.reviewNotes === null) {
    return null;
  }

  if (typeof record.reviewNotes !== 'string') {
    return new Error('reviewNotes must be a string when provided');
  }

  const notes = record.reviewNotes.trim();
  return notes.length > 0 ? notes : null;
}

export function requiredReviewNotes(value: unknown): string | Error {
  const notes = optionalReviewNotes(value);
  if (notes instanceof Error) {
    return notes;
  }

  return notes ?? new Error('reviewNotes is required');
}

export function requiredActorUserId(value: unknown): string | Error {
  const record = value as { userId?: unknown; submittedByUserId?: unknown } | undefined;
  const userId = typeof record?.userId === 'string'
    ? record.userId
    : (typeof record?.submittedByUserId === 'string' ? record.submittedByUserId : undefined);

  if (!userId || userId.trim().length === 0) {
    return new Error('userId is required');
  }

  return userId.trim();
}

export function safePublisherSnapshot(value: unknown): PublisherSnapshot | undefined {
  if (!publisherSnapshotOrUndefined(value) || value === undefined) {
    return undefined;
  }

  const record = value as PublisherSnapshot;
  return {
    displayName: safeNullableProfileText(record.displayName),
    handle: safeNullableProfileText(record.handle),
    avatarInitials: safeAvatarInitials(record.avatarInitials),
    verified: record.verified === true,
  };
}

export function toKitPublisherSnapshot(publisherId: string, value: unknown): PublicPublisherSnapshot {
  const snapshot = safePublisherSnapshot(value);

  return {
    publisherId,
    displayName: snapshot?.displayName ?? null,
    handle: snapshot?.handle ?? null,
    avatarInitials: snapshot?.avatarInitials ?? 'AK',
    verified: snapshot?.verified ?? false,
  };
}

export function safePublicPublisher(
  value: unknown,
  publisherId: string,
  _legacyPublisher: PublisherRecord | undefined,
): PublicPublisherSnapshot {
  const record = value as Partial<PublicPublisherSnapshot> | undefined;
  if (record && typeof record === 'object') {
    return {
      publisherId: typeof record.publisherId === 'string' && record.publisherId.trim().length > 0
        ? record.publisherId
        : publisherId,
      displayName: safeNullableProfileText(record.displayName),
      handle: safeNullableProfileText(record.handle),
      avatarInitials: safeAvatarInitials(record.avatarInitials) ?? 'AK',
      verified: record.verified === true,
    };
  }

  return {
    publisherId,
    displayName: null,
    handle: null,
    avatarInitials: 'AK',
    verified: false,
  };
}

export function safeNullableProfileText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function safeAvatarInitials(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  return trimmed.length > 0 ? trimmed : null;
}

export function stringArrayOrUndefined(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === 'string'));
}

export function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

export function optionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === 'number';
}

export function optionalNullableString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string';
}

export function isReasonableEmail(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}

/**
 * Parses a sequential kit version. Versions are positive integers on the wire
 * (sent as strings, e.g. "1", "2"). Returns the integer, or null when the value
 * is not a valid positive integer.
 */
export function parseKitVersion(value: string | undefined | null): number | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return null;
  }
  return parsed;
}

/**
 * Resolves the kit's stored current version to an integer for comparison.
 * - A missing/empty current version yields 0 (so the next version may be 1).
 * - A valid positive integer is used as-is.
 * - Any non-positive-integer value (e.g. a LEGACY semver string like "0.1.0"
 *   from before the sequential-integer change) is treated as 1, so the next
 *   version must be >= 2.
 */
export function resolveCurrentVersionInt(current: string | undefined | null): number {
  if (current === undefined || current === null || current.trim() === '') {
    return 0;
  }
  const parsed = parseKitVersion(current);
  return parsed ?? 1;
}

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return slug || 'agentkit';
}

export function slugifyForUrl(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug || 'agentkit';
}

export function sanitizeOriginalFileName(value: string): string {
  const name = value
    .split(/[\\/]/)
    .pop()
    ?.trim()
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-');

  return name && name.endsWith('.agentkit.zip') ? name : 'package.agentkit.zip';
}

export function safeDownloadFileName(slug: string, version: string): string {
  const safeSlug = slugifyForUrl(slug);
  const safeVersion = version
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '') || '0.0.0';

  return `agentkit-${safeSlug}-${safeVersion}.agentkit.zip`;
}

export function safeInputs(value: unknown): SafeInput[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    const record = item as Partial<SafeInput> | undefined;
    if (!record || typeof record.name !== 'string') {
      return [];
    }

    return [{
      name: record.name,
      label: typeof record.label === 'string' ? record.label : undefined,
      type: typeof record.type === 'string' ? record.type : undefined,
      description: typeof record.description === 'string' ? record.description : undefined,
    }];
  });
}

export function safePreparedPrompts(value: unknown): SafePreparedPrompt[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    const record = item as Partial<SafePreparedPrompt> | undefined;
    if (!record || typeof record.name !== 'string') {
      return [];
    }

    return [{
      name: record.name,
      title: typeof record.title === 'string' ? record.title : undefined,
      summary: typeof record.summary === 'string' ? record.summary : undefined,
    }];
  });
}

export function safeSkills(value: unknown): SafeSkill[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    const record = item as Partial<SafeSkill> | undefined;
    if (!record || typeof record.name !== 'string') {
      return [];
    }

    return [{
      name: record.name,
      title: typeof record.title === 'string' ? record.title : undefined,
      summary: typeof record.summary === 'string' ? record.summary : undefined,
    }];
  });
}

export function safeValidationSummary(value: unknown): SafeValidationSummary | null {
  const record = value as Partial<SafeValidationSummary> | undefined;

  if (!record || typeof record !== 'object') {
    return null;
  }

  return {
    status: typeof record.status === 'string' ? record.status : undefined,
    summary: typeof record.summary === 'string' ? record.summary : undefined,
    checkedAt: typeof record.checkedAt === 'string' ? record.checkedAt : undefined,
    errors: Array.isArray(record.errors)
      ? record.errors.filter((item): item is string => typeof item === 'string').slice(0, 20)
      : undefined,
  };
}

export function stringArray(value: unknown, fallback: string[] = []): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : fallback;
}

export function defaultBadges(kit: KitRecord): string[] {
  return isPublicKit(kit) ? ['Validated', 'Reviewed'] : [];
}

export function safeUrl(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  return value.startsWith('https://') ? value : null;
}

export function parseLimit(value: string | undefined): number {
  if (!value) {
    return DEFAULT_LIMIT;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_LIMIT;
  }

  return Math.min(parsed, MAX_LIMIT);
}

export function optionalTrimmedQueryValue(value: string | undefined, name: string): string | undefined | Error {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : new Error(`${name} must not be empty`);
}

export function parseOptionalBoolean(value: string | undefined, name: string): boolean | undefined | Error {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (['true', '1'].includes(normalized)) {
    return true;
  }

  if (['false', '0'].includes(normalized)) {
    return false;
  }

  return new Error(`${name} must be true or false`);
}

export function isHiddenFromDefaultReviewQueue(submission: SubmissionRecord, nowMs: number): boolean {
  if ([ARCHIVED_STATUS, CANCELED_STATUS].includes(submission.status)) {
    return true;
  }

  // Stale, never-finished awaiting_upload submissions are treated as expired and
  // hidden from the default review queue (lazy expiry mirrors the DynamoDB TTL).
  if (isExpiredAwaitingUpload(submission, nowMs)) {
    return true;
  }

  if (!['approved', 'rejected'].includes(submission.reviewStatus) || !submission.reviewedAt) {
    return false;
  }

  const reviewedAtMs = Date.parse(submission.reviewedAt);
  return Number.isFinite(reviewedAtMs) && nowMs - reviewedAtMs > REVIEW_QUEUE_RETENTION_MS;
}

export function isActiveSubmissionForDuplicateCheck(submission: SubmissionRecord): boolean {
  if (submission.status === ARCHIVED_STATUS
    || submission.status === CANCELED_STATUS
    || submission.status === 'rejected'
    || submission.reviewStatus === 'rejected') {
    return false;
  }

  // Never-finished awaiting_upload submissions must not count as active, so a
  // retry of the same user/kit/version is always allowed. A submission only
  // leaves awaiting_upload once a package upload is observed (validation advances
  // it to validation_queued/passed/etc.), so a row still in awaiting_upload means
  // the upload never completed and must not block a re-submit.
  if (submission.status === 'awaiting_upload') {
    return false;
  }

  return true;
}

export function isExpiredAwaitingUpload(submission: SubmissionRecord, nowMs: number): boolean {
  if (submission.status !== 'awaiting_upload') {
    return false;
  }

  if (typeof submission.expiresAt === 'number' && Number.isFinite(submission.expiresAt)) {
    return nowMs >= submission.expiresAt * 1000;
  }

  const createdMs = Date.parse(submission.createdAt);
  return !Number.isFinite(createdMs) || nowMs - createdMs > AWAITING_UPLOAD_TTL_MS;
}

export function sortPublicKits(kits: KitRecord[]): KitRecord[] {
  return [...kits].sort((left, right) => {
    const leftFeaturedRank = typeof left.featuredRank === 'number' ? left.featuredRank : Number.POSITIVE_INFINITY;
    const rightFeaturedRank = typeof right.featuredRank === 'number' ? right.featuredRank : Number.POSITIVE_INFINITY;
    if (leftFeaturedRank !== rightFeaturedRank) {
      return leftFeaturedRank - rightFeaturedRank;
    }

    if ((left.featured === true) !== (right.featured === true)) {
      return left.featured === true ? -1 : 1;
    }

    return (right.publishedAt ?? right.updatedAt ?? '').localeCompare(left.publishedAt ?? left.updatedAt ?? '');
  });
}

export function searchableKitText(kit: KitRecord, publisher: PublisherRecord | undefined): string {
  const safePublisher = safePublicPublisher(kit.publisher, kit.publisherId, publisher);
  return [
    kit.name,
    kit.summary,
    kit.description,
    ...stringArray(kit.categories),
    ...stringArray(kit.tags),
    safePublisher.displayName,
    safePublisher.handle,
  ]
    .filter((value): value is string => typeof value === 'string')
    .map(normalizeFilterValue)
    .join(' ');
}

export function normalizedStringArray(value: unknown): string[] {
  return stringArray(value).map(normalizeFilterValue);
}

export function normalizeFilterValue(value: string): string {
  return value.trim().toLowerCase();
}

export function encodePageToken(key: Record<string, unknown> | undefined): string | null {
  if (!key) {
    return null;
  }

  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

export function encodeOffsetCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}

export function decodeOffsetCursor(cursor: string | undefined): number | Error {
  if (!cursor) {
    return 0;
  }

  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { offset?: unknown };
    if (typeof parsed.offset === 'number' && Number.isInteger(parsed.offset) && parsed.offset >= 0) {
      return parsed.offset;
    }
  } catch {
    return new Error('cursor is invalid');
  }

  return new Error('cursor is invalid');
}

export function decodePageToken(token: string | undefined): Record<string, unknown> | undefined {
  if (!token) {
    return undefined;
  }

  try {
    return JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
