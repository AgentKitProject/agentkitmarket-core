/**
 * Postgres adapters for the market core ports (self-host deployment).
 *
 * Implements CatalogRepository + AdminRepository over a `pg` Pool, mirroring the
 * AWS/DynamoDB adapter behavior EXACTLY: same results, same ordering (kit
 * versions reverse-chronological by version key), same TTL / lazy-expiry,
 * duplicate-submission, sha256-dedup and review-queue retention semantics.
 *
 * Two intentional improvements over the AWS adapter, both behaviorally
 * transparent:
 *   - `publishSubmission` runs inside a single BEGIN/COMMIT transaction (the AWS
 *     version is a non-atomic Promise.all of three writes).
 *   - Catalog pagination uses a stable ordered offset cursor instead of
 *     DynamoDB's opaque LastEvaluatedKey, so paging is deterministic.
 *
 * Cloud-free: imports only `pg` types and the domain services/types.
 */

import { randomUUID } from 'node:crypto';
import type {
  AdminRepository,
  CatalogRepository,
  EntitlementRepository,
  FavoritesRepository,
  KitPricingUpdate,
  OrgRepository,
  SubmissionValidationUpdate,
  ValidationJobUpdate,
} from '../../core/ports.js';
import type {
  AddFavoriteInput,
  CatalogDetail,
  CatalogPage,
  CreateSubmissionInput,
  CreateSubmissionResult,
  Entitlement,
  Favorite,
  GrantEntitlementInput,
  KitRecord,
  KitVersionRecord,
  KitVisibility,
  Organization,
  OrgInvite,
  OrgMembership,
  OrgRole,
  PublisherRecord,
  SubmissionRecord,
  ValidationJobRecord,
} from '../../core/types.js';
import { dedupeSlug, personalOrgSlugBase } from '../../core/services/orgs.js';
import {
  PUBLIC_REVIEW_STATUS,
  PUBLIC_STATUS,
  PUBLIC_VALIDATION_STATUS,
  ARCHIVED_STATUS,
  CANCELED_STATUS,
  REMOVED_STATUS,
} from '../../core/services/constants.js';
import {
  buildSubmissionRecord,
  isActiveSubmissionForDuplicateCheck,
  safeDownloadFileName,
  safeValidationSummary,
  slugifyForUrl,
  toKitPublisherSnapshot,
  toPublicVersion,
} from '../../core/services/index.js';

/**
 * Minimal structural type for a `pg` Pool / Client. Declared locally so the
 * package does not need `pg` at type-check time for consumers that only use the
 * AWS adapter, and so `pg-mem`'s `createPg()` Pool satisfies it directly.
 */
export interface PgQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

export interface PgPool extends PgQueryable {
  connect(): Promise<PgPoolClient>;
}

export interface PgPoolClient extends PgQueryable {
  release(): void;
}

// --- row <-> record mapping -----------------------------------------------------

function num(value: unknown): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** pg returns jsonb already parsed; pg-mem may hand back a string. Normalize. */
function json(value: unknown): unknown {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return value ?? undefined;
}

function rowToKit(row: any): KitRecord {
  return {
    kitId: row.kit_id,
    slug: row.slug,
    name: row.name,
    summary: row.summary,
    publisherId: row.publisher_id,
    ownerUserId: str(row.owner_user_id),
    ownerOrgId: str(row.owner_org_id),
    visibility: str(row.visibility) as KitRecord['visibility'],
    pricing: str(row.pricing) as KitRecord['pricing'],
    priceModel: str(row.price_model) as KitRecord['priceModel'],
    priceCents: num(row.price_cents),
    currency: str(row.currency),
    interval: str(row.interval) as KitRecord['interval'],
    downloadable: row.downloadable === null || row.downloadable === undefined ? undefined : row.downloadable,
    licenseType: str(row.license_type) as KitRecord['licenseType'],
    licenseText: str(row.license_text),
    licenseVersion: str(row.license_version),
    publisher: json(row.publisher),
    status: row.status,
    validationStatus: row.validation_status,
    reviewStatus: row.review_status,
    categories: json(row.categories),
    tags: json(row.tags),
    currentVersion: str(row.current_version),
    verificationStatus: str(row.verification_status),
    badges: json(row.badges),
    requiredInputs: json(row.required_inputs),
    preparedPrompts: json(row.prepared_prompts),
    skills: json(row.skills),
    description: str(row.description),
    validationSummary: json(row.validation_summary),
    importUrl: str(row.import_url),
    downloadUrl: str(row.download_url),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
    publishedAt: str(row.published_at),
    removedAt: str(row.removed_at),
    downloads: num(row.downloads),
    featured: row.featured === null ? undefined : row.featured,
    featuredRank: row.featured_rank === null || row.featured_rank === undefined ? null : num(row.featured_rank) ?? null,
    latestVersion: json(row.latest_version),
  };
}

function rowToPublisher(row: any): PublisherRecord {
  return {
    publisherId: row.publisher_id,
    displayName: row.display_name,
    handle: str(row.handle),
    avatarInitials: str(row.avatar_initials),
    verified: row.verified === null ? undefined : row.verified,
  };
}

function rowToKitVersion(row: any): KitVersionRecord {
  return {
    kitId: row.kit_id,
    version: row.version,
    fileName: row.file_name ?? null,
    packageFileName: row.package_file_name ?? null,
    packageSizeBytes: row.package_size_bytes === null || row.package_size_bytes === undefined
      ? null
      : num(row.package_size_bytes) ?? null,
    summary: str(row.summary),
    schemaVersion: str(row.schema_version),
    publishedAt: str(row.published_at),
    packageS3Key: str(row.package_s3_key),
    sha256: str(row.sha256),
    contentType: str(row.content_type),
    validationSummary: json(row.validation_summary),
    validationResult: json(row.validation_result),
    releaseNotes: str(row.release_notes),
  };
}

function rowToSubmission(row: any): SubmissionRecord {
  return {
    submissionId: row.submission_id,
    kitId: row.kit_id,
    version: str(row.version),
    publisherId: row.publisher_id,
    submittedByUserId: str(row.submitted_by_user_id),
    submittedByEmail: str(row.submitted_by_email),
    publisherSnapshot: json(row.publisher_snapshot) as SubmissionRecord['publisherSnapshot'],
    packageS3Key: row.package_s3_key,
    fileName: str(row.file_name),
    packageFileName: str(row.package_file_name),
    packageSizeBytes: num(row.package_size_bytes),
    sha256: str(row.sha256),
    contentType: str(row.content_type),
    schemaVersion: str(row.schema_version),
    status: row.status,
    validationStatus: row.validation_status,
    reviewStatus: row.review_status,
    submissionType: str(row.submission_type),
    targetKitId: str(row.target_kit_id),
    ownerOrgId: str(row.owner_org_id),
    // SQL NULL -> undefined, mirroring DynamoDB removeUndefinedValues (an
    // unset reviewNotes reads back as absent, not null).
    reviewNotes: row.review_notes === null || row.review_notes === undefined ? undefined : row.review_notes,
    listingDraft: json(row.listing_draft) as SubmissionRecord['listingDraft'],
    validationSummary: json(row.validation_summary) as SubmissionRecord['validationSummary'],
    expiresAt: num(row.expires_at),
    reviewedAt: str(row.reviewed_at),
    publishedAt: str(row.published_at),
    archivedAt: str(row.archived_at),
    canceledAt: str(row.canceled_at),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToOrganization(row: any): Organization {
  return {
    orgId: row.org_id,
    slug: row.slug,
    displayName: row.display_name,
    type: row.type,
    ownerUserId: row.owner_user_id,
    handle: str(row.handle),
    avatarInitials: str(row.avatar_initials),
    verified: row.verified === null || row.verified === undefined ? undefined : row.verified,
    workosOrganizationId: row.workos_organization_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToMembership(row: any): OrgMembership {
  return {
    orgId: row.org_id,
    userId: row.user_id,
    role: row.role,
    status: row.status,
    invitedByUserId: str(row.invited_by_user_id),
    createdAt: row.created_at,
  };
}

function rowToInvite(row: any): OrgInvite {
  return {
    orgId: row.org_id,
    userId: str(row.user_id),
    email: str(row.email),
    role: row.role,
    invitedByUserId: row.invited_by_user_id,
    createdAt: row.created_at,
  };
}

function rowToEntitlement(row: any): Entitlement {
  return {
    entitlementId: row.entitlement_id,
    kitId: row.kit_id,
    userId: row.user_id,
    status: row.status,
    source: row.source,
    licenseVersion: row.license_version,
    licenseAcceptedAt: row.license_accepted_at,
    licenseTextSnapshot: row.license_text_snapshot,
    grantedAt: row.granted_at,
    expiresAt: str(row.expires_at),
    stripeSubscriptionId: row.stripe_subscription_id ?? null,
  };
}

function rowToFavorite(row: any): Favorite {
  return {
    userId: row.user_id,
    kitId: row.kit_id,
    slug: row.slug,
    addedAt: row.added_at,
    displayName: str(row.display_name),
    summary: str(row.summary),
    publisherName: str(row.publisher_name),
  };
}

function rowToValidationJob(row: any): ValidationJobRecord {
  return {
    jobId: row.job_id,
    submissionId: row.submission_id,
    kitId: row.kit_id,
    packageS3Key: row.package_s3_key,
    status: row.status,
    result: json(row.result) as ValidationJobRecord['result'],
    startedAt: str(row.started_at),
    completedAt: str(row.completed_at),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** jsonb values must be passed to pg as JSON text (and read back via json()). */
function jb(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

async function getPublishers(
  pool: PgQueryable,
  publisherIds: string[],
): Promise<Map<string, PublisherRecord>> {
  const unique = [...new Set(publisherIds)].filter(Boolean);
  const publishers = new Map<string, PublisherRecord>();
  if (unique.length === 0) {
    return publishers;
  }

  const result = await pool.query(
    `SELECT publisher_id, display_name, handle, avatar_initials, verified
       FROM publishers WHERE publisher_id = ANY($1)`,
    [unique],
  );
  for (const row of result.rows) {
    publishers.set(row.publisher_id, rowToPublisher(row));
  }
  return publishers;
}

// --- catalog (read side) --------------------------------------------------------

export function createPostgresCatalogRepository(pool: PgPool): CatalogRepository {
  return {
    async listKits(limit: number, nextToken: string | undefined): Promise<CatalogPage> {
      const offset = decodeOffset(nextToken);
      // Stable ordering so the offset cursor is deterministic across pages.
      const result = await pool.query(
        `SELECT * FROM kits
           WHERE status = $1 AND validation_status = $2 AND review_status = $3
             AND (visibility IS NULL OR visibility <> 'private')
           ORDER BY kit_id
           LIMIT $4 OFFSET $5`,
        [PUBLIC_STATUS, PUBLIC_VALIDATION_STATUS, PUBLIC_REVIEW_STATUS, limit, offset],
      );

      const kits = result.rows.map(rowToKit);
      const publishers = await getPublishers(pool, kits.map((kit) => kit.publisherId));
      const nextOffset = offset + kits.length;
      // A full page implies there may be more rows; emit a cursor for the next page.
      const hasMore = kits.length === limit;

      return {
        kits,
        publishers,
        nextToken: hasMore ? encodeOffset(nextOffset) : null,
      };
    },

    async getKitBySlug(slug: string): Promise<CatalogDetail> {
      const kitResult = await pool.query(
        `SELECT * FROM kits WHERE slug = $1 LIMIT 1`,
        [slug],
      );
      const kitRow = kitResult.rows[0];
      const kit = kitRow ? rowToKit(kitRow) : undefined;

      if (!kit || kit.status !== PUBLIC_STATUS
        || kit.validationStatus !== PUBLIC_VALIDATION_STATUS
        || kit.reviewStatus !== PUBLIC_REVIEW_STATUS
        || kit.visibility === 'private') {
        return { kit: undefined, publisher: undefined, versions: [] };
      }

      const [publishers, versionsResult] = await Promise.all([
        getPublishers(pool, [kit.publisherId]),
        // Reverse-chronological by version, mirroring ScanIndexForward: false.
        pool.query(
          `SELECT kit_id, version, summary, schema_version, package_size_bytes, sha256, published_at
             FROM kit_versions WHERE kit_id = $1 ORDER BY version DESC`,
          [kit.kitId],
        ),
      ]);

      return {
        kit,
        publisher: publishers.get(kit.publisherId),
        versions: versionsResult.rows.map(rowToKitVersion),
      };
    },
  };
}

// --- admin (write side) ---------------------------------------------------------

export function createPostgresAdminRepository(pool: PgPool): AdminRepository {
  return {
    async createSubmission(input: CreateSubmissionInput): Promise<CreateSubmissionResult> {
      const submission = buildSubmissionRecord(input);
      await insertSubmission(pool, submission);
      return { submission, version: input.version };
    },

    async findActiveDuplicateSubmission(
      input: CreateSubmissionInput,
    ): Promise<SubmissionRecord | undefined> {
      if (!input.submittedByUserId) {
        return undefined;
      }

      const result = await pool.query(
        `SELECT * FROM submissions
           WHERE submitted_by_user_id = $1 AND version = $2
           LIMIT 50`,
        [input.submittedByUserId, input.version],
      );

      const requestedSlug = slugifyForUrl(input.listingDraft.name);
      return result.rows
        .map(rowToSubmission)
        .find((submission) => isActiveSubmissionForDuplicateCheck(submission)
          && slugifyForUrl(submission.listingDraft.name) === requestedSlug);
    },

    async getSubmission(submissionId: string): Promise<SubmissionRecord | undefined> {
      const result = await pool.query(
        `SELECT * FROM submissions WHERE submission_id = $1`,
        [submissionId],
      );
      const row = result.rows[0];
      return row ? rowToSubmission(row) : undefined;
    },

    async listSubmissions(): Promise<SubmissionRecord[]> {
      const result = await pool.query(`SELECT * FROM submissions LIMIT 100`);
      return result.rows.map(rowToSubmission);
    },

    async createValidationJob(submission: SubmissionRecord): Promise<ValidationJobRecord> {
      const now = new Date().toISOString();
      const job: ValidationJobRecord = {
        jobId: `validation_${randomUUID()}`,
        submissionId: submission.submissionId,
        kitId: submission.kitId,
        packageS3Key: submission.packageS3Key,
        status: 'queued',
        createdAt: now,
        updatedAt: now,
      };

      await pool.query(
        `INSERT INTO validation_jobs
           (job_id, submission_id, kit_id, package_s3_key, status, result, started_at, completed_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          job.jobId, job.submissionId, job.kitId, job.packageS3Key, job.status,
          jb(job.result), job.startedAt ?? null, job.completedAt ?? null, job.createdAt, job.updatedAt,
        ],
      );

      return job;
    },

    async markSubmissionValidationQueued(submissionId: string, validationJobId: string): Promise<void> {
      // Clear the awaiting_upload TTL (expires_at = NULL): the package is uploaded
      // and queued, so the row must be retained rather than auto-expired.
      await pool.query(
        `UPDATE submissions
           SET validation_status = $2, status = $3, validation_job_id = $4,
               updated_at = $5, expires_at = NULL
           WHERE submission_id = $1`,
        [submissionId, 'queued', 'validation_queued', validationJobId, new Date().toISOString()],
      );
    },

    async approveSubmission(
      submissionId: string,
      reviewNotes: string | null,
      reviewedAt: string,
    ): Promise<SubmissionRecord | undefined> {
      const result = await pool.query(
        `UPDATE submissions
           SET review_status = 'approved', review_notes = $2, reviewed_at = $3, updated_at = $3
           WHERE submission_id = $1
           RETURNING *`,
        [submissionId, reviewNotes, reviewedAt],
      );
      const row = result.rows[0];
      return row ? rowToSubmission(row) : undefined;
    },

    async rejectSubmission(
      submissionId: string,
      reviewNotes: string,
      reviewedAt: string,
    ): Promise<SubmissionRecord | undefined> {
      const result = await pool.query(
        `UPDATE submissions
           SET review_status = 'rejected', status = 'rejected', review_notes = $2,
               reviewed_at = $3, updated_at = $3
           WHERE submission_id = $1
           RETURNING *`,
        [submissionId, reviewNotes, reviewedAt],
      );
      const row = result.rows[0];
      return row ? rowToSubmission(row) : undefined;
    },

    async archiveSubmission(submissionId: string, archivedAt: string): Promise<SubmissionRecord | undefined> {
      // Mirrors the Dynamo ConditionExpression: only when the row exists and is
      // not already published; otherwise return undefined (no row updated).
      const result = await pool.query(
        `UPDATE submissions
           SET status = $2, archived_at = $3, updated_at = $3
           WHERE submission_id = $1 AND status <> $4
           RETURNING *`,
        [submissionId, ARCHIVED_STATUS, archivedAt, PUBLIC_STATUS],
      );
      const row = result.rows[0];
      return row ? rowToSubmission(row) : undefined;
    },

    async cancelSubmission(submissionId: string, canceledAt: string): Promise<SubmissionRecord | undefined> {
      const result = await pool.query(
        `UPDATE submissions
           SET status = $2, canceled_at = $3, updated_at = $3
           WHERE submission_id = $1 AND status <> $4
           RETURNING *`,
        [submissionId, CANCELED_STATUS, canceledAt, PUBLIC_STATUS],
      );
      const row = result.rows[0];
      return row ? rowToSubmission(row) : undefined;
    },

    async publishSubmission(submission: SubmissionRecord, publishedAt: string): Promise<KitRecord> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const existingResult = await client.query(
          `SELECT * FROM kits WHERE kit_id = $1`,
          [submission.kitId],
        );
        const existingKit = existingResult.rows[0] ? rowToKit(existingResult.rows[0]) : undefined;

        const version = submission.version ?? '0.0.0';
        const packageFileName = safeDownloadFileName(slugifyForUrl(submission.listingDraft.name), version);
        const validationSummary = safeValidationSummary(submission.validationSummary) ?? undefined;

        const kit: KitRecord = {
          kitId: submission.kitId,
          slug: slugifyForUrl(submission.listingDraft.name),
          name: submission.listingDraft.name,
          summary: submission.listingDraft.summary,
          description: submission.listingDraft.description,
          publisherId: submission.publisherId,
          ownerUserId: existingKit?.ownerUserId ?? submission.submittedByUserId,
          // Org ownership is set on first publish from the submission and never
          // reassigned by a version_update (transfer is the explicit path).
          ownerOrgId: existingKit?.ownerOrgId ?? submission.ownerOrgId,
          // Visibility is preserved across re-publishes; defaults to public on first publish.
          visibility: existingKit?.visibility ?? 'public',
          // Tier-2 pricing/license is preserved across re-publishes (set via the
          // pricing route, not at publish time).
          pricing: existingKit?.pricing,
          priceModel: existingKit?.priceModel,
          priceCents: existingKit?.priceCents,
          currency: existingKit?.currency,
          interval: existingKit?.interval,
          downloadable: existingKit?.downloadable,
          licenseType: existingKit?.licenseType,
          licenseText: existingKit?.licenseText,
          licenseVersion: existingKit?.licenseVersion,
          publisher: toKitPublisherSnapshot(submission.publisherId, submission.publisherSnapshot),
          status: PUBLIC_STATUS,
          validationStatus: PUBLIC_VALIDATION_STATUS,
          reviewStatus: PUBLIC_REVIEW_STATUS,
          categories: submission.listingDraft.categories ?? [],
          tags: submission.listingDraft.tags ?? [],
          currentVersion: version,
          latestVersion: toPublicVersion({
            kitId: submission.kitId,
            version,
            summary: submission.listingDraft.summary,
            packageSizeBytes: typeof submission.packageSizeBytes === 'number' ? submission.packageSizeBytes : null,
            sha256: submission.sha256,
            schemaVersion: submission.schemaVersion,
            publishedAt,
          }),
          verificationStatus: 'reviewed',
          badges: ['Validated', 'Reviewed'],
          validationSummary,
          createdAt: existingKit?.createdAt ?? publishedAt,
          updatedAt: publishedAt,
          publishedAt: existingKit?.publishedAt ?? publishedAt,
          downloads: typeof existingKit?.downloads === 'number' ? existingKit.downloads : 0,
        };

        const kitVersion: KitVersionRecord = {
          kitId: submission.kitId,
          version,
          fileName: submission.fileName ?? null,
          packageFileName,
          packageSizeBytes: typeof submission.packageSizeBytes === 'number' ? submission.packageSizeBytes : null,
          packageS3Key: submission.packageS3Key,
          sha256: submission.sha256,
          contentType: submission.contentType ?? 'application/zip',
          schemaVersion: submission.schemaVersion,
          summary: submission.listingDraft.summary,
          validationSummary,
          validationResult: validationSummary,
          publishedAt,
        };

        await upsertKit(client, kit);
        await upsertKitVersion(client, kitVersion);
        await client.query(
          `UPDATE submissions
             SET status = $2, published_at = $3, updated_at = $3
             WHERE submission_id = $1`,
          [submission.submissionId, PUBLIC_STATUS, publishedAt],
        );

        await client.query('COMMIT');
        return kit;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async hideKit(kitId: string): Promise<KitRecord | undefined> {
      const existing = await getKitRow(pool, kitId);
      if (!existing) {
        return undefined;
      }

      const result = await pool.query(
        `UPDATE kits SET status = 'hidden', updated_at = $2 WHERE kit_id = $1 RETURNING *`,
        [kitId, new Date().toISOString()],
      );
      const row = result.rows[0];
      return row ? rowToKit(row) : undefined;
    },

    async unhideKit(kitId: string): Promise<KitRecord | undefined> {
      const existing = await getKitRow(pool, kitId);
      if (!existing) {
        return undefined;
      }

      const kit = rowToKit(existing);
      if (kit.status !== 'hidden'
        || kit.validationStatus !== PUBLIC_VALIDATION_STATUS
        || kit.reviewStatus !== PUBLIC_REVIEW_STATUS) {
        return undefined;
      }

      const result = await pool.query(
        `UPDATE kits SET status = $2, updated_at = $3 WHERE kit_id = $1 RETURNING *`,
        [kitId, PUBLIC_STATUS, new Date().toISOString()],
      );
      const row = result.rows[0];
      return row ? rowToKit(row) : undefined;
    },

    async removeKit(kitId: string, removedAt: string): Promise<KitRecord | undefined> {
      const existing = await getKitRow(pool, kitId);
      if (!existing) {
        return undefined;
      }

      const result = await pool.query(
        `UPDATE kits SET status = $2, removed_at = $3, updated_at = $3 WHERE kit_id = $1 RETURNING *`,
        [kitId, REMOVED_STATUS, removedAt],
      );
      const row = result.rows[0];
      return row ? rowToKit(row) : undefined;
    },

    async getKit(kitId: string): Promise<KitRecord | undefined> {
      const row = await getKitRow(pool, kitId);
      return row ? rowToKit(row) : undefined;
    },

    async getKitBySlug(slug: string): Promise<KitRecord | undefined> {
      const result = await pool.query(`SELECT * FROM kits WHERE slug = $1 LIMIT 1`, [slug]);
      const row = result.rows[0];
      return row ? rowToKit(row) : undefined;
    },

    async setKitPricing(kitId: string, pricing: KitPricingUpdate): Promise<KitRecord | undefined> {
      const existing = await getKitRow(pool, kitId);
      if (!existing) {
        return undefined;
      }
      const result = await pool.query(
        `UPDATE kits SET
           pricing = $2, price_model = $3, price_cents = $4, currency = $5, interval = $6,
           downloadable = $7, license_type = $8, license_text = $9, license_version = $10,
           updated_at = $11
         WHERE kit_id = $1 RETURNING *`,
        [
          kitId,
          pricing.pricing,
          pricing.priceModel ?? null,
          pricing.priceCents ?? null,
          pricing.currency,
          pricing.interval ?? null,
          pricing.downloadable,
          pricing.licenseType,
          pricing.licenseText ?? null,
          pricing.licenseVersion,
          new Date().toISOString(),
        ],
      );
      const row = result.rows[0];
      return row ? rowToKit(row) : undefined;
    },

    async getKitVersion(kitId: string, version: string): Promise<KitVersionRecord | undefined> {
      const result = await pool.query(
        `SELECT * FROM kit_versions WHERE kit_id = $1 AND version = $2`,
        [kitId, version],
      );
      const row = result.rows[0];
      return row ? rowToKitVersion(row) : undefined;
    },

    async listKitVersions(kitId: string): Promise<KitVersionRecord[]> {
      // Mirrors the default Dynamo Query (no ScanIndexForward override): ascending
      // by the version sort key.
      const result = await pool.query(
        `SELECT * FROM kit_versions WHERE kit_id = $1 ORDER BY version ASC`,
        [kitId],
      );
      return result.rows.map(rowToKitVersion);
    },

    async findKitVersionBySha256(sha256: string): Promise<KitVersionRecord | undefined> {
      const result = await pool.query(
        `SELECT * FROM kit_versions WHERE sha256 = $1 LIMIT 1`,
        [sha256],
      );
      const row = result.rows[0];
      return row ? rowToKitVersion(row) : undefined;
    },

    async incrementKitDownloads(kitId: string): Promise<void> {
      await pool.query(
        `UPDATE kits SET downloads = COALESCE(downloads, 0) + 1, updated_at = $2 WHERE kit_id = $1`,
        [kitId, new Date().toISOString()],
      );
    },

    async updateValidationJob(jobId: string, update: ValidationJobUpdate): Promise<void> {
      // Only set columns that are present, mirroring the AWS adapter (undefined
      // fields left unchanged). `result` maps to the jsonb `result` column.
      await dynamicUpdate(pool, 'validation_jobs', 'job_id', jobId, [
        ['status', update.status],
        ['result', update.result === undefined ? undefined : jb(update.result)],
        ['started_at', update.startedAt],
        ['completed_at', update.completedAt],
        ['updated_at', update.updatedAt],
      ]);
    },

    async updateSubmissionValidationResult(
      submissionId: string,
      update: SubmissionValidationUpdate,
    ): Promise<void> {
      await dynamicUpdate(pool, 'submissions', 'submission_id', submissionId, [
        ['status', update.status],
        ['validation_status', update.validationStatus],
        ['validation_summary', update.validationSummary === undefined ? undefined : jb(update.validationSummary)],
        ['package_size_bytes', update.packageSizeBytes],
        ['sha256', update.sha256],
        ['content_type', update.contentType],
        ['updated_at', update.updatedAt],
      ]);
    },
  };
}

/**
 * Builds and runs `UPDATE <table> SET col = $n, ... WHERE <keyColumn> = $1`,
 * skipping any column whose value is `undefined`. Mirrors the AWS validation
 * worker's dynamic update (undefined-valued fields are left unchanged).
 */
async function dynamicUpdate(
  pool: PgQueryable,
  table: string,
  keyColumn: string,
  keyValue: string,
  columns: Array<[string, unknown]>,
): Promise<void> {
  const present = columns.filter(([, value]) => value !== undefined);
  if (present.length === 0) {
    return;
  }

  const setClauses = present.map(([col], index) => `${col} = $${index + 2}`);
  const values = present.map(([, value]) => value);
  await pool.query(
    `UPDATE ${table} SET ${setClauses.join(', ')} WHERE ${keyColumn} = $1`,
    [keyValue, ...values],
  );
}

// --- write helpers --------------------------------------------------------------

async function getKitRow(pool: PgQueryable, kitId: string): Promise<any | undefined> {
  const result = await pool.query(`SELECT * FROM kits WHERE kit_id = $1`, [kitId]);
  return result.rows[0];
}

async function insertSubmission(pool: PgQueryable, s: SubmissionRecord): Promise<void> {
  await pool.query(
    `INSERT INTO submissions (
       submission_id, kit_id, version, publisher_id, submitted_by_user_id, submitted_by_email,
       package_s3_key, file_name, package_file_name, package_size_bytes, sha256, content_type,
       schema_version, status, validation_status, review_status, submission_type, target_kit_id,
       review_notes, validation_job_id, expires_at, reviewed_at, published_at, archived_at,
       canceled_at, created_at, updated_at, publisher_snapshot, listing_draft, validation_summary,
       owner_org_id
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31
     )`,
    [
      s.submissionId, s.kitId, s.version ?? null, s.publisherId, s.submittedByUserId ?? null,
      s.submittedByEmail ?? null, s.packageS3Key, s.fileName ?? null, s.packageFileName ?? null,
      s.packageSizeBytes ?? null, s.sha256 ?? null, s.contentType ?? null, s.schemaVersion ?? null,
      s.status, s.validationStatus, s.reviewStatus, s.submissionType ?? null, s.targetKitId ?? null,
      s.reviewNotes ?? null, null, s.expiresAt ?? null, s.reviewedAt ?? null, s.publishedAt ?? null,
      s.archivedAt ?? null, s.canceledAt ?? null, s.createdAt, s.updatedAt,
      jb(s.publisherSnapshot), jb(s.listingDraft), jb(s.validationSummary),
      s.ownerOrgId ?? null,
    ],
  );
}

async function upsertKit(pool: PgQueryable, k: KitRecord): Promise<void> {
  await pool.query(
    `INSERT INTO kits (
       kit_id, slug, name, summary, publisher_id, owner_user_id, status, validation_status,
       review_status, current_version, verification_status, description, import_url, download_url,
       created_at, updated_at, published_at, removed_at, downloads, featured, featured_rank,
       publisher, categories, tags, badges, required_inputs, prepared_prompts, skills,
       validation_summary, latest_version, owner_org_id, visibility,
       pricing, price_model, price_cents, currency, interval, downloadable,
       license_type, license_text, license_version
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,
       $33,$34,$35,$36,$37,$38,$39,$40,$41
     )
     ON CONFLICT (kit_id) DO UPDATE SET
       slug = EXCLUDED.slug, name = EXCLUDED.name, summary = EXCLUDED.summary,
       publisher_id = EXCLUDED.publisher_id, owner_user_id = EXCLUDED.owner_user_id,
       owner_org_id = EXCLUDED.owner_org_id, visibility = EXCLUDED.visibility,
       status = EXCLUDED.status, validation_status = EXCLUDED.validation_status,
       review_status = EXCLUDED.review_status, current_version = EXCLUDED.current_version,
       verification_status = EXCLUDED.verification_status, description = EXCLUDED.description,
       import_url = EXCLUDED.import_url, download_url = EXCLUDED.download_url,
       created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at,
       published_at = EXCLUDED.published_at, removed_at = EXCLUDED.removed_at,
       downloads = EXCLUDED.downloads, featured = EXCLUDED.featured,
       featured_rank = EXCLUDED.featured_rank, publisher = EXCLUDED.publisher,
       categories = EXCLUDED.categories, tags = EXCLUDED.tags, badges = EXCLUDED.badges,
       required_inputs = EXCLUDED.required_inputs, prepared_prompts = EXCLUDED.prepared_prompts,
       skills = EXCLUDED.skills, validation_summary = EXCLUDED.validation_summary,
       latest_version = EXCLUDED.latest_version,
       pricing = EXCLUDED.pricing, price_model = EXCLUDED.price_model,
       price_cents = EXCLUDED.price_cents, currency = EXCLUDED.currency,
       interval = EXCLUDED.interval, downloadable = EXCLUDED.downloadable,
       license_type = EXCLUDED.license_type, license_text = EXCLUDED.license_text,
       license_version = EXCLUDED.license_version`,
    [
      k.kitId, k.slug, k.name, k.summary, k.publisherId, k.ownerUserId ?? null, k.status,
      k.validationStatus, k.reviewStatus, k.currentVersion ?? null, k.verificationStatus ?? null,
      k.description ?? null, k.importUrl ?? null, k.downloadUrl ?? null, k.createdAt ?? null,
      k.updatedAt ?? null, k.publishedAt ?? null, k.removedAt ?? null,
      typeof k.downloads === 'number' ? k.downloads : 0,
      k.featured ?? null, k.featuredRank ?? null,
      jb(k.publisher), jb(k.categories), jb(k.tags), jb(k.badges), jb(k.requiredInputs),
      jb(k.preparedPrompts), jb(k.skills), jb(k.validationSummary), jb(k.latestVersion),
      k.ownerOrgId ?? null, k.visibility ?? null,
      k.pricing ?? null, k.priceModel ?? null, k.priceCents ?? null, k.currency ?? null,
      k.interval ?? null, k.downloadable ?? null, k.licenseType ?? null,
      k.licenseText ?? null, k.licenseVersion ?? null,
    ],
  );
}

async function upsertKitVersion(pool: PgQueryable, v: KitVersionRecord): Promise<void> {
  await pool.query(
    `INSERT INTO kit_versions (
       kit_id, version, file_name, package_file_name, package_size_bytes, summary, schema_version,
       published_at, package_s3_key, sha256, content_type, release_notes, validation_summary, validation_result
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14
     )
     ON CONFLICT (kit_id, version) DO UPDATE SET
       file_name = EXCLUDED.file_name, package_file_name = EXCLUDED.package_file_name,
       package_size_bytes = EXCLUDED.package_size_bytes, summary = EXCLUDED.summary,
       schema_version = EXCLUDED.schema_version, published_at = EXCLUDED.published_at,
       package_s3_key = EXCLUDED.package_s3_key, sha256 = EXCLUDED.sha256,
       content_type = EXCLUDED.content_type, release_notes = EXCLUDED.release_notes,
       validation_summary = EXCLUDED.validation_summary, validation_result = EXCLUDED.validation_result`,
    [
      v.kitId, v.version, v.fileName ?? null, v.packageFileName ?? null,
      v.packageSizeBytes ?? null, v.summary ?? null, v.schemaVersion ?? null,
      v.publishedAt ?? null, v.packageS3Key ?? null, v.sha256 ?? null,
      v.contentType ?? null, v.releaseNotes ?? null, jb(v.validationSummary), jb(v.validationResult),
    ],
  );
}

// --- org repository (Market Phase 2) --------------------------------------------

export function createPostgresOrgRepository(pool: PgPool): OrgRepository {
  async function uniqueSlug(client: PgQueryable, base: string): Promise<string> {
    const existing = await client.query(
      `SELECT slug FROM organizations WHERE slug = $1 OR slug LIKE $2`,
      [base, `${base}-%`],
    );
    return dedupeSlug(base, existing.rows.map((r) => r.slug as string));
  }

  async function insertOrgWithOwner(input: {
    displayName: string;
    ownerUserId: string;
    type: 'personal' | 'team';
    slug?: string;
    handle?: string;
  }): Promise<Organization> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const now = new Date().toISOString();
      const base = (input.slug && input.slug.trim()) ? slugifyForUrl(input.slug) : slugifyForUrl(input.displayName);
      const slug = await uniqueSlug(client, base);
      const org: Organization = {
        orgId: `org_${randomUUID()}`,
        slug,
        displayName: input.displayName,
        type: input.type,
        ownerUserId: input.ownerUserId,
        handle: input.handle,
        createdAt: now,
        updatedAt: now,
      };
      await client.query(
        `INSERT INTO organizations
           (org_id, slug, display_name, type, owner_user_id, handle, avatar_initials, verified, workos_organization_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [org.orgId, org.slug, org.displayName, org.type, org.ownerUserId, org.handle ?? null, null, null, null, org.createdAt, org.updatedAt],
      );
      await client.query(
        `INSERT INTO org_memberships (org_id, user_id, role, status, invited_by_user_id, created_at)
         VALUES ($1,$2,'owner','active',NULL,$3)`,
        [org.orgId, org.ownerUserId, now],
      );
      await client.query('COMMIT');
      return org;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    async createOrg(input): Promise<Organization> {
      return insertOrgWithOwner({
        displayName: input.displayName,
        ownerUserId: input.ownerUserId,
        type: input.type ?? 'team',
        slug: input.slug,
        handle: input.handle,
      });
    },

    async getOrg(orgId: string): Promise<Organization | undefined> {
      const result = await pool.query(`SELECT * FROM organizations WHERE org_id = $1`, [orgId]);
      return result.rows[0] ? rowToOrganization(result.rows[0]) : undefined;
    },

    async getOrgBySlug(slug: string): Promise<Organization | undefined> {
      const result = await pool.query(`SELECT * FROM organizations WHERE slug = $1 LIMIT 1`, [slug]);
      return result.rows[0] ? rowToOrganization(result.rows[0]) : undefined;
    },

    async ensurePersonalOrg(userId: string, displayName: string): Promise<Organization> {
      const existing = await pool.query(
        `SELECT * FROM organizations WHERE owner_user_id = $1 AND type = 'personal' LIMIT 1`,
        [userId],
      );
      if (existing.rows[0]) {
        return rowToOrganization(existing.rows[0]);
      }
      return insertOrgWithOwner({
        displayName,
        ownerUserId: userId,
        type: 'personal',
        slug: personalOrgSlugBase(displayName, userId),
      });
    },

    async listOrgsForUser(userId: string): Promise<Organization[]> {
      const result = await pool.query(
        `SELECT o.* FROM organizations o
           JOIN org_memberships m ON m.org_id = o.org_id
           WHERE m.user_id = $1 AND m.status <> 'removed'
           ORDER BY o.created_at`,
        [userId],
      );
      return result.rows.map(rowToOrganization);
    },

    async getMembership(orgId: string, userId: string): Promise<OrgMembership | undefined> {
      const result = await pool.query(
        `SELECT * FROM org_memberships WHERE org_id = $1 AND user_id = $2`,
        [orgId, userId],
      );
      return result.rows[0] ? rowToMembership(result.rows[0]) : undefined;
    },

    async listMembers(orgId: string): Promise<OrgMembership[]> {
      const result = await pool.query(
        `SELECT * FROM org_memberships WHERE org_id = $1 ORDER BY created_at`,
        [orgId],
      );
      return result.rows.map(rowToMembership);
    },

    async addMember(orgId: string, userId: string, role: OrgRole, invitedBy: string): Promise<OrgMembership> {
      const now = new Date().toISOString();
      const membership: OrgMembership = {
        orgId, userId, role, status: 'invited', invitedByUserId: invitedBy, createdAt: now,
      };
      await pool.query(
        `INSERT INTO org_memberships (org_id, user_id, role, status, invited_by_user_id, created_at)
         VALUES ($1,$2,$3,'invited',$4,$5)
         ON CONFLICT (org_id, user_id) DO UPDATE SET
           role = EXCLUDED.role, status = 'invited', invited_by_user_id = EXCLUDED.invited_by_user_id`,
        [orgId, userId, role, invitedBy, now],
      );
      await pool.query(
        `INSERT INTO org_invites (org_id, user_id, email, role, invited_by_user_id, created_at)
         VALUES ($1,$2,NULL,$3,$4,$5)
         ON CONFLICT (org_id, user_id) DO UPDATE SET
           role = EXCLUDED.role, invited_by_user_id = EXCLUDED.invited_by_user_id`,
        [orgId, userId, role, invitedBy, now],
      );
      return membership;
    },

    async acceptInvite(orgId: string, userId: string): Promise<OrgMembership | undefined> {
      const result = await pool.query(
        `UPDATE org_memberships SET status = 'active'
           WHERE org_id = $1 AND user_id = $2 AND status = 'invited'
           RETURNING *`,
        [orgId, userId],
      );
      if (!result.rows[0]) {
        return undefined;
      }
      await pool.query(`DELETE FROM org_invites WHERE org_id = $1 AND user_id = $2`, [orgId, userId]);
      return rowToMembership(result.rows[0]);
    },

    async listInvitesForUser(userId: string): Promise<OrgInvite[]> {
      const result = await pool.query(
        `SELECT * FROM org_invites WHERE user_id = $1 ORDER BY created_at`,
        [userId],
      );
      return result.rows.map(rowToInvite);
    },

    async removeMember(orgId: string, userId: string): Promise<void> {
      await pool.query(
        `UPDATE org_memberships SET status = 'removed' WHERE org_id = $1 AND user_id = $2`,
        [orgId, userId],
      );
      await pool.query(`DELETE FROM org_invites WHERE org_id = $1 AND user_id = $2`, [orgId, userId]);
    },

    async deleteOrg(orgId: string): Promise<void> {
      await pool.query(`DELETE FROM org_invites WHERE org_id = $1`, [orgId]);
      await pool.query(`DELETE FROM org_memberships WHERE org_id = $1`, [orgId]);
      await pool.query(`DELETE FROM organizations WHERE org_id = $1`, [orgId]);
    },

    async setKitOwnerOrg(kitId: string, orgId: string): Promise<KitRecord | undefined> {
      const result = await pool.query(
        `UPDATE kits SET owner_org_id = $2, updated_at = $3 WHERE kit_id = $1 RETURNING *`,
        [kitId, orgId, new Date().toISOString()],
      );
      return result.rows[0] ? rowToKit(result.rows[0]) : undefined;
    },

    async setKitVisibility(kitId: string, visibility: KitVisibility): Promise<KitRecord | undefined> {
      const result = await pool.query(
        `UPDATE kits SET visibility = $2, updated_at = $3 WHERE kit_id = $1 RETURNING *`,
        [kitId, visibility, new Date().toISOString()],
      );
      return result.rows[0] ? rowToKit(result.rows[0]) : undefined;
    },

    async listKitsForOrg(orgId: string): Promise<KitRecord[]> {
      const result = await pool.query(
        `SELECT * FROM kits WHERE owner_org_id = $1 ORDER BY kit_id`,
        [orgId],
      );
      return result.rows.map(rowToKit);
    },
  };
}

// --- entitlement repository (Tier-2 paid kits) ----------------------------------

export function createPostgresEntitlementRepository(pool: PgPool): EntitlementRepository {
  return {
    async grantEntitlement(input: GrantEntitlementInput): Promise<Entitlement> {
      const existing = await pool.query(
        `SELECT * FROM entitlements WHERE user_id = $1 AND kit_id = $2`,
        [input.userId, input.kitId],
      );
      const prior = existing.rows[0] ? rowToEntitlement(existing.rows[0]) : undefined;
      const now = new Date().toISOString();
      const entitlement: Entitlement = {
        entitlementId: prior?.entitlementId ?? `ent_${randomUUID()}`,
        kitId: input.kitId,
        userId: input.userId,
        status: 'active',
        source: input.source,
        licenseVersion: input.licenseVersion,
        licenseAcceptedAt: input.licenseAcceptedAt,
        licenseTextSnapshot: input.licenseTextSnapshot,
        grantedAt: prior?.grantedAt ?? now,
        expiresAt: input.expiresAt,
        stripeSubscriptionId: input.stripeSubscriptionId ?? null,
      };
      await pool.query(
        `INSERT INTO entitlements (
           entitlement_id, kit_id, user_id, status, source, license_version,
           license_accepted_at, license_text_snapshot, granted_at, expires_at, stripe_subscription_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (user_id, kit_id) DO UPDATE SET
           status = 'active', source = EXCLUDED.source, license_version = EXCLUDED.license_version,
           license_accepted_at = EXCLUDED.license_accepted_at,
           license_text_snapshot = EXCLUDED.license_text_snapshot,
           expires_at = EXCLUDED.expires_at, stripe_subscription_id = EXCLUDED.stripe_subscription_id`,
        [
          entitlement.entitlementId, entitlement.kitId, entitlement.userId, entitlement.status,
          entitlement.source, entitlement.licenseVersion, entitlement.licenseAcceptedAt,
          entitlement.licenseTextSnapshot, entitlement.grantedAt, entitlement.expiresAt ?? null,
          entitlement.stripeSubscriptionId ?? null,
        ],
      );
      return entitlement;
    },

    async getEntitlement(userId: string, kitId: string): Promise<Entitlement | undefined> {
      const result = await pool.query(
        `SELECT * FROM entitlements WHERE user_id = $1 AND kit_id = $2`,
        [userId, kitId],
      );
      return result.rows[0] ? rowToEntitlement(result.rows[0]) : undefined;
    },

    async listEntitlementsForUser(userId: string): Promise<Entitlement[]> {
      const result = await pool.query(
        `SELECT * FROM entitlements WHERE user_id = $1 ORDER BY granted_at`,
        [userId],
      );
      return result.rows.map(rowToEntitlement);
    },

    async revokeEntitlement(userId: string, kitId: string): Promise<Entitlement | undefined> {
      const result = await pool.query(
        `UPDATE entitlements SET status = 'revoked'
           WHERE user_id = $1 AND kit_id = $2 RETURNING *`,
        [userId, kitId],
      );
      return result.rows[0] ? rowToEntitlement(result.rows[0]) : undefined;
    },

    async listEntitlementsForKit(kitId: string): Promise<Entitlement[]> {
      const result = await pool.query(
        `SELECT * FROM entitlements WHERE kit_id = $1 ORDER BY granted_at`,
        [kitId],
      );
      return result.rows.map(rowToEntitlement);
    },
  };
}

// --- favorites repository (cloud-synced kit references) -------------------------

export function createPostgresFavoritesRepository(pool: PgPool): FavoritesRepository {
  return {
    async addFavorite(userId: string, input: AddFavoriteInput): Promise<Favorite> {
      const now = new Date().toISOString();
      // Idempotent on (user_id, kit_id): refresh cached metadata + slug but
      // preserve the original added_at.
      const result = await pool.query(
        `INSERT INTO favorites (user_id, kit_id, slug, added_at, display_name, summary, publisher_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_id, kit_id) DO UPDATE SET
           slug = EXCLUDED.slug,
           display_name = EXCLUDED.display_name,
           summary = EXCLUDED.summary,
           publisher_name = EXCLUDED.publisher_name
         RETURNING *`,
        [
          userId, input.kitId, input.slug, now,
          input.displayName ?? null, input.summary ?? null, input.publisherName ?? null,
        ],
      );
      return rowToFavorite(result.rows[0]);
    },

    async listFavorites(userId: string): Promise<Favorite[]> {
      const result = await pool.query(
        `SELECT * FROM favorites WHERE user_id = $1 ORDER BY added_at`,
        [userId],
      );
      return result.rows.map(rowToFavorite);
    },

    async removeFavorite(userId: string, kitId: string): Promise<void> {
      await pool.query(
        `DELETE FROM favorites WHERE user_id = $1 AND kit_id = $2`,
        [userId, kitId],
      );
    },
  };
}

// --- pagination cursor (deterministic offset) -----------------------------------

function encodeOffset(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}

function decodeOffset(token: string | undefined): number {
  if (!token) {
    return 0;
  }
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as { offset?: unknown };
    if (typeof parsed.offset === 'number' && Number.isInteger(parsed.offset) && parsed.offset >= 0) {
      return parsed.offset;
    }
  } catch {
    return 0;
  }
  return 0;
}
