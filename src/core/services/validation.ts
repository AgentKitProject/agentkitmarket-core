/**
 * Validation worker logic, extracted from agentkitmarket-infra's Lambda
 * validation worker so it is shared by the hosted (SQS) and self-host (Redis)
 * runtimes. Behavior is preserved EXACTLY:
 *
 *   1. Mark the job `running` (startedAt/updatedAt).
 *   2. Validate the package object:
 *      - package key must end with `/package.agentkit.zip` (else `failed`);
 *      - read the object, computing its size + sha256;
 *      - empty object (0 bytes) -> `failed`;
 *      - size > 50 MiB -> `failed`;
 *      - otherwise `passed` with the same summary text + checks list.
 *   3. On success: mark the job with the summary + completion; update the
 *      submission to `validation_passed`/`failed` with the summary, size, sha256,
 *      and contentType.
 *   4. On any thrown error: a "failed before package contents were trusted"
 *      summary is written to both the job and the submission.
 *
 * The only mechanical differences from the infra worker:
 *   - reads/writes go through the `ObjectStore` + `AdminRepository` ports, never
 *     a cloud SDK (so core/ stays cloud-free);
 *   - size + contentType: the infra worker read these from S3 HeadObject. The
 *     ObjectStore port exposes a stream, so size is computed while hashing and
 *     contentType defaults to `application/zip` (matching the infra worker's
 *     `head.ContentType ?? 'application/zip'` fallback for zip uploads).
 */

import { createHash } from 'node:crypto';
import type {
  AdminRepository,
  ObjectStore,
  ValidationJobMessage,
} from '../ports.js';

/** Max validated package size — identical to the infra worker (50 MiB). */
const MAX_PACKAGE_BYTES = 50 * 1024 * 1024;

export interface ValidationSummary {
  status: 'passed' | 'failed';
  summary: string;
  checkedAt: string;
  checks: string[];
  errors?: string[];
  packageSizeBytes?: number;
  sha256?: string;
  contentType?: string;
}

export interface RunValidationDeps {
  objectStore: ObjectStore;
  admin: AdminRepository;
}

export async function runValidationJob(
  message: ValidationJobMessage,
  deps: RunValidationDeps,
): Promise<void> {
  const { objectStore, admin } = deps;
  const jobId = message.jobId;
  const startedAt = new Date().toISOString();

  console.log('Starting AgentKit validation job', {
    jobId,
    submissionId: message.submissionId,
    kitId: message.kitId,
    packageS3Key: message.packageKey,
    validationMode: 'non-executing-foundation',
    nextIntegration: '@agentkitforge/core',
  });

  await admin.updateValidationJob(jobId, {
    status: 'running',
    startedAt,
    updatedAt: startedAt,
  });

  try {
    const summary = await validatePackageObject(message, objectStore);
    const completedAt = new Date().toISOString();

    await admin.updateValidationJob(jobId, {
      status: summary.status,
      result: summary,
      completedAt,
      updatedAt: completedAt,
    });

    if (message.submissionId) {
      await admin.updateSubmissionValidationResult(message.submissionId, {
        status: summary.status === 'passed' ? 'validation_passed' : 'validation_failed',
        validationStatus: summary.status,
        validationSummary: summary,
        packageSizeBytes: summary.packageSizeBytes,
        sha256: summary.sha256,
        contentType: summary.contentType,
        updatedAt: completedAt,
      });
    }
  } catch (error) {
    const completedAt = new Date().toISOString();
    const summary: ValidationSummary = {
      status: 'failed',
      summary: 'Validation failed before package contents were trusted.',
      checkedAt: completedAt,
      checks: ['safe-error-summary'],
      errors: ['Validation failed before package contents were trusted.'],
    };

    console.warn('Validation job failed safely', {
      jobId,
      submissionId: message.submissionId,
      error,
    });

    await admin.updateValidationJob(jobId, {
      status: 'failed',
      result: summary,
      completedAt,
      updatedAt: completedAt,
    });

    if (message.submissionId) {
      await admin.updateSubmissionValidationResult(message.submissionId, {
        status: 'validation_failed',
        validationStatus: 'failed',
        validationSummary: summary,
        updatedAt: completedAt,
      });
    }
  }
}

async function validatePackageObject(
  message: ValidationJobMessage,
  objectStore: ObjectStore,
): Promise<ValidationSummary> {
  const checkedAt = new Date().toISOString();
  const packageKey = message.packageKey;

  if (!packageKey || !packageKey.endsWith('/package.agentkit.zip')) {
    return {
      status: 'failed',
      summary: 'Package key is missing or does not point to a submitted Agent Kit zip.',
      checkedAt,
      checks: ['package-key-shape'],
      errors: ['Package key is missing or invalid.'],
    };
  }

  const contentType = 'application/zip';
  const { sha256, packageSizeBytes, exceededLimit } = await hashObject(objectStore, packageKey);

  if (packageSizeBytes <= 0) {
    return {
      status: 'failed',
      summary: 'Package object is empty.',
      checkedAt,
      checks: ['non-empty-package'],
      errors: ['Package object is empty.'],
      packageSizeBytes,
      contentType,
    };
  }

  if (exceededLimit || packageSizeBytes > MAX_PACKAGE_BYTES) {
    return {
      status: 'failed',
      summary: 'Package exceeds the current validation size limit.',
      checkedAt,
      checks: ['package-size-limit'],
      errors: ['Package exceeds the current validation size limit.'],
      packageSizeBytes,
      contentType,
    };
  }

  return {
    status: 'passed',
    summary: '@agentkitforge/core validation integration is pending; foundational storage checks passed without executing package contents.',
    checkedAt,
    checks: [
      'package-object-exists',
      'package-size-limit',
      'no-script-execution',
      'agentkitforge-core-pending',
    ],
    packageSizeBytes,
    sha256,
    contentType,
  };
}

/**
 * Streams the object, computing sha256 + byte count. Stops accumulating into the
 * hash once the size limit is exceeded (so an oversized object can't blow up the
 * worker) while still reporting the full byte count.
 */
async function hashObject(
  objectStore: ObjectStore,
  key: string,
): Promise<{ sha256: string; packageSizeBytes: number; exceededLimit: boolean }> {
  const stream = await objectStore.readStream(key);
  const hash = createHash('sha256');
  let packageSizeBytes = 0;
  let exceededLimit = false;

  for await (const chunk of stream) {
    const bytes = chunk instanceof Uint8Array ? chunk : Uint8Array.from(chunk as ArrayLike<number>);
    packageSizeBytes += bytes.byteLength;
    if (!exceededLimit) {
      hash.update(bytes);
      if (packageSizeBytes > MAX_PACKAGE_BYTES) {
        exceededLimit = true;
      }
    }
  }

  return {
    sha256: hash.digest('hex'),
    packageSizeBytes,
    exceededLimit,
  };
}
