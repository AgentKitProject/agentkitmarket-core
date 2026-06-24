/**
 * Configuration for the market core, sourced per runtime.
 *
 * `EnvConfigProvider` implements the `ConfigProvider` port over `process.env`.
 * `loadSelfHostConfig` reads the typed configuration the self-host container
 * entrypoints (server + worker) need: Postgres, S3/MinIO object store, Redis,
 * allowed CORS origins, and the admin key.
 *
 * Cloud-free: this module only reads environment variables; it constructs no
 * SDK clients.
 */

import type { ConfigProvider } from './ports.js';

/** ConfigProvider over `process.env`. */
export class EnvConfigProvider implements ConfigProvider {
  private readonly env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
  }

  get(key: string, required = false): string | undefined {
    const value = this.env[key];
    if (required && (value === undefined || value === '')) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
    return value === '' ? undefined : value;
  }
}

/** Object-store (S3/MinIO) configuration for the self-host deployment. */
export interface SelfHostObjectStoreConfig {
  /** S3-compatible endpoint, e.g. `http://minio:9000`. */
  endpoint: string;
  /**
   * Public S3-compatible endpoint used ONLY for presigned URLs handed to
   * clients; undefined when unset (presign falls back to `endpoint`).
   */
  publicEndpoint?: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

/** Fully-resolved self-host configuration. */
export interface SelfHostConfig {
  /** Postgres connection string. */
  postgresUrl: string;
  objectStore: SelfHostObjectStoreConfig;
  /** Redis connection string, e.g. `redis://redis:6379`. */
  redisUrl: string;
  /** Allowed CORS origins; empty -> router default. */
  allowedOrigins: string[];
  /** Admin API key gating /admin/* and /users/* routes. */
  adminKey: string;
  /** HTTP listen port for the server entrypoint. */
  port: number;
}

/**
 * Reads + validates the self-host configuration from a ConfigProvider. Throws on
 * any missing required value so the container fails fast on misconfiguration.
 */
export function loadSelfHostConfig(config: ConfigProvider): SelfHostConfig {
  const allowedOrigins = (config.get('API_ALLOWED_ORIGINS') ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  const portValue = config.get('PORT');
  const port = portValue ? Number.parseInt(portValue, 10) : 8080;

  return {
    postgresUrl: config.get('DATABASE_URL', true)!,
    objectStore: {
      endpoint: config.get('S3_ENDPOINT', true)!,
      publicEndpoint: config.get('S3_PUBLIC_ENDPOINT'),
      bucket: config.get('PACKAGE_BUCKET_NAME', true)!,
      region: config.get('S3_REGION') ?? 'us-east-1',
      accessKeyId: config.get('S3_ACCESS_KEY_ID', true)!,
      secretAccessKey: config.get('S3_SECRET_ACCESS_KEY', true)!,
      forcePathStyle: (config.get('S3_FORCE_PATH_STYLE') ?? 'true') !== 'false',
    },
    redisUrl: config.get('REDIS_URL', true)!,
    allowedOrigins,
    adminKey: config.get('ADMIN_API_KEY', true)!,
    port: Number.isFinite(port) ? port : 8080,
  };
}
