/**
 * Runtime-agnostic request/response abstraction for the market core router.
 *
 * The hosted Lambda entrypoint converts an APIGatewayProxyEvent into a
 * CoreRequest and converts the CoreResponse back into an APIGatewayProxyResult.
 * The self-host server entrypoint (Phase 3) does the same with a plain HTTP
 * request. The router and route handlers depend only on these shapes — never on
 * aws-lambda types.
 */

import type {
  AdminRepository,
  CatalogRepository,
  EntitlementRepository,
  ObjectStore,
  OrgRepository,
  PackageUploadService,
} from '../ports.js';

/** A normalized inbound request, decoupled from any HTTP/Lambda runtime. */
export interface CoreRequest {
  method: string;
  /** The matched route template, e.g. '/kits/{slug}' (API Gateway `resource`). */
  resource: string;
  /** Path parameters, e.g. { slug: 'my-kit' }. */
  pathParameters: Record<string, string | undefined> | null;
  /** Query-string parameters. */
  queryStringParameters: Record<string, string | undefined> | null;
  /** Request headers (case-insensitive lookup is performed by the router). */
  headers: Record<string, string | undefined>;
  /** Already-decoded raw request body string (or null). */
  body: string | null;
  /** Whether `body` is base64-encoded (Lambda may set this). */
  isBase64Encoded?: boolean;
}

/** A normalized response the entrypoint serializes for its runtime. */
export interface CoreResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

/** Dependencies injected into the router (repositories/services + config). */
export interface RouterDeps {
  repository: CatalogRepository;
  adminRepository?: AdminRepository;
  orgRepository?: OrgRepository;
  /** Tier-2 buyer entitlements (paid kits). */
  entitlementRepository?: EntitlementRepository;
  packageUploadService?: PackageUploadService;
  /** Object store for reading kit packages (Tier-2 watermarked licensed-package fetch). */
  objectStore?: ObjectStore;
  allowedOrigins?: string[];
  adminKey?: string;
}
