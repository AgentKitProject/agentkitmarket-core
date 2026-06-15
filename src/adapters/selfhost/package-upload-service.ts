/**
 * Self-host PackageUploadService.
 *
 * The core router depends on the combined `PackageUploadService` port. The
 * self-host deployment splits storage and queueing into the cleaner `ObjectStore`
 * (MinIO) and `MessageQueue` (Redis) ports; this factory composes those two back
 * into the combined port the router expects:
 *   - createUploadUrl / createDownloadUrl / packageExists  -> ObjectStore
 *   - enqueueValidationJob                                 -> MessageQueue
 *
 * The enqueue payload matches the AWS adapter's SQS message body exactly.
 */

import type {
  MessageQueue,
  ObjectStore,
  PackageUploadService,
} from '../../core/ports.js';
import type { ValidationJobRecord } from '../../core/types.js';

export interface SelfHostPackageUploadDeps {
  objectStore: ObjectStore;
  queue: MessageQueue;
}

export function createSelfHostPackageUploadService(
  deps: SelfHostPackageUploadDeps,
): PackageUploadService {
  const { objectStore, queue } = deps;

  return {
    createUploadUrl(packageS3Key: string): Promise<string> {
      return objectStore.createUploadUrl(packageS3Key);
    },

    createDownloadUrl(packageS3Key: string): Promise<string> {
      return objectStore.createDownloadUrl(packageS3Key);
    },

    packageExists(packageS3Key: string): Promise<boolean> {
      return objectStore.exists(packageS3Key);
    },

    async enqueueValidationJob(job: ValidationJobRecord): Promise<void> {
      await queue.enqueue({
        jobId: job.jobId,
        submissionId: job.submissionId,
        kitId: job.kitId,
        packageKey: job.packageS3Key,
      });
    },
  };
}
