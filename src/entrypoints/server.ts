/**
 * Self-host HTTP server entrypoint for the market core.
 *
 * THIN adapter, mirroring entrypoints/lambda: it converts a Node `http`
 * IncomingMessage into the router's CoreRequest, invokes the runtime-agnostic
 * `routeRequest` with the self-host (Postgres/MinIO/Redis) adapters, and writes
 * the CoreResponse to the ServerResponse. No web framework — just `node:http`.
 *
 * Composition root: builds the Postgres repositories (running schema.sql on
 * startup), the MinIO object store, and the Redis-backed queue, composes them
 * into the combined PackageUploadService the router expects, and serves.
 *
 * `GET /health` is handled directly (no resource-template matching needed).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { routeRequest } from '../core/routes/index.js';
import type { CoreRequest } from '../core/routes/types.js';
import { EnvConfigProvider, loadSelfHostConfig } from '../core/config.js';
import {
  createPostgresAdminRepository,
  createPostgresCatalogRepository,
  createPostgresOrgRepository,
  type PgPool,
} from '../adapters/selfhost/postgres.js';
import { createMinioObjectStore } from '../adapters/selfhost/objectstore.js';
import { createRedisQueue } from '../adapters/selfhost/queue.js';
import { createSelfHostPackageUploadService } from '../adapters/selfhost/package-upload-service.js';
import { matchRoute } from './route-table.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Locates schema.sql whether running from src (tsx) or compiled dist. */
function readSchemaSql(): string {
  const candidates = [
    join(here, '..', 'adapters', 'selfhost', 'schema.sql'),
    join(here, '..', '..', 'src', 'adapters', 'selfhost', 'schema.sql'),
  ];
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, 'utf8');
    } catch {
      // try next
    }
  }
  throw new Error('Could not locate schema.sql');
}

export interface StartServerResult {
  server: Server;
  close: () => Promise<void>;
}

export async function startServer(): Promise<StartServerResult> {
  const config = loadSelfHostConfig(new EnvConfigProvider());

  const objectStore = createMinioObjectStore({
    endpoint: config.objectStore.endpoint,
    bucket: config.objectStore.bucket,
    region: config.objectStore.region,
    accessKeyId: config.objectStore.accessKeyId,
    secretAccessKey: config.objectStore.secretAccessKey,
    forcePathStyle: config.objectStore.forcePathStyle,
  });

  // A fresh MinIO starts with no buckets, so create the package bucket before
  // serving any submit/validate traffic. Failure here is fatal: without the
  // bucket the upload→validate flow cannot work.
  console.log(`Ensuring object-store bucket "${config.objectStore.bucket}" exists`);
  try {
    await objectStore.ensureBucket();
    console.log(`Object-store bucket "${config.objectStore.bucket}" is ready`);
  } catch (error) {
    throw new Error(`Startup failed: could not ensure object-store bucket: ${String(error)}`);
  }

  const pool = new Pool({ connectionString: config.postgresUrl });
  // Serialize schema init across replicas: concurrent `CREATE TABLE IF NOT EXISTS`
  // from multiple API pods races on pg_type (duplicate-key error). A session-level
  // advisory lock makes only one pod create the schema; the rest no-op.
  const SCHEMA_LOCK_KEY = 778899;
  const schemaClient = await pool.connect();
  try {
    await schemaClient.query('SELECT pg_advisory_lock($1)', [SCHEMA_LOCK_KEY]);
    await schemaClient.query(readSchemaSql());
  } finally {
    await schemaClient.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK_KEY]).catch(() => {});
    schemaClient.release();
  }

  const redis = new Redis(config.redisUrl);
  const queue = createRedisQueue({ client: redis });

  const repository = createPostgresCatalogRepository(pool as unknown as PgPool);
  const adminRepository = createPostgresAdminRepository(pool as unknown as PgPool);
  const orgRepository = createPostgresOrgRepository(pool as unknown as PgPool);
  const packageUploadService = createSelfHostPackageUploadService({ objectStore, queue });

  const allowedOrigins = config.allowedOrigins.length > 0 ? config.allowedOrigins : undefined;

  const server = createServer((req, res) => {
    void handleRequest(req, res, {
      repository,
      adminRepository,
      orgRepository,
      packageUploadService,
      allowedOrigins,
      adminKey: config.adminKey,
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(config.port, () => {
      console.log(`agentkitmarket-core server listening on :${config.port}`);
      resolve();
    });
  });

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await pool.end();
    await redis.quit();
  };

  return { server, close };
}

interface ServerDeps {
  repository: ReturnType<typeof createPostgresCatalogRepository>;
  adminRepository: ReturnType<typeof createPostgresAdminRepository>;
  orgRepository: ReturnType<typeof createPostgresOrgRepository>;
  packageUploadService: ReturnType<typeof createSelfHostPackageUploadService>;
  allowedOrigins?: string[];
  adminKey: string;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  try {
    const coreRequest = await toCoreRequest(req);
    const response = await routeRequest(coreRequest, deps);
    res.writeHead(response.statusCode, response.headers);
    res.end(response.body);
  } catch (error) {
    console.error('Server request handling failed', { error });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Internal server error' }));
  }
}

async function toCoreRequest(req: IncomingMessage): Promise<CoreRequest> {
  const method = req.method ?? 'GET';
  const host = req.headers.host ?? 'localhost';
  const url = new URL(req.url ?? '/', `http://${host}`);

  const queryStringParameters: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) {
    queryStringParameters[key] = value;
  }

  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    headers[key] = Array.isArray(value) ? value.join(',') : value;
  }

  // Map the concrete path to an API Gateway-style resource template + path
  // parameters so the router's resource dispatch works unchanged.
  const { resource, pathParameters } = matchRoute(method, url.pathname);

  const body = method === 'GET' || method === 'HEAD' ? null : await readBody(req);

  return {
    method,
    resource,
    pathParameters,
    queryStringParameters: Object.keys(queryStringParameters).length > 0 ? queryStringParameters : null,
    headers,
    body,
    isBase64Encoded: false,
  };
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : null));
    req.on('error', reject);
  });
}

// Run when executed directly.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  startServer().catch((error) => {
    console.error('Failed to start server', error);
    process.exitCode = 1;
  });
}
