/**
 * Hosted (AWS Lambda + SQS) validation-worker entrypoint for the market core.
 *
 * THIN adapter, mirroring entrypoints/lambda: it reads each SQS record body
 * (the producer's message, which uses `packageS3Key`), reconciles it to the
 * runtime-agnostic `ValidationJobMessage` (which uses `packageKey`) at this read
 * boundary, and runs the shared `runValidationJob` with the AWS S3 object store +
 * DynamoDB admin repository.
 *
 * The SQS PRODUCER message format is UNCHANGED (still `packageS3Key`); only this
 * consumer reconciles the field name. Behavior matches the original
 * agentkitmarket-infra validation worker exactly, with all writes now flowing
 * through the AdminRepository port instead of direct DynamoDB UpdateItem.
 */

import type { SQSEvent, SQSRecord } from 'aws-lambda';
import type { AdminRepository, ObjectStore, ValidationJobMessage } from '../core/ports.js';
import { runValidationJob } from '../core/services/validation.js';
import { createDynamoAdminRepository, createS3ObjectStore } from '../adapters/aws/index.js';

/** Shape of the SQS message body produced by the package upload service. */
interface ValidationJobEnvelope {
  jobId?: string;
  submissionId?: string;
  kitId?: string;
  packageS3Key?: string;
}

function parseRecord(record: SQSRecord): ValidationJobEnvelope {
  try {
    return JSON.parse(record.body) as ValidationJobEnvelope;
  } catch {
    return { jobId: record.messageId };
  }
}

/**
 * Reconciles the producer envelope (`packageS3Key`) to the transport-agnostic
 * ValidationJobMessage (`packageKey`). `jobId` falls back to the SQS messageId,
 * mirroring the infra worker's `job.jobId ?? fallbackJobId`.
 */
function toMessage(envelope: ValidationJobEnvelope, fallbackJobId: string): ValidationJobMessage {
  return {
    jobId: envelope.jobId ?? fallbackJobId,
    submissionId: envelope.submissionId ?? '',
    kitId: envelope.kitId ?? '',
    packageKey: envelope.packageS3Key ?? '',
  };
}

export function createWorkerHandler(deps: { objectStore: ObjectStore; admin: AdminRepository }) {
  return async (event: SQSEvent): Promise<{ processed: number; result: string }> => {
    for (const record of event.Records) {
      const message = toMessage(parseRecord(record), record.messageId);
      await runValidationJob(message, deps);
    }

    return {
      processed: event.Records.length,
      result: 'validation-jobs-processed',
    };
  };
}

function adminConfigFromEnv() {
  return {
    kitsTableName: requiredEnv('KITS_TABLE_NAME'),
    kitVersionsTableName: requiredEnv('KIT_VERSIONS_TABLE_NAME'),
    submissionsTableName: requiredEnv('SUBMISSIONS_TABLE_NAME'),
    validationJobsTableName: requiredEnv('VALIDATION_JOBS_TABLE_NAME'),
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Lazily builds the AWS deps so the module can be imported (and the handler
 * referenced) without env access until the first invocation — matching the
 * hosted api entrypoint's lazy-adapter pattern.
 */
function createLazyWorkerDeps(): { objectStore: ObjectStore; admin: AdminRepository } {
  let objectStore: ObjectStore | undefined;
  let admin: AdminRepository | undefined;

  return {
    objectStore: new Proxy({} as ObjectStore, {
      get(_target, prop) {
        objectStore ??= createS3ObjectStore({ packageBucketName: requiredEnv('PACKAGE_BUCKET_NAME') });
        return Reflect.get(objectStore, prop, objectStore);
      },
    }),
    admin: new Proxy({} as AdminRepository, {
      get(_target, prop) {
        admin ??= createDynamoAdminRepository(adminConfigFromEnv());
        return Reflect.get(admin, prop, admin);
      },
    }),
  };
}

export const handler = createWorkerHandler(createLazyWorkerDeps());
