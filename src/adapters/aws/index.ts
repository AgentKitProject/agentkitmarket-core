/**
 * AWS adapters for the market core ports.
 *
 * Implements CatalogRepository + AdminRepository over DynamoDB and
 * PackageUploadService over S3 + SQS. The DynamoDB query/condition/update
 * expressions, S3 presign params, and SQS payloads are kept EXACTLY as the
 * original agentkitmarket-infra Lambda handler (Phase 1 extraction). Cloud SDK
 * imports are confined to this file (and the lambda entrypoint).
 *
 * Factory functions take their table/bucket/queue config explicitly so the
 * entrypoint (not module-level env reads) wires them.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';
import type {
  AdminRepository,
  CatalogRepository,
  ObjectStore,
  PackageUploadService,
  SubmissionValidationUpdate,
  ValidationJobUpdate,
} from '../../core/ports.js';
import type {
  CatalogDetail,
  CatalogPage,
  CreateSubmissionInput,
  CreateSubmissionResult,
  KitRecord,
  KitVersionRecord,
  PublisherRecord,
  SubmissionRecord,
  ValidationJobRecord,
} from '../../core/types.js';
import {
  ARCHIVED_STATUS,
  CANCELED_STATUS,
  DOWNLOAD_URL_EXPIRES_IN_SECONDS,
  PUBLIC_REVIEW_STATUS,
  PUBLIC_STATUS,
  PUBLIC_VALIDATION_STATUS,
  REMOVED_STATUS,
  UPLOAD_URL_EXPIRES_IN_SECONDS,
} from '../../core/services/constants.js';
import {
  buildSubmissionRecord,
  isKitRecord,
  isKitVersionRecord,
  isPublicKit,
  isPublisherRecord,
  isSubmissionRecord,
  safeDownloadFileName,
  safeValidationSummary,
  slugifyForUrl,
  toKitPublisherSnapshot,
  toPublicVersion,
  decodePageToken,
  encodePageToken,
  isActiveSubmissionForDuplicateCheck,
} from '../../core/services/index.js';

/** Config for the DynamoDB catalog (read-side) repository. */
export interface DynamoCatalogConfig {
  kitsTableName: string;
  kitVersionsTableName: string;
  publishersTableName: string;
}

/** Config for the DynamoDB admin (write-side) repository. */
export interface DynamoAdminConfig {
  kitsTableName: string;
  kitVersionsTableName: string;
  submissionsTableName: string;
  validationJobsTableName: string;
}

/** Config for the S3 + SQS package upload service. */
export interface AwsPackageUploadConfig {
  packageBucketName: string;
  validationQueueUrl: string;
}

export function createDynamoCatalogRepository(config: DynamoCatalogConfig): CatalogRepository {
  const { kitsTableName, kitVersionsTableName, publishersTableName } = config;
  const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: {
      removeUndefinedValues: true,
    },
  });

  return {
    async listKits(limit: number, nextToken: string | undefined): Promise<CatalogPage> {
      const result = await dynamo.send(new ScanCommand({
        TableName: kitsTableName,
        FilterExpression: '#status = :status AND validationStatus = :validationStatus AND reviewStatus = :reviewStatus',
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':status': PUBLIC_STATUS,
          ':validationStatus': PUBLIC_VALIDATION_STATUS,
          ':reviewStatus': PUBLIC_REVIEW_STATUS,
        },
        Limit: limit,
        ExclusiveStartKey: decodePageToken(nextToken),
      }));

      const kits = (result.Items ?? []).filter(isKitRecord);
      const publishers = await getPublishers(dynamo, publishersTableName, kits.map((kit) => kit.publisherId));

      return {
        kits,
        publishers,
        nextToken: encodePageToken(result.LastEvaluatedKey),
      };
    },

    async getKitBySlug(slug: string): Promise<CatalogDetail> {
      const result = await dynamo.send(new QueryCommand({
        TableName: kitsTableName,
        IndexName: 'slug-index',
        KeyConditionExpression: 'slug = :slug',
        ExpressionAttributeValues: {
          ':slug': slug,
        },
        Limit: 1,
      }));

      const kit = (result.Items ?? []).filter(isKitRecord).find(isPublicKit);

      if (!kit) {
        return {
          kit: undefined,
          publisher: undefined,
          versions: [],
        };
      }

      const [publishers, versionsResult] = await Promise.all([
        getPublishers(dynamo, publishersTableName, [kit.publisherId]),
        dynamo.send(new QueryCommand({
          TableName: kitVersionsTableName,
          KeyConditionExpression: 'kitId = :kitId',
          ExpressionAttributeValues: {
            ':kitId': kit.kitId,
          },
          ProjectionExpression: 'kitId, version, summary, schemaVersion, packageSizeBytes, sha256, publishedAt',
          ScanIndexForward: false,
        })),
      ]);

      return {
        kit,
        publisher: publishers.get(kit.publisherId),
        versions: (versionsResult.Items ?? []).filter(isKitVersionRecord),
      };
    },
  };
}

export function createDynamoAdminRepository(config: DynamoAdminConfig): AdminRepository {
  const { kitsTableName, kitVersionsTableName, submissionsTableName, validationJobsTableName } = config;
  const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: {
      removeUndefinedValues: true,
    },
  });

  return {
    async createSubmission(input: CreateSubmissionInput): Promise<CreateSubmissionResult> {
      const submission = buildSubmissionRecord(input);

      await dynamo.send(new PutCommand({
        TableName: submissionsTableName,
        Item: submission,
        ConditionExpression: 'attribute_not_exists(submissionId)',
      }));

      return {
        submission,
        version: input.version,
      };
    },

    async findActiveDuplicateSubmission(input: CreateSubmissionInput): Promise<SubmissionRecord | undefined> {
      if (!input.submittedByUserId) {
        return undefined;
      }

      const result = await dynamo.send(new ScanCommand({
        TableName: submissionsTableName,
        FilterExpression: 'submittedByUserId = :submittedByUserId AND version = :version',
        ExpressionAttributeValues: {
          ':submittedByUserId': input.submittedByUserId,
          ':version': input.version,
        },
        Limit: 50,
      }));

      const requestedSlug = slugifyForUrl(input.listingDraft.name);
      return (result.Items ?? [])
        .filter(isSubmissionRecord)
        .find((submission) => isActiveSubmissionForDuplicateCheck(submission)
          && slugifyForUrl(submission.listingDraft.name) === requestedSlug);
    },

    async getSubmission(submissionId: string): Promise<SubmissionRecord | undefined> {
      const result = await dynamo.send(new GetCommand({
        TableName: submissionsTableName,
        Key: { submissionId },
      }));

      return isSubmissionRecord(result.Item) ? result.Item : undefined;
    },

    async listSubmissions(): Promise<SubmissionRecord[]> {
      const result = await dynamo.send(new ScanCommand({
        TableName: submissionsTableName,
        Limit: 100,
      }));

      return (result.Items ?? []).filter(isSubmissionRecord);
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

      await dynamo.send(new PutCommand({
        TableName: validationJobsTableName,
        Item: job,
        ConditionExpression: 'attribute_not_exists(jobId)',
      }));

      return job;
    },

    async markSubmissionValidationQueued(submissionId: string, validationJobId: string): Promise<void> {
      await dynamo.send(new UpdateCommand({
        TableName: submissionsTableName,
        Key: { submissionId },
        // Clear the awaiting_upload TTL: the package has been uploaded and queued,
        // so this row must be retained rather than auto-expired.
        UpdateExpression: 'SET validationStatus = :validationStatus, #status = :status, validationJobId = :validationJobId, updatedAt = :updatedAt REMOVE expiresAt',
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':validationStatus': 'queued',
          ':status': 'validation_queued',
          ':validationJobId': validationJobId,
          ':updatedAt': new Date().toISOString(),
        },
      }));
    },

    async approveSubmission(
      submissionId: string,
      reviewNotes: string | null,
      reviewedAt: string,
    ): Promise<SubmissionRecord | undefined> {
      const result = await dynamo.send(new UpdateCommand({
        TableName: submissionsTableName,
        Key: { submissionId },
        UpdateExpression: 'SET reviewStatus = :reviewStatus, reviewNotes = :reviewNotes, reviewedAt = :reviewedAt, updatedAt = :updatedAt',
        ExpressionAttributeValues: {
          ':reviewStatus': 'approved',
          ':reviewNotes': reviewNotes,
          ':reviewedAt': reviewedAt,
          ':updatedAt': reviewedAt,
        },
        ReturnValues: 'ALL_NEW',
      }));

      return isSubmissionRecord(result.Attributes) ? result.Attributes : undefined;
    },

    async rejectSubmission(
      submissionId: string,
      reviewNotes: string,
      reviewedAt: string,
    ): Promise<SubmissionRecord | undefined> {
      const result = await dynamo.send(new UpdateCommand({
        TableName: submissionsTableName,
        Key: { submissionId },
        UpdateExpression: 'SET reviewStatus = :reviewStatus, #status = :status, reviewNotes = :reviewNotes, reviewedAt = :reviewedAt, updatedAt = :updatedAt',
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':reviewStatus': 'rejected',
          ':status': 'rejected',
          ':reviewNotes': reviewNotes,
          ':reviewedAt': reviewedAt,
          ':updatedAt': reviewedAt,
        },
        ReturnValues: 'ALL_NEW',
      }));

      return isSubmissionRecord(result.Attributes) ? result.Attributes : undefined;
    },

    async archiveSubmission(submissionId: string, archivedAt: string): Promise<SubmissionRecord | undefined> {
      const result = await dynamo.send(new UpdateCommand({
        TableName: submissionsTableName,
        Key: { submissionId },
        UpdateExpression: 'SET #status = :status, archivedAt = :archivedAt, updatedAt = :updatedAt',
        ConditionExpression: 'attribute_exists(submissionId) AND #status <> :publishedStatus',
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':status': ARCHIVED_STATUS,
          ':archivedAt': archivedAt,
          ':updatedAt': archivedAt,
          ':publishedStatus': PUBLIC_STATUS,
        },
        ReturnValues: 'ALL_NEW',
      }));

      return isSubmissionRecord(result.Attributes) ? result.Attributes : undefined;
    },

    async cancelSubmission(submissionId: string, canceledAt: string): Promise<SubmissionRecord | undefined> {
      const result = await dynamo.send(new UpdateCommand({
        TableName: submissionsTableName,
        Key: { submissionId },
        UpdateExpression: 'SET #status = :status, canceledAt = :canceledAt, updatedAt = :updatedAt',
        ConditionExpression: 'attribute_exists(submissionId) AND #status <> :publishedStatus',
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':status': CANCELED_STATUS,
          ':canceledAt': canceledAt,
          ':updatedAt': canceledAt,
          ':publishedStatus': PUBLIC_STATUS,
        },
        ReturnValues: 'ALL_NEW',
      }));

      return isSubmissionRecord(result.Attributes) ? result.Attributes : undefined;
    },

    async publishSubmission(submission: SubmissionRecord, publishedAt: string): Promise<KitRecord> {
      const existingKitResult = await dynamo.send(new GetCommand({
        TableName: kitsTableName,
        Key: { kitId: submission.kitId },
      }));
      const existingKit = isKitRecord(existingKitResult.Item) ? existingKitResult.Item : undefined;
      const version = submission.version ?? '0.0.0';
      const packageFileName = safeDownloadFileName(slugifyForUrl(submission.listingDraft.name), version);
      const kit: KitRecord = {
        kitId: submission.kitId,
        slug: slugifyForUrl(submission.listingDraft.name),
        name: submission.listingDraft.name,
        summary: submission.listingDraft.summary,
        description: submission.listingDraft.description,
        publisherId: submission.publisherId,
        // ownerUserId is set on first publish and never reassigned: a version_update
        // keeps the original owner (already verified to match the submitter).
        ownerUserId: existingKit?.ownerUserId ?? submission.submittedByUserId,
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
        validationSummary: safeValidationSummary(submission.validationSummary) ?? undefined,
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
        validationSummary: safeValidationSummary(submission.validationSummary) ?? undefined,
        validationResult: safeValidationSummary(submission.validationSummary) ?? undefined,
        publishedAt,
      };

      await Promise.all([
        dynamo.send(new PutCommand({
          TableName: kitsTableName,
          Item: kit,
        })),
        dynamo.send(new PutCommand({
          TableName: kitVersionsTableName,
          Item: kitVersion,
        })),
        dynamo.send(new UpdateCommand({
          TableName: submissionsTableName,
          Key: { submissionId: submission.submissionId },
          UpdateExpression: 'SET #status = :status, publishedAt = :publishedAt, updatedAt = :updatedAt',
          ExpressionAttributeNames: {
            '#status': 'status',
          },
          ExpressionAttributeValues: {
            ':status': PUBLIC_STATUS,
            ':publishedAt': publishedAt,
            ':updatedAt': publishedAt,
          },
        })),
      ]);

      return kit;
    },

    async hideKit(kitId: string): Promise<KitRecord | undefined> {
      const existingKitResult = await dynamo.send(new GetCommand({
        TableName: kitsTableName,
        Key: { kitId },
      }));
      if (!isKitRecord(existingKitResult.Item)) {
        return undefined;
      }

      const updatedAt = new Date().toISOString();
      const result = await dynamo.send(new UpdateCommand({
        TableName: kitsTableName,
        Key: { kitId },
        UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt',
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':status': 'hidden',
          ':updatedAt': updatedAt,
        },
        ReturnValues: 'ALL_NEW',
      }));

      return isKitRecord(result.Attributes) ? result.Attributes : undefined;
    },

    async unhideKit(kitId: string): Promise<KitRecord | undefined> {
      const existingKitResult = await dynamo.send(new GetCommand({
        TableName: kitsTableName,
        Key: { kitId },
      }));
      if (!isKitRecord(existingKitResult.Item)) {
        return undefined;
      }

      if (existingKitResult.Item.status !== 'hidden'
        || existingKitResult.Item.validationStatus !== PUBLIC_VALIDATION_STATUS
        || existingKitResult.Item.reviewStatus !== PUBLIC_REVIEW_STATUS) {
        return undefined;
      }

      const updatedAt = new Date().toISOString();
      const result = await dynamo.send(new UpdateCommand({
        TableName: kitsTableName,
        Key: { kitId },
        UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt',
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':status': PUBLIC_STATUS,
          ':updatedAt': updatedAt,
        },
        ReturnValues: 'ALL_NEW',
      }));

      return isKitRecord(result.Attributes) ? result.Attributes : undefined;
    },

    async removeKit(kitId: string, removedAt: string): Promise<KitRecord | undefined> {
      const existingKitResult = await dynamo.send(new GetCommand({
        TableName: kitsTableName,
        Key: { kitId },
      }));
      if (!isKitRecord(existingKitResult.Item)) {
        return undefined;
      }

      const result = await dynamo.send(new UpdateCommand({
        TableName: kitsTableName,
        Key: { kitId },
        UpdateExpression: 'SET #status = :status, removedAt = :removedAt, updatedAt = :updatedAt',
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':status': REMOVED_STATUS,
          ':removedAt': removedAt,
          ':updatedAt': removedAt,
        },
        ReturnValues: 'ALL_NEW',
      }));

      return isKitRecord(result.Attributes) ? result.Attributes : undefined;
    },

    async getKit(kitId: string): Promise<KitRecord | undefined> {
      const result = await dynamo.send(new GetCommand({
        TableName: kitsTableName,
        Key: { kitId },
      }));

      return isKitRecord(result.Item) ? result.Item : undefined;
    },

    async getKitBySlug(slug: string): Promise<KitRecord | undefined> {
      const result = await dynamo.send(new QueryCommand({
        TableName: kitsTableName,
        IndexName: 'slug-index',
        KeyConditionExpression: 'slug = :slug',
        ExpressionAttributeValues: {
          ':slug': slug,
        },
        Limit: 1,
      }));

      return (result.Items ?? []).filter(isKitRecord)[0];
    },

    async getKitVersion(kitId: string, version: string): Promise<KitVersionRecord | undefined> {
      const result = await dynamo.send(new GetCommand({
        TableName: kitVersionsTableName,
        Key: { kitId, version },
      }));

      return isKitVersionRecord(result.Item) ? result.Item : undefined;
    },

    async listKitVersions(kitId: string): Promise<KitVersionRecord[]> {
      const result = await dynamo.send(new QueryCommand({
        TableName: kitVersionsTableName,
        KeyConditionExpression: 'kitId = :kitId',
        ExpressionAttributeValues: { ':kitId': kitId },
      }));

      return (result.Items ?? []).filter(isKitVersionRecord);
    },

    async findKitVersionBySha256(sha256: string): Promise<KitVersionRecord | undefined> {
      const result = await dynamo.send(new QueryCommand({
        TableName: kitVersionsTableName,
        IndexName: 'sha256-index',
        KeyConditionExpression: 'sha256 = :sha256',
        ExpressionAttributeValues: { ':sha256': sha256 },
        Limit: 1,
      }));

      return (result.Items ?? []).filter(isKitVersionRecord)[0];
    },

    async incrementKitDownloads(kitId: string): Promise<void> {
      await dynamo.send(new UpdateCommand({
        TableName: kitsTableName,
        Key: { kitId },
        UpdateExpression: 'SET updatedAt = :updatedAt ADD downloads :one',
        ExpressionAttributeValues: {
          ':one': 1,
          ':updatedAt': new Date().toISOString(),
        },
      }));
    },

    async updateValidationJob(jobId: string, update: ValidationJobUpdate): Promise<void> {
      await updateDynamoItem(dynamo, validationJobsTableName, { jobId }, {
        status: update.status,
        result: update.result,
        startedAt: update.startedAt,
        completedAt: update.completedAt,
        updatedAt: update.updatedAt,
      });
    },

    async updateSubmissionValidationResult(submissionId: string, update: SubmissionValidationUpdate): Promise<void> {
      await updateDynamoItem(dynamo, submissionsTableName, { submissionId }, {
        status: update.status,
        validationStatus: update.validationStatus,
        validationSummary: update.validationSummary,
        packageSizeBytes: update.packageSizeBytes,
        sha256: update.sha256,
        contentType: update.contentType,
        updatedAt: update.updatedAt,
      });
    },
  };
}

/**
 * Dynamic SET update mirroring the infra validation worker's `updateItem`:
 * builds `SET #k = :k` for each entry. Undefined-valued keys are dropped so the
 * expression matches the worker (which relied on `removeUndefinedValues`).
 */
async function updateDynamoItem(
  dynamo: DynamoDBDocumentClient,
  tableName: string,
  key: Record<string, string>,
  values: Record<string, unknown>,
): Promise<void> {
  const entries = Object.entries(values).filter(([, value]) => value !== undefined);
  if (entries.length === 0) {
    return;
  }

  await dynamo.send(new UpdateCommand({
    TableName: tableName,
    Key: key,
    UpdateExpression: `SET ${entries.map(([name]) => `#${name} = :${name}`).join(', ')}`,
    ExpressionAttributeNames: Object.fromEntries(entries.map(([name]) => [`#${name}`, name])),
    ExpressionAttributeValues: Object.fromEntries(entries.map(([name, value]) => [`:${name}`, value])),
  }));
}

export function createAwsPackageUploadService(config: AwsPackageUploadConfig): PackageUploadService {
  const { packageBucketName, validationQueueUrl } = config;
  const s3 = new S3Client({});
  const sqs = new SQSClient({});

  return {
    createUploadUrl(packageS3Key: string): Promise<string> {
      return getSignedUrl(s3, new PutObjectCommand({
        Bucket: packageBucketName,
        Key: packageS3Key,
        ContentType: 'application/zip',
      }), {
        expiresIn: UPLOAD_URL_EXPIRES_IN_SECONDS,
      });
    },

    createDownloadUrl(packageS3Key: string): Promise<string> {
      return getSignedUrl(s3, new GetObjectCommand({
        Bucket: packageBucketName,
        Key: packageS3Key,
      }), {
        expiresIn: DOWNLOAD_URL_EXPIRES_IN_SECONDS,
      });
    },

    async packageExists(packageS3Key: string): Promise<boolean> {
      try {
        await s3.send(new HeadObjectCommand({
          Bucket: packageBucketName,
          Key: packageS3Key,
        }));
        return true;
      } catch (error) {
        console.warn('Package object lookup failed', { packageS3Key, error });
        return false;
      }
    },

    async enqueueValidationJob(job: ValidationJobRecord): Promise<void> {
      await sqs.send(new SendMessageCommand({
        QueueUrl: validationQueueUrl,
        MessageBody: JSON.stringify({
          jobId: job.jobId,
          submissionId: job.submissionId,
          kitId: job.kitId,
          packageS3Key: job.packageS3Key,
        }),
      }));
    },
  };
}

/** Config for the S3 object store used by the hosted validation worker. */
export interface S3ObjectStoreConfig {
  packageBucketName: string;
}

/**
 * S3-backed ObjectStore for the hosted validation worker. `readStream` yields the
 * GetObject body as an AsyncIterable<Uint8Array>, matching the self-host MinIO
 * adapter so `runValidationJob` is identical across runtimes. The upload/download
 * presign + exists methods reuse the same params as the package upload service.
 */
export function createS3ObjectStore(config: S3ObjectStoreConfig): ObjectStore {
  const { packageBucketName } = config;
  const s3 = new S3Client({});

  return {
    createUploadUrl(key: string): Promise<string> {
      return getSignedUrl(s3, new PutObjectCommand({
        Bucket: packageBucketName,
        Key: key,
        ContentType: 'application/zip',
      }), { expiresIn: UPLOAD_URL_EXPIRES_IN_SECONDS });
    },

    createDownloadUrl(key: string): Promise<string> {
      return getSignedUrl(s3, new GetObjectCommand({
        Bucket: packageBucketName,
        Key: key,
      }), { expiresIn: DOWNLOAD_URL_EXPIRES_IN_SECONDS });
    },

    async exists(key: string): Promise<boolean> {
      try {
        await s3.send(new HeadObjectCommand({ Bucket: packageBucketName, Key: key }));
        return true;
      } catch (error) {
        console.warn('Package object lookup failed', { key, error });
        return false;
      }
    },

    async readStream(key: string): Promise<AsyncIterable<Uint8Array>> {
      const result = await s3.send(new GetObjectCommand({ Bucket: packageBucketName, Key: key }));
      const body = result.Body as unknown;
      if (!body) {
        throw new Error(`Object not found: ${key}`);
      }
      return body as AsyncIterable<Uint8Array>;
    },
  };
}

async function getPublishers(
  dynamo: DynamoDBDocumentClient,
  publishersTableName: string,
  publisherIds: string[],
): Promise<Map<string, PublisherRecord>> {
  const uniquePublisherIds = [...new Set(publisherIds)].filter(Boolean);

  if (uniquePublisherIds.length === 0) {
    return new Map();
  }

  const result = await dynamo.send(new BatchGetCommand({
    RequestItems: {
      [publishersTableName]: {
        Keys: uniquePublisherIds.map((publisherId) => ({ publisherId })),
        ProjectionExpression: 'publisherId, displayName, handle, avatarInitials, verified',
      },
    },
  }));

  const publishers = new Map<string, PublisherRecord>();
  for (const item of result.Responses?.[publishersTableName] ?? []) {
    if (isPublisherRecord(item)) {
      publishers.set(item.publisherId, item);
    }
  }

  return publishers;
}
