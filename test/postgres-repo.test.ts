/**
 * Runs the backend-parametric repository contract against the Postgres self-host
 * adapters, backed by pg-mem (an in-memory Postgres) so the suite needs NO
 * external services / docker. A future CI job can run the same
 * `runRepositoryContract` against a real Postgres and against the AWS adapter on
 * DynamoDB-local.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { newDb } from 'pg-mem';
import {
  createPostgresCatalogRepository,
  createPostgresAdminRepository,
  createPostgresOrgRepository,
  createPostgresEntitlementRepository,
  createPostgresFavoritesRepository,
  createPostgresAuditRepository,
  type PgPool,
} from '../src/adapters/selfhost/postgres.js';
import { runRepositoryContract, type ContractRepos } from './repository-contract.js';

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(
  join(here, '..', 'src', 'adapters', 'selfhost', 'schema.sql'),
  'utf8',
);

// pg-mem mutates the same in-memory DB if reused, and re-running the idempotent
// schema.sql against a dropped table trips a pg-mem bug where the implicit
// `<table>_pkey` index name is not released on DROP. So `reset` builds a brand
// new pg-mem database + Pool each time and re-wires the repos against it. The
// contract suite only reads `repos.catalog`/`repos.admin` after `reset`, so we
// expose mutable proxies that always delegate to the current pool.
runRepositoryContract('postgres (pg-mem)', async (): Promise<ContractRepos> => {
  let catalog = undefined as unknown as ReturnType<typeof createPostgresCatalogRepository>;
  let admin = undefined as unknown as ReturnType<typeof createPostgresAdminRepository>;
  let orgRepo = undefined as unknown as ReturnType<typeof createPostgresOrgRepository>;
  let entitlementRepo = undefined as unknown as ReturnType<typeof createPostgresEntitlementRepository>;
  let favoritesRepo = undefined as unknown as ReturnType<typeof createPostgresFavoritesRepository>;
  let auditRepo = undefined as unknown as ReturnType<typeof createPostgresAuditRepository>;

  const reset = async (): Promise<void> => {
    const db = newDb();
    const { Pool } = db.adapters.createPg();
    const pool = new Pool() as unknown as PgPool;
    await pool.query(schemaSql);
    catalog = createPostgresCatalogRepository(pool);
    admin = createPostgresAdminRepository(pool);
    orgRepo = createPostgresOrgRepository(pool);
    entitlementRepo = createPostgresEntitlementRepository(pool);
    favoritesRepo = createPostgresFavoritesRepository(pool);
    auditRepo = createPostgresAuditRepository(pool);
  };

  await reset();

  return {
    get catalog() { return catalog; },
    get admin() { return admin; },
    get org() { return orgRepo; },
    get entitlement() { return entitlementRepo; },
    get favorites() { return favoritesRepo; },
    get audit() { return auditRepo; },
    reset,
  };
});
