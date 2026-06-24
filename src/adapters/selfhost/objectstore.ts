/**
 * MinIO object store adapter (self-host deployment).
 *
 * MinIO is S3-compatible, so this reuses the same `@aws-sdk/client-s3` +
 * `@aws-sdk/s3-request-presigner` already depended on by the AWS adapter. The
 * only differences are an explicit `endpoint` (the MinIO URL) and
 * `forcePathStyle: true` (MinIO serves buckets path-style, not vhost-style).
 *
 * Presign expiries and the upload content-type are kept IDENTICAL to the AWS S3
 * code so the two deployments behave the same.
 */

import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ObjectStore } from '../../core/ports.js';
import {
  DOWNLOAD_URL_EXPIRES_IN_SECONDS,
  UPLOAD_URL_EXPIRES_IN_SECONDS,
} from '../../core/services/constants.js';

export interface MinioObjectStoreConfig {
  /** MinIO endpoint, e.g. `http://minio:9000`. */
  endpoint: string;
  /**
   * Public S3/MinIO endpoint used ONLY for generating presigned URLs handed to
   * clients; defaults to `endpoint` when unset.
   */
  publicEndpoint?: string;
  bucket: string;
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Path-style addressing; required for MinIO. Defaults to true. */
  forcePathStyle?: boolean;
}

export function createMinioObjectStore(config: MinioObjectStoreConfig): ObjectStore {
  const bucket = config.bucket;
  const s3 = new S3Client({
    endpoint: config.endpoint,
    region: config.region ?? 'us-east-1',
    forcePathStyle: config.forcePathStyle ?? true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  // Separate client for presigning: presigned URLs are handed to external
  // clients, so they must point at the PUBLIC endpoint. When `publicEndpoint`
  // is unset this is configured identically to `s3`, so behavior is unchanged.
  const s3Presign = new S3Client({
    endpoint: config.publicEndpoint ?? config.endpoint,
    region: config.region ?? 'us-east-1',
    forcePathStyle: config.forcePathStyle ?? true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  return {
    async ensureBucket(): Promise<void> {
      // Fast path: bucket already present.
      try {
        await s3.send(new HeadBucketCommand({ Bucket: bucket }));
        return;
      } catch {
        // Fall through to create. A 404/NotFound is expected on a fresh MinIO.
      }

      try {
        await s3.send(new CreateBucketCommand({ Bucket: bucket }));
      } catch (error) {
        // Tolerate the race / re-run where the bucket already exists or is
        // already owned by this account.
        const name = (error as { name?: string; Code?: string })?.name
          ?? (error as { Code?: string })?.Code;
        if (name === 'BucketAlreadyOwnedByYou' || name === 'BucketAlreadyExists') {
          return;
        }
        throw new Error(`Failed to ensure object-store bucket "${bucket}": ${String(error)}`);
      }
    },

    createUploadUrl(key: string): Promise<string> {
      return getSignedUrl(s3Presign, new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: 'application/zip',
      }), {
        expiresIn: UPLOAD_URL_EXPIRES_IN_SECONDS,
      });
    },

    createDownloadUrl(key: string): Promise<string> {
      return getSignedUrl(s3Presign, new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      }), {
        expiresIn: DOWNLOAD_URL_EXPIRES_IN_SECONDS,
      });
    },

    async exists(key: string): Promise<boolean> {
      try {
        await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
      } catch (error) {
        console.warn('Package object lookup failed', { key, error });
        return false;
      }
    },

    async readStream(key: string): Promise<AsyncIterable<Uint8Array>> {
      const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const body = result.Body;
      if (!body) {
        throw new Error(`Object not found: ${key}`);
      }
      // The SDK Node stream is an AsyncIterable<Uint8Array>.
      return body as AsyncIterable<Uint8Array>;
    },
  };
}
