/**
 * Self-host adapters for the market core ports: Postgres (data access), MinIO
 * (object store), and Redis (message queue). Behaviorally identical to the AWS
 * adapters (proven by the backend-parametric repository contract suite); the
 * only differences are the backing services.
 */

export {
  createPostgresCatalogRepository,
  createPostgresAdminRepository,
} from './postgres.js';
export type { PgPool, PgPoolClient, PgQueryable } from './postgres.js';

export { createMinioObjectStore } from './objectstore.js';
export type { MinioObjectStoreConfig } from './objectstore.js';

export { createRedisQueue } from './queue.js';
export type { RedisClient, RedisQueue, RedisQueueConfig } from './queue.js';

export { createSelfHostPackageUploadService } from './package-upload-service.js';
export type { SelfHostPackageUploadDeps } from './package-upload-service.js';
