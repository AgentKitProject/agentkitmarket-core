/**
 * Runs the backend-parametric repository contract against the AWS DynamoDB
 * adapter, backed by `amazon/dynamodb-local`. This is the AWS half of the
 * anti-drift guard: paired with `postgres-repo.test.ts` it proves the AWS and
 * self-host adapters satisfy the SAME behavioral contract.
 *
 * GATING: the whole suite is skipped unless `DYNAMODB_ENDPOINT` is set, so a
 * plain `npm test` on a machine without docker neither runs nor hangs. CI sets
 * `DYNAMODB_ENDPOINT=http://127.0.0.1:8000` against a dynamodb-local service
 * container plus dummy AWS credentials.
 *
 * Table + GSI key schemas mirror the CDK definitions in
 * `agentkitmarket-infra/lib/agentkitmarket-stack.ts` exactly:
 *   - Kits          PK kitId                        GSI slug-index (PK slug)
 *   - KitVersions   PK kitId / SK version           GSI sha256-index (PK sha256)
 *   - Publishers    PK publisherId                  GSI slug-index (PK slug)
 *   - Submissions   PK submissionId                 GSI kitId-index (PK kitId),
 *                                                   GSI publisherId-index (PK publisherId)
 *   - ValidationJobs PK jobId                       GSI kitId-index (PK kitId)
 * All GSIs use ProjectionType.ALL (CDK). dynamodb-local ignores TTL semantics,
 * which is fine: the contract tests TTL via the service rule, not Dynamo expiry.
 */

import { describe } from 'vitest';
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  ListTablesCommand,
  waitUntilTableExists,
  waitUntilTableNotExists,
  type CreateTableCommandInput,
} from '@aws-sdk/client-dynamodb';
import {
  createDynamoCatalogRepository,
  createDynamoAdminRepository,
  createDynamoOrgRepository,
  createDynamoEntitlementRepository,
  createDynamoFavoritesRepository,
  type DynamoClientOverrides,
} from '../src/adapters/aws/index.js';
import { runRepositoryContract, type ContractRepos } from './repository-contract.js';

const endpoint = process.env.DYNAMODB_ENDPOINT;

const TABLES = {
  kits: 'Kits',
  kitVersions: 'KitVersions',
  publishers: 'Publishers',
  submissions: 'Submissions',
  validationJobs: 'ValidationJobs',
  organizations: 'Organizations',
  orgMemberships: 'OrgMemberships',
  orgInvites: 'OrgInvites',
  entitlements: 'Entitlements',
  favorites: 'Favorites',
} as const;

const S = 'S' as const;

const TABLE_DEFINITIONS: CreateTableCommandInput[] = [
  {
    TableName: TABLES.kits,
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [{ AttributeName: 'kitId', KeyType: 'HASH' }],
    AttributeDefinitions: [
      { AttributeName: 'kitId', AttributeType: S },
      { AttributeName: 'slug', AttributeType: S },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'slug-index',
        KeySchema: [{ AttributeName: 'slug', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
  },
  {
    TableName: TABLES.kitVersions,
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [
      { AttributeName: 'kitId', KeyType: 'HASH' },
      { AttributeName: 'version', KeyType: 'RANGE' },
    ],
    AttributeDefinitions: [
      { AttributeName: 'kitId', AttributeType: S },
      { AttributeName: 'version', AttributeType: S },
      { AttributeName: 'sha256', AttributeType: S },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'sha256-index',
        KeySchema: [{ AttributeName: 'sha256', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
  },
  {
    TableName: TABLES.publishers,
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [{ AttributeName: 'publisherId', KeyType: 'HASH' }],
    AttributeDefinitions: [
      { AttributeName: 'publisherId', AttributeType: S },
      { AttributeName: 'slug', AttributeType: S },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'slug-index',
        KeySchema: [{ AttributeName: 'slug', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
  },
  {
    TableName: TABLES.submissions,
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [{ AttributeName: 'submissionId', KeyType: 'HASH' }],
    AttributeDefinitions: [
      { AttributeName: 'submissionId', AttributeType: S },
      { AttributeName: 'kitId', AttributeType: S },
      { AttributeName: 'publisherId', AttributeType: S },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'kitId-index',
        KeySchema: [{ AttributeName: 'kitId', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
      },
      {
        IndexName: 'publisherId-index',
        KeySchema: [{ AttributeName: 'publisherId', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
  },
  {
    TableName: TABLES.validationJobs,
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [{ AttributeName: 'jobId', KeyType: 'HASH' }],
    AttributeDefinitions: [
      { AttributeName: 'jobId', AttributeType: S },
      { AttributeName: 'kitId', AttributeType: S },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'kitId-index',
        KeySchema: [{ AttributeName: 'kitId', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
  },
  {
    TableName: TABLES.organizations,
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [{ AttributeName: 'orgId', KeyType: 'HASH' }],
    AttributeDefinitions: [
      { AttributeName: 'orgId', AttributeType: S },
      { AttributeName: 'slug', AttributeType: S },
      { AttributeName: 'ownerUserId', AttributeType: S },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'slug-index',
        KeySchema: [{ AttributeName: 'slug', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
      },
      {
        IndexName: 'ownerUserId-index',
        KeySchema: [{ AttributeName: 'ownerUserId', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
  },
  {
    TableName: TABLES.orgMemberships,
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [
      { AttributeName: 'orgId', KeyType: 'HASH' },
      { AttributeName: 'userId', KeyType: 'RANGE' },
    ],
    AttributeDefinitions: [
      { AttributeName: 'orgId', AttributeType: S },
      { AttributeName: 'userId', AttributeType: S },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'userId-index',
        KeySchema: [{ AttributeName: 'userId', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
  },
  {
    TableName: TABLES.orgInvites,
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [
      { AttributeName: 'orgId', KeyType: 'HASH' },
      { AttributeName: 'userId', KeyType: 'RANGE' },
    ],
    AttributeDefinitions: [
      { AttributeName: 'orgId', AttributeType: S },
      { AttributeName: 'userId', AttributeType: S },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'userId-index',
        KeySchema: [{ AttributeName: 'userId', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
  },
  {
    // Tier-2: PK userId / SK kitId; GSI kitId-index for seller/admin analytics.
    TableName: TABLES.entitlements,
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [
      { AttributeName: 'userId', KeyType: 'HASH' },
      { AttributeName: 'kitId', KeyType: 'RANGE' },
    ],
    AttributeDefinitions: [
      { AttributeName: 'userId', AttributeType: S },
      { AttributeName: 'kitId', AttributeType: S },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'kitId-index',
        KeySchema: [{ AttributeName: 'kitId', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
  },
  {
    // Favorites: PK userId / SK kitId.
    TableName: TABLES.favorites,
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [
      { AttributeName: 'userId', KeyType: 'HASH' },
      { AttributeName: 'kitId', KeyType: 'RANGE' },
    ],
    AttributeDefinitions: [
      { AttributeName: 'userId', AttributeType: S },
      { AttributeName: 'kitId', AttributeType: S },
    ],
  },
];

if (!endpoint) {
  describe.skip('repository contract [dynamodb] (skipped: set DYNAMODB_ENDPOINT to run against dynamodb-local)', () => {
    // Intentionally empty: nothing runs without a dynamodb-local endpoint.
  });
} else {
  // dynamodb-local accepts any credentials but the SDK still requires them.
  const overrides: DynamoClientOverrides = {
    endpoint,
    region: process.env.AWS_REGION ?? 'us-east-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'dummy',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'dummy',
    },
  };

  const client = new DynamoDBClient({
    endpoint: overrides.endpoint,
    region: overrides.region,
    credentials: overrides.credentials,
  });

  async function dropAllTables(): Promise<void> {
    const existing = (await client.send(new ListTablesCommand({}))).TableNames ?? [];
    for (const def of TABLE_DEFINITIONS) {
      const tableName = def.TableName!;
      if (existing.includes(tableName)) {
        await client.send(new DeleteTableCommand({ TableName: tableName }));
        await waitUntilTableNotExists({ client, maxWaitTime: 30 }, { TableName: tableName });
      }
    }
  }

  async function createAllTables(): Promise<void> {
    for (const def of TABLE_DEFINITIONS) {
      await client.send(new CreateTableCommand(def));
      await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: def.TableName! });
    }
  }

  runRepositoryContract('dynamodb', async (): Promise<ContractRepos> => {
    const catalog = createDynamoCatalogRepository({
      kitsTableName: TABLES.kits,
      kitVersionsTableName: TABLES.kitVersions,
      publishersTableName: TABLES.publishers,
      client: overrides,
    });
    const admin = createDynamoAdminRepository({
      kitsTableName: TABLES.kits,
      kitVersionsTableName: TABLES.kitVersions,
      submissionsTableName: TABLES.submissions,
      validationJobsTableName: TABLES.validationJobs,
      client: overrides,
    });
    const org = createDynamoOrgRepository({
      organizationsTableName: TABLES.organizations,
      orgMembershipsTableName: TABLES.orgMemberships,
      orgInvitesTableName: TABLES.orgInvites,
      kitsTableName: TABLES.kits,
      client: overrides,
    });
    const entitlement = createDynamoEntitlementRepository({
      entitlementsTableName: TABLES.entitlements,
      client: overrides,
    });
    const favorites = createDynamoFavoritesRepository({
      favoritesTableName: TABLES.favorites,
      client: overrides,
    });

    // Recreate tables per reset for a clean slate each test.
    const reset = async (): Promise<void> => {
      await dropAllTables();
      await createAllTables();
    };

    return { catalog, admin, org, entitlement, favorites, reset };
  });
}
