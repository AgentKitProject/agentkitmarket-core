/**
 * Hosted (AWS Lambda) entrypoint for the market core.
 *
 * THIN adapter: converts an APIGatewayProxyEvent into the router's CoreRequest,
 * invokes the runtime-agnostic router with AWS-adapter-backed dependencies, and
 * converts the CoreResponse back into an APIGatewayProxyResult. This is the only
 * place where aws-lambda types and the AWS adapter factories are wired together
 * for the hosted deployment.
 *
 * Behavior is identical to the original agentkitmarket-infra Lambda handler:
 * - `createHandler(options)` keeps the same HandlerOptions shape (so existing
 *   tests inject repositories/services directly), defaulting missing admin/
 *   package services to lazily-created DynamoDB/S3/SQS adapters from env.
 * - The exported `handler` uses lazy env-backed adapters for all three services.
 */

import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from 'aws-lambda';
import type {
  AdminRepository,
  CatalogRepository,
  EntitlementRepository,
  KitPricingUpdate,
  ObjectStore,
  OrgRepository,
  PackageUploadService,
  SubmissionValidationUpdate,
  ValidationJobUpdate,
} from '../core/ports.js';
import type { CatalogDetail, CatalogPage, CreateSubmissionInput, CreateSubmissionResult, Entitlement, GrantEntitlementInput, KitRecord, KitVersionRecord, SubmissionRecord, ValidationJobRecord } from '../core/types.js';
import { routeRequest } from '../core/routes/index.js';
import { matchRoute } from './route-table.js';
import type { CoreRequest } from '../core/routes/types.js';
import {
  createAwsPackageUploadService,
  createDynamoAdminRepository,
  createDynamoCatalogRepository,
  createDynamoEntitlementRepository,
  createDynamoOrgRepository,
  createS3ObjectStore,
} from '../adapters/aws/index.js';

// Re-exported for parity with the original handler module surface (consumed by
// infra tests and the contracts-provider test).
export { buildSubmissionRecord, toPublicKitDetail } from '../core/services/index.js';

interface HandlerOptions {
  repository: CatalogRepository;
  adminRepository?: AdminRepository;
  orgRepository?: OrgRepository;
  entitlementRepository?: EntitlementRepository;
  packageUploadService?: PackageUploadService;
  objectStore?: ObjectStore;
  allowedOrigins?: string[];
  adminKey?: string;
}

export const handler = createHandler({
  repository: createLazyDynamoCatalogRepository(),
  adminRepository: createLazyDynamoAdminRepository(),
  orgRepository: createLazyDynamoOrgRepository(),
  entitlementRepository: createLazyDynamoEntitlementRepository(),
  packageUploadService: createLazyAwsPackageUploadService(),
  objectStore: createLazyS3ObjectStore(),
});

export function createHandler(options: HandlerOptions) {
  return async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const allowedOrigins = options.allowedOrigins ?? parseAllowedOrigins(process.env.API_ALLOWED_ORIGINS);
    const adminKey = options.adminKey ?? process.env.ADMIN_API_KEY;

    // For /admin/* and /users/* routes the original handler lazily built the
    // DynamoDB/S3/SQS services when not injected — and crucially, never read
    // env (or constructed AWS clients) for public read routes. Preserve that by
    // defaulting to LAZY adapters so env is only touched when an admin/user
    // route actually invokes a method.
    const adminRepository = options.adminRepository ?? createLazyDynamoAdminRepository();
    const orgRepository = options.orgRepository ?? createLazyDynamoOrgRepository();
    const entitlementRepository = options.entitlementRepository ?? createLazyDynamoEntitlementRepository();
    const packageUploadService = options.packageUploadService ?? createLazyAwsPackageUploadService();
    const objectStore = options.objectStore ?? createLazyS3ObjectStore();

    const response = await routeRequest(toCoreRequest(event), {
      repository: options.repository,
      adminRepository,
      orgRepository,
      entitlementRepository,
      packageUploadService,
      objectStore,
      allowedOrigins,
      adminKey,
    });

    return {
      statusCode: response.statusCode,
      headers: response.headers,
      body: response.body,
    };
  };
}

function toCoreRequest(event: APIGatewayProxyEvent): CoreRequest {
  // Behind a `{proxy+}` greedy integration `event.resource` is `/{proxy+}` and
  // the real request path lives in `event.path` (or requestContext.path / the
  // HTTP-API `rawPath`). Derive the router's resource template + pathParameters
  // from that path via the same matcher the self-host server uses for ALL routes.
  //
  // Compatibility: the existing infra api-handler tests construct events with a
  // concrete `event.resource` template (and `event.pathParameters`) but no
  // `event.path`. When no usable path is present, fall back to the original
  // `event.resource`/`event.pathParameters` behavior so those tests still pass.
  const rawEvent = event as APIGatewayProxyEvent & {
    requestContext?: { path?: string };
    rawPath?: string;
  };
  const path =
    event.path ?? rawEvent.requestContext?.path ?? rawEvent.rawPath ?? undefined;

  if (path) {
    const matched = matchRoute(event.httpMethod, path);
    return {
      method: event.httpMethod,
      resource: matched.resource,
      pathParameters: matched.pathParameters,
      queryStringParameters: event.queryStringParameters,
      headers: event.headers ?? {},
      body: event.body,
      isBase64Encoded: event.isBase64Encoded,
    };
  }

  return {
    method: event.httpMethod,
    resource: event.resource,
    pathParameters: event.pathParameters,
    queryStringParameters: event.queryStringParameters,
    headers: event.headers ?? {},
    body: event.body,
    isBase64Encoded: event.isBase64Encoded,
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

function orgConfigFromEnv() {
  return {
    organizationsTableName: requiredEnv('ORGANIZATIONS_TABLE_NAME'),
    orgMembershipsTableName: requiredEnv('ORG_MEMBERSHIPS_TABLE_NAME'),
    orgInvitesTableName: requiredEnv('ORG_INVITES_TABLE_NAME'),
    kitsTableName: requiredEnv('KITS_TABLE_NAME'),
  };
}

function entitlementConfigFromEnv() {
  return {
    entitlementsTableName: requiredEnv('ENTITLEMENTS_TABLE_NAME'),
  };
}

function objectStoreConfigFromEnv() {
  return {
    packageBucketName: requiredEnv('PACKAGE_BUCKET_NAME'),
  };
}

function catalogConfigFromEnv() {
  return {
    kitsTableName: requiredEnv('KITS_TABLE_NAME'),
    kitVersionsTableName: requiredEnv('KIT_VERSIONS_TABLE_NAME'),
    publishersTableName: requiredEnv('PUBLISHERS_TABLE_NAME'),
  };
}

function packageConfigFromEnv() {
  return {
    packageBucketName: requiredEnv('PACKAGE_BUCKET_NAME'),
    validationQueueUrl: requiredEnv('VALIDATION_QUEUE_URL'),
  };
}

function createLazyDynamoCatalogRepository(): CatalogRepository {
  let repository: CatalogRepository | undefined;

  const getRepository = (): CatalogRepository => {
    repository ??= createDynamoCatalogRepository(catalogConfigFromEnv());
    return repository;
  };

  return {
    listKits(limit: number, nextToken: string | undefined): Promise<CatalogPage> {
      return getRepository().listKits(limit, nextToken);
    },

    getKitBySlug(slug: string): Promise<CatalogDetail> {
      return getRepository().getKitBySlug(slug);
    },
  };
}

function createLazyDynamoAdminRepository(): AdminRepository {
  let repository: AdminRepository | undefined;

  const getRepository = (): AdminRepository => {
    repository ??= createDynamoAdminRepository(adminConfigFromEnv());
    return repository;
  };

  return {
    createSubmission(input: CreateSubmissionInput): Promise<CreateSubmissionResult> {
      return getRepository().createSubmission(input);
    },

    findActiveDuplicateSubmission(input: CreateSubmissionInput): Promise<SubmissionRecord | undefined> {
      return getRepository().findActiveDuplicateSubmission(input);
    },

    getSubmission(submissionId: string): Promise<SubmissionRecord | undefined> {
      return getRepository().getSubmission(submissionId);
    },

    listSubmissions(): Promise<SubmissionRecord[]> {
      return getRepository().listSubmissions();
    },

    createValidationJob(submission: SubmissionRecord): Promise<ValidationJobRecord> {
      return getRepository().createValidationJob(submission);
    },

    markSubmissionValidationQueued(submissionId: string, validationJobId: string): Promise<void> {
      return getRepository().markSubmissionValidationQueued(submissionId, validationJobId);
    },

    approveSubmission(
      submissionId: string,
      reviewNotes: string | null,
      reviewedAt: string,
    ): Promise<SubmissionRecord | undefined> {
      return getRepository().approveSubmission(submissionId, reviewNotes, reviewedAt);
    },

    rejectSubmission(
      submissionId: string,
      reviewNotes: string,
      reviewedAt: string,
    ): Promise<SubmissionRecord | undefined> {
      return getRepository().rejectSubmission(submissionId, reviewNotes, reviewedAt);
    },

    archiveSubmission(submissionId: string, archivedAt: string): Promise<SubmissionRecord | undefined> {
      return getRepository().archiveSubmission(submissionId, archivedAt);
    },

    cancelSubmission(submissionId: string, canceledAt: string): Promise<SubmissionRecord | undefined> {
      return getRepository().cancelSubmission(submissionId, canceledAt);
    },

    publishSubmission(submission: SubmissionRecord, publishedAt: string): Promise<KitRecord> {
      return getRepository().publishSubmission(submission, publishedAt);
    },

    hideKit(kitId: string): Promise<KitRecord | undefined> {
      return getRepository().hideKit(kitId);
    },

    unhideKit(kitId: string): Promise<KitRecord | undefined> {
      return getRepository().unhideKit(kitId);
    },

    removeKit(kitId: string, removedAt: string): Promise<KitRecord | undefined> {
      return getRepository().removeKit(kitId, removedAt);
    },

    getKit(kitId: string): Promise<KitRecord | undefined> {
      return getRepository().getKit(kitId);
    },

    getKitBySlug(slug: string): Promise<KitRecord | undefined> {
      return getRepository().getKitBySlug(slug);
    },

    setKitPricing(kitId: string, pricing: KitPricingUpdate): Promise<KitRecord | undefined> {
      return getRepository().setKitPricing(kitId, pricing);
    },

    getKitVersion(kitId: string, version: string): Promise<KitVersionRecord | undefined> {
      return getRepository().getKitVersion(kitId, version);
    },

    listKitVersions(kitId: string): Promise<KitVersionRecord[]> {
      return getRepository().listKitVersions(kitId);
    },

    findKitVersionBySha256(sha256: string): Promise<KitVersionRecord | undefined> {
      return getRepository().findKitVersionBySha256(sha256);
    },

    incrementKitDownloads(kitId: string): Promise<void> {
      return getRepository().incrementKitDownloads(kitId);
    },

    updateValidationJob(jobId: string, update: ValidationJobUpdate): Promise<void> {
      return getRepository().updateValidationJob(jobId, update);
    },

    updateSubmissionValidationResult(submissionId: string, update: SubmissionValidationUpdate): Promise<void> {
      return getRepository().updateSubmissionValidationResult(submissionId, update);
    },
  };
}

function createLazyDynamoOrgRepository(): OrgRepository {
  let repository: OrgRepository | undefined;

  const getRepository = (): OrgRepository => {
    repository ??= createDynamoOrgRepository(orgConfigFromEnv());
    return repository;
  };

  return {
    createOrg(input) { return getRepository().createOrg(input); },
    getOrg(orgId) { return getRepository().getOrg(orgId); },
    getOrgBySlug(slug) { return getRepository().getOrgBySlug(slug); },
    ensurePersonalOrg(userId, displayName) { return getRepository().ensurePersonalOrg(userId, displayName); },
    listOrgsForUser(userId) { return getRepository().listOrgsForUser(userId); },
    getMembership(orgId, userId) { return getRepository().getMembership(orgId, userId); },
    listMembers(orgId) { return getRepository().listMembers(orgId); },
    addMember(orgId, userId, role, invitedBy) { return getRepository().addMember(orgId, userId, role, invitedBy); },
    acceptInvite(orgId, userId) { return getRepository().acceptInvite(orgId, userId); },
    listInvitesForUser(userId) { return getRepository().listInvitesForUser(userId); },
    removeMember(orgId, userId) { return getRepository().removeMember(orgId, userId); },
    deleteOrg(orgId) { return getRepository().deleteOrg(orgId); },
    setKitOwnerOrg(kitId, orgId) { return getRepository().setKitOwnerOrg(kitId, orgId); },
    setKitVisibility(kitId, visibility) { return getRepository().setKitVisibility(kitId, visibility); },
    listKitsForOrg(orgId) { return getRepository().listKitsForOrg(orgId); },
  };
}

function createLazyDynamoEntitlementRepository(): EntitlementRepository {
  let repository: EntitlementRepository | undefined;

  const getRepository = (): EntitlementRepository => {
    repository ??= createDynamoEntitlementRepository(entitlementConfigFromEnv());
    return repository;
  };

  return {
    grantEntitlement(input: GrantEntitlementInput): Promise<Entitlement> {
      return getRepository().grantEntitlement(input);
    },
    getEntitlement(userId: string, kitId: string): Promise<Entitlement | undefined> {
      return getRepository().getEntitlement(userId, kitId);
    },
    listEntitlementsForUser(userId: string): Promise<Entitlement[]> {
      return getRepository().listEntitlementsForUser(userId);
    },
    revokeEntitlement(userId: string, kitId: string): Promise<Entitlement | undefined> {
      return getRepository().revokeEntitlement(userId, kitId);
    },
    listEntitlementsForKit(kitId: string): Promise<Entitlement[]> {
      return getRepository().listEntitlementsForKit(kitId);
    },
  };
}

function createLazyS3ObjectStore(): ObjectStore {
  let store: ObjectStore | undefined;

  const getStore = (): ObjectStore => {
    store ??= createS3ObjectStore(objectStoreConfigFromEnv());
    return store;
  };

  return {
    ensureBucket(): Promise<void> {
      return getStore().ensureBucket();
    },
    createUploadUrl(key: string): Promise<string> {
      return getStore().createUploadUrl(key);
    },
    createDownloadUrl(key: string): Promise<string> {
      return getStore().createDownloadUrl(key);
    },
    exists(key: string): Promise<boolean> {
      return getStore().exists(key);
    },
    readStream(key: string): Promise<AsyncIterable<Uint8Array>> {
      return getStore().readStream(key);
    },
  };
}

function createLazyAwsPackageUploadService(): PackageUploadService {
  let service: PackageUploadService | undefined;

  const getService = (): PackageUploadService => {
    service ??= createAwsPackageUploadService(packageConfigFromEnv());
    return service;
  };

  return {
    createUploadUrl(packageS3Key: string): Promise<string> {
      return getService().createUploadUrl(packageS3Key);
    },

    createDownloadUrl(packageS3Key: string): Promise<string> {
      return getService().createDownloadUrl(packageS3Key);
    },

    packageExists(packageS3Key: string): Promise<boolean> {
      return getService().packageExists(packageS3Key);
    },

    enqueueValidationJob(job: ValidationJobRecord): Promise<void> {
      return getService().enqueueValidationJob(job);
    },
  };
}

function parseAllowedOrigins(value: string | undefined): string[] {
  const origins = value
    ?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return origins && origins.length > 0 ? origins : DEFAULT_ALLOWED_ORIGINS;
}

function requiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'https://market.agentkitproject.com',
];
