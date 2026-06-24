/**
 * Self-host validation worker entrypoint.
 *
 * Subscribes to the Redis-backed MessageQueue and runs `runValidationJob` for
 * each ValidationJobMessage, using the self-host adapters (MinIO object store +
 * Postgres admin repository). Mirrors entrypoints/lambda-worker (the hosted SQS
 * worker) — the only differences are the queue + storage backends.
 */

import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { EnvConfigProvider, loadSelfHostConfig } from '../core/config.js';
import { runValidationJob } from '../core/services/validation.js';
import { createPostgresAdminRepository, type PgPool } from '../adapters/selfhost/postgres.js';
import { createMinioObjectStore } from '../adapters/selfhost/objectstore.js';
import { createRedisQueue, type RedisQueue } from '../adapters/selfhost/queue.js';

export interface StartWorkerResult {
  queue: RedisQueue;
  close: () => Promise<void>;
}

export async function startWorker(): Promise<StartWorkerResult> {
  const config = loadSelfHostConfig(new EnvConfigProvider());

  const pool = new Pool({ connectionString: config.postgresUrl });
  const admin = createPostgresAdminRepository(pool as unknown as PgPool);

  const objectStore = createMinioObjectStore({
    endpoint: config.objectStore.endpoint,
    publicEndpoint: config.objectStore.publicEndpoint,
    bucket: config.objectStore.bucket,
    region: config.objectStore.region,
    accessKeyId: config.objectStore.accessKeyId,
    secretAccessKey: config.objectStore.secretAccessKey,
    forcePathStyle: config.objectStore.forcePathStyle,
  });

  const redis = new Redis(config.redisUrl);
  const queue = createRedisQueue({ client: redis });

  console.log('agentkitmarket-core worker subscribing to validation queue');
  // subscribe() loops until queue.stop(); kick it off without awaiting so the
  // caller can manage shutdown.
  void queue.subscribe((message) => runValidationJob(message, { objectStore, admin }));

  const close = async (): Promise<void> => {
    queue.stop();
    await pool.end();
    await redis.quit();
  };

  return { queue, close };
}

// Run when executed directly.
import { fileURLToPath } from 'node:url';
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  startWorker().catch((error) => {
    console.error('Failed to start worker', error);
    process.exitCode = 1;
  });
}
