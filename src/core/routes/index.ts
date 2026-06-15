/**
 * Runtime-agnostic router for the market core.
 *
 * Holds the full route table + handlers extracted verbatim (Phase 1) from
 * agentkitmarket-infra's Lambda handler. Every route, status code, header
 * (including CORS/allowed-origins behavior), error message, and the admin-key
 * auth check is preserved exactly; the only change is that handlers operate on
 * the CoreRequest/CoreResponse abstraction and receive their repositories via the
 * injected RouterDeps instead of module-level singletons.
 *
 * Depends only on ../services, ../ports, and ./types — never on a cloud SDK or
 * aws-lambda. The Lambda entrypoint adapts APIGatewayProxyEvent ⇄ CoreRequest.
 */

import type {
  JsonRecord,
  CreateSubmissionInput,
  KitRecord,
  PublisherRecord,
  SubmissionRecord,
} from '../types.js';
import type {
  AdminRepository,
  CatalogRepository,
  PackageUploadService,
} from '../ports.js';
import type { CoreRequest, CoreResponse, RouterDeps } from './types.js';
import {
  ADMIN_HEADER,
  API_VERSION,
  ARCHIVED_STATUS,
  CANCELED_STATUS,
  DEFAULT_ALLOWED_ORIGINS,
  DOWNLOAD_URL_EXPIRES_IN_SECONDS,
  PUBLIC_REVIEW_STATUS,
  PUBLIC_STATUS,
  PUBLIC_VALIDATION_STATUS,
  REMOVED_STATUS,
  UPLOAD_URL_EXPIRES_IN_SECONDS,
} from '../services/constants.js';
import {
  decodeOffsetCursor,
  encodeOffsetCursor,
  isActiveSubmissionForDuplicateCheck,
  isHiddenFromDefaultReviewQueue,
  isPublicKit,
  normalizedStringArray,
  normalizeFilterValue,
  optionalReviewNotes,
  optionalTrimmedQueryValue,
  parseKitVersion,
  parseLimit,
  parseOptionalBoolean,
  requiredActorUserId,
  requiredReviewNotes,
  resolveCurrentVersionInt,
  safeDownloadFileName,
  searchableKitText,
  sortPublicKits,
  toAdminSubmission,
  toPublicKit,
  toPublicKitDetail,
  validateUploadUrlRequest,
} from '../services/index.js';

interface CatalogQuery {
  limit: number;
  cursor?: string;
  q?: string;
  category?: string;
  tag?: string;
  featured?: boolean;
}

interface AdminSubmissionQuery {
  status?: string;
  validationStatus?: string;
  reviewStatus?: string;
  submittedByEmail?: string;
  submittedByUserId?: string;
  includeArchived: boolean;
  includeHistory: boolean;
  limit: number;
  cursorOffset: number;
}

/**
 * Routes a normalized request to the matching handler. Behavior matches the
 * original `createHandler(...)` returned function exactly: same dispatch order,
 * same admin-key gate for /admin/* and /users/*, same 404/500 fallbacks.
 */
export async function routeRequest(request: CoreRequest, deps: RouterDeps): Promise<CoreResponse> {
  const allowedOrigins = deps.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS;
  const adminKey = deps.adminKey;

  try {
    if (request.method === 'GET' && request.resource === '/health') {
      return json(request, allowedOrigins, 200, {
        ok: true,
        service: 'agentkitmarket-api',
        version: API_VERSION,
      });
    }

    if (request.method === 'GET' && request.resource === '/kits') {
      return getPublicKits(request, deps.repository, allowedOrigins);
    }

    if (request.method === 'GET' && request.resource === '/kits/{slug}') {
      return getPublicKitBySlug(request, deps.repository, allowedOrigins);
    }

    if (request.resource.startsWith('/admin/') || request.resource.startsWith('/users/')) {
      const authFailure = requireAdmin(request, allowedOrigins, adminKey);
      if (authFailure) {
        return authFailure;
      }

      const adminRepository = deps.adminRepository as AdminRepository;
      const packageUploadService = deps.packageUploadService as PackageUploadService;

      if (request.method === 'POST' && request.resource === '/admin/submissions/upload-url') {
        return createSubmissionUploadUrl(request, adminRepository, packageUploadService, allowedOrigins);
      }

      if (request.method === 'POST' && request.resource === '/admin/submissions/{submissionId}/validate') {
        return enqueueSubmissionValidation(request, adminRepository, packageUploadService, allowedOrigins);
      }

      if (request.method === 'POST' && request.resource === '/admin/submissions/{submissionId}/approve') {
        return approveAdminSubmission(request, adminRepository, allowedOrigins);
      }

      if (request.method === 'POST' && request.resource === '/admin/submissions/{submissionId}/reject') {
        return rejectAdminSubmission(request, adminRepository, allowedOrigins);
      }

      if (request.method === 'POST' && request.resource === '/admin/submissions/{submissionId}/archive') {
        return archiveAdminSubmission(request, adminRepository, allowedOrigins);
      }

      if (request.method === 'POST' && request.resource === '/admin/submissions/{submissionId}/remove') {
        return archiveAdminSubmission(request, adminRepository, allowedOrigins);
      }

      if (request.method === 'POST' && request.resource === '/users/submissions/{submissionId}/cancel') {
        return cancelOwnSubmission(request, adminRepository, allowedOrigins);
      }

      if (request.method === 'POST' && request.resource === '/admin/submissions/{submissionId}/publish') {
        return publishAdminSubmission(request, adminRepository, allowedOrigins);
      }

      if (request.method === 'GET' && request.resource === '/admin/submissions') {
        return listAdminSubmissions(request, adminRepository, allowedOrigins);
      }

      if (request.method === 'GET' && request.resource === '/admin/submissions/{submissionId}') {
        return getAdminSubmission(request, adminRepository, allowedOrigins);
      }

      if (request.method === 'POST' && request.resource === '/admin/kits/{kitId}/hide') {
        return hideAdminKit(request, adminRepository, allowedOrigins);
      }

      if (request.method === 'POST' && request.resource === '/admin/kits/{kitId}/unhide') {
        return unhideAdminKit(request, adminRepository, allowedOrigins);
      }

      if (request.method === 'POST' && request.resource === '/admin/kits/{kitId}/remove') {
        return removeAdminKit(request, adminRepository, allowedOrigins);
      }

      if (request.method === 'POST' && request.resource === '/users/kits/{kitId}/remove') {
        return removeOwnKit(request, adminRepository, allowedOrigins);
      }

      if (request.method === 'POST' && request.resource === '/admin/kits/{kitId}/download-url') {
        return createKitDownloadUrlById(request, adminRepository, packageUploadService, allowedOrigins);
      }

      if (request.method === 'POST' && request.resource === '/admin/kits/by-slug/{slug}/download-url') {
        return createKitDownloadUrlBySlug(request, adminRepository, packageUploadService, allowedOrigins);
      }
    }

    return json(request, allowedOrigins, 404, {
      message: 'Not found',
    });
  } catch (error) {
    console.error('Unhandled API error', { error });

    return json(request, allowedOrigins, 500, {
      message: 'Internal server error',
    });
  }
}

async function getPublicKits(
  request: CoreRequest,
  repository: CatalogRepository,
  allowedOrigins: string[],
): Promise<CoreResponse> {
  const query = parseCatalogQuery(request.queryStringParameters);
  if (query instanceof Error) {
    return json(request, allowedOrigins, 400, { message: query.message });
  }

  const page = await repository.listKits(
    query.limit,
    query.cursor,
  );

  const kits = sortPublicKits(filterPublicKits(page.kits, page.publishers, query));

  return json(request, allowedOrigins, 200, {
    items: kits.map((kit) => toPublicKit(kit, page.publishers.get(kit.publisherId))),
    cursor: page.nextToken,
    nextToken: page.nextToken,
  });
}

async function getPublicKitBySlug(
  request: CoreRequest,
  repository: CatalogRepository,
  allowedOrigins: string[],
): Promise<CoreResponse> {
  const slug = request.pathParameters?.slug;

  if (!slug) {
    return json(request, allowedOrigins, 400, {
      message: 'Missing kit slug',
    });
  }

  const detail = await repository.getKitBySlug(slug);

  if (!detail.kit || !isPublicKit(detail.kit)) {
    return json(request, allowedOrigins, 404, {
      message: 'Kit not found',
    });
  }

  return json(request, allowedOrigins, 200, {
    item: toPublicKitDetail(detail.kit, detail.publisher, detail.versions),
  });
}

async function createSubmissionUploadUrl(
  request: CoreRequest,
  adminRepository: AdminRepository,
  packageUploadService: PackageUploadService,
  allowedOrigins: string[],
): Promise<CoreResponse> {
  const body = parseJsonBody(request);
  const validationError = validateUploadUrlRequest(body);
  if (validationError) {
    return json(request, allowedOrigins, 400, { message: validationError });
  }

  const input = body as CreateSubmissionInput;

  if (input.submissionType === 'version_update') {
    if (!input.targetKitId) {
      return json(request, allowedOrigins, 400, { message: 'targetKitId is required for version_update submissions' });
    }

    const targetKit = await adminRepository.getKit(input.targetKitId);
    if (!targetKit) {
      return json(request, allowedOrigins, 404, { message: 'Target kit not found' });
    }

    // Only the kit owner may submit a new version. The app server derives
    // submittedByUserId from the authenticated WorkOS session before calling us.
    if (!input.submittedByUserId || targetKit.ownerUserId !== input.submittedByUserId) {
      return json(request, allowedOrigins, 403, { message: 'Only the kit owner can submit a new version' });
    }

    // The incoming version must itself be a valid positive integer.
    const incomingVersion = parseKitVersion(input.version);
    if (incomingVersion === null) {
      return json(request, allowedOrigins, 400, {
        message: 'version must be a positive integer',
      });
    }

    // Reject a version that is not strictly greater than the kit's current
    // version. Legacy semver current versions are treated as 1; a missing
    // current version is treated as 0 (so v1 is allowed).
    const currentVersionInt = resolveCurrentVersionInt(targetKit.currentVersion);
    if (incomingVersion <= currentVersionInt) {
      return json(request, allowedOrigins, 409, {
        message: `New version must be greater than the current version (${targetKit.currentVersion})`,
      });
    }
  }

  if (input.allowDuplicate !== true) {
    const duplicate = await adminRepository.findActiveDuplicateSubmission(input);
    if (duplicate) {
      return json(request, allowedOrigins, 409, {
        message: 'An active submission already exists for this user, kit, and version',
        submissionId: duplicate.submissionId,
        status: duplicate.status,
        validationStatus: duplicate.validationStatus,
        reviewStatus: duplicate.reviewStatus,
      });
    }
  }

  const result = await adminRepository.createSubmission(input);
  const uploadUrl = await packageUploadService.createUploadUrl(result.submission.packageS3Key);

  return json(request, allowedOrigins, 201, {
    submissionId: result.submission.submissionId,
    kitId: result.submission.kitId,
    uploadUrl,
    packageS3Key: result.submission.packageS3Key,
    expiresIn: UPLOAD_URL_EXPIRES_IN_SECONDS,
  });
}

async function enqueueSubmissionValidation(
  request: CoreRequest,
  adminRepository: AdminRepository,
  packageUploadService: PackageUploadService,
  allowedOrigins: string[],
): Promise<CoreResponse> {
  const submissionId = request.pathParameters?.submissionId;
  if (!submissionId) {
    return json(request, allowedOrigins, 400, { message: 'Missing submissionId' });
  }

  const submission = await adminRepository.getSubmission(submissionId);
  if (!submission) {
    return json(request, allowedOrigins, 404, { message: 'Submission not found' });
  }

  if (!await packageUploadService.packageExists(submission.packageS3Key)) {
    return json(request, allowedOrigins, 400, { message: 'Package object not found' });
  }

  const job = await adminRepository.createValidationJob(submission);
  await packageUploadService.enqueueValidationJob(job);
  await adminRepository.markSubmissionValidationQueued(submissionId, job.jobId);

  return json(request, allowedOrigins, 202, {
    submissionId,
    validationJobId: job.jobId,
    status: 'queued',
  });
}

async function listAdminSubmissions(
  request: CoreRequest,
  adminRepository: AdminRepository,
  allowedOrigins: string[],
): Promise<CoreResponse> {
  const query = parseAdminSubmissionQuery(request.queryStringParameters);
  if (query instanceof Error) {
    return json(request, allowedOrigins, 400, { message: query.message });
  }

  const submissions = await adminRepository.listSubmissions();
  const filtered = filterAdminSubmissions(submissions, query);
  const page = filtered.slice(query.cursorOffset, query.cursorOffset + query.limit);
  const nextOffset = query.cursorOffset + page.length;
  const nextToken = nextOffset < filtered.length ? encodeOffsetCursor(nextOffset) : null;

  return json(request, allowedOrigins, 200, {
    items: page.map(toAdminSubmission),
    cursor: nextToken,
    nextToken,
  });
}

async function getAdminSubmission(
  request: CoreRequest,
  adminRepository: AdminRepository,
  allowedOrigins: string[],
): Promise<CoreResponse> {
  const submissionId = request.pathParameters?.submissionId;
  if (!submissionId) {
    return json(request, allowedOrigins, 400, { message: 'Missing submissionId' });
  }

  const submission = await adminRepository.getSubmission(submissionId);
  if (!submission) {
    return json(request, allowedOrigins, 404, { message: 'Submission not found' });
  }

  return json(request, allowedOrigins, 200, {
    item: toAdminSubmission(submission),
  });
}

async function approveAdminSubmission(
  request: CoreRequest,
  adminRepository: AdminRepository,
  allowedOrigins: string[],
): Promise<CoreResponse> {
  const submissionId = request.pathParameters?.submissionId;
  if (!submissionId) {
    return json(request, allowedOrigins, 400, { message: 'Missing submissionId' });
  }

  const submission = await adminRepository.getSubmission(submissionId);
  if (!submission) {
    return json(request, allowedOrigins, 404, { message: 'Submission not found' });
  }

  if (submission.validationStatus !== PUBLIC_VALIDATION_STATUS) {
    return json(request, allowedOrigins, 400, { message: 'Submission must pass validation before approval' });
  }

  const reviewNotes = optionalReviewNotes(parseJsonBody(request));
  if (reviewNotes instanceof Error) {
    return json(request, allowedOrigins, 400, { message: reviewNotes.message });
  }

  const reviewedAt = new Date().toISOString();
  const approved = await adminRepository.approveSubmission(submissionId, reviewNotes, reviewedAt);

  return json(request, allowedOrigins, 200, {
    item: approved ? toAdminSubmission(approved) : toAdminSubmission({
      ...submission,
      reviewStatus: 'approved',
      reviewNotes,
      reviewedAt,
      updatedAt: reviewedAt,
    }),
  });
}

async function rejectAdminSubmission(
  request: CoreRequest,
  adminRepository: AdminRepository,
  allowedOrigins: string[],
): Promise<CoreResponse> {
  const submissionId = request.pathParameters?.submissionId;
  if (!submissionId) {
    return json(request, allowedOrigins, 400, { message: 'Missing submissionId' });
  }

  const submission = await adminRepository.getSubmission(submissionId);
  if (!submission) {
    return json(request, allowedOrigins, 404, { message: 'Submission not found' });
  }

  const reviewNotes = requiredReviewNotes(parseJsonBody(request));
  if (reviewNotes instanceof Error) {
    return json(request, allowedOrigins, 400, { message: reviewNotes.message });
  }

  const reviewedAt = new Date().toISOString();
  const rejected = await adminRepository.rejectSubmission(submissionId, reviewNotes, reviewedAt);

  return json(request, allowedOrigins, 200, {
    item: rejected ? toAdminSubmission(rejected) : toAdminSubmission({
      ...submission,
      status: 'rejected',
      reviewStatus: 'rejected',
      reviewNotes,
      reviewedAt,
      updatedAt: reviewedAt,
    }),
  });
}

async function archiveAdminSubmission(
  request: CoreRequest,
  adminRepository: AdminRepository,
  allowedOrigins: string[],
): Promise<CoreResponse> {
  const submissionId = request.pathParameters?.submissionId;
  if (!submissionId) {
    return json(request, allowedOrigins, 400, { message: 'Missing submissionId' });
  }

  const submission = await adminRepository.getSubmission(submissionId);
  if (!submission) {
    return json(request, allowedOrigins, 404, { message: 'Submission not found' });
  }

  if (submission.status === PUBLIC_STATUS) {
    return json(request, allowedOrigins, 409, { message: 'Published submissions cannot be archived' });
  }

  const archivedAt = new Date().toISOString();
  const archived = await adminRepository.archiveSubmission(submissionId, archivedAt);

  return json(request, allowedOrigins, 200, {
    item: archived ? toAdminSubmission(archived) : toAdminSubmission({
      ...submission,
      status: ARCHIVED_STATUS,
      archivedAt,
      updatedAt: archivedAt,
    }),
  });
}

async function cancelOwnSubmission(
  request: CoreRequest,
  adminRepository: AdminRepository,
  allowedOrigins: string[],
): Promise<CoreResponse> {
  const submissionId = request.pathParameters?.submissionId;
  if (!submissionId) {
    return json(request, allowedOrigins, 400, { message: 'Missing submissionId' });
  }

  const actorUserId = requiredActorUserId(parseJsonBody(request));
  if (actorUserId instanceof Error) {
    return json(request, allowedOrigins, 400, { message: actorUserId.message });
  }

  const submission = await adminRepository.getSubmission(submissionId);
  if (!submission) {
    return json(request, allowedOrigins, 404, { message: 'Submission not found' });
  }

  if (submission.submittedByUserId !== actorUserId) {
    return json(request, allowedOrigins, 403, { message: 'Forbidden' });
  }

  if (submission.status === PUBLIC_STATUS || submission.reviewStatus !== 'pending') {
    return json(request, allowedOrigins, 409, { message: 'Only pending submissions can be canceled by the submitter' });
  }

  const canceledAt = new Date().toISOString();
  const canceled = await adminRepository.cancelSubmission(submissionId, canceledAt);

  return json(request, allowedOrigins, 200, {
    item: canceled ? toAdminSubmission(canceled) : toAdminSubmission({
      ...submission,
      status: CANCELED_STATUS,
      canceledAt,
      updatedAt: canceledAt,
    }),
  });
}

async function publishAdminSubmission(
  request: CoreRequest,
  adminRepository: AdminRepository,
  allowedOrigins: string[],
): Promise<CoreResponse> {
  const submissionId = request.pathParameters?.submissionId;
  if (!submissionId) {
    return json(request, allowedOrigins, 400, { message: 'Missing submissionId' });
  }

  const submission = await adminRepository.getSubmission(submissionId);
  if (!submission) {
    return json(request, allowedOrigins, 404, { message: 'Submission not found' });
  }

  if (submission.validationStatus !== PUBLIC_VALIDATION_STATUS) {
    return json(request, allowedOrigins, 400, { message: 'Submission must pass validation before publishing' });
  }

  if (submission.reviewStatus !== PUBLIC_REVIEW_STATUS) {
    return json(request, allowedOrigins, 400, { message: 'Submission must be approved before publishing' });
  }

  const isVersionUpdate = submission.submissionType === 'version_update';
  const targetKit = isVersionUpdate
    ? await adminRepository.getKit(submission.targetKitId ?? submission.kitId)
    : undefined;

  if (isVersionUpdate) {
    if (!targetKit) {
      return json(request, allowedOrigins, 404, { message: 'Target kit not found' });
    }

    // Re-verify ownership at publish time, not just at submission time.
    if (!submission.submittedByUserId || targetKit.ownerUserId !== submission.submittedByUserId) {
      return json(request, allowedOrigins, 403, { message: 'Only the kit owner can publish a new version' });
    }

    const incomingVersion = parseKitVersion(submission.version);
    if (incomingVersion === null) {
      return json(request, allowedOrigins, 400, {
        message: 'version must be a positive integer',
      });
    }

    const currentVersionInt = resolveCurrentVersionInt(targetKit.currentVersion);
    if (incomingVersion <= currentVersionInt) {
      return json(request, allowedOrigins, 409, {
        message: `New version must be greater than the current version (${targetKit.currentVersion})`,
      });
    }
  }

  // sha256 duplicate protection. The sha256 here is server-computed by the
  // validation worker (submission.sha256), never the client-provided value, and
  // is authoritative only at/after validation — so this is the correct gate.
  // Reject a byte-identical re-upload of any already-published version.
  if (typeof submission.sha256 === 'string' && submission.sha256.length > 0) {
    const duplicateVersion = await adminRepository.findKitVersionBySha256(submission.sha256);
    if (duplicateVersion && !(duplicateVersion.kitId === submission.kitId && duplicateVersion.version === submission.version)) {
      return json(request, allowedOrigins, 409, {
        message: `This exact package (sha256 ${submission.sha256}) was already published as version ${duplicateVersion.version}`,
        kitId: duplicateVersion.kitId,
        version: duplicateVersion.version,
      });
    }
  }

  const publishedAt = new Date().toISOString();
  const kit = await adminRepository.publishSubmission(submission, publishedAt);

  return json(request, allowedOrigins, 200, {
    item: toPublicKitDetail(kit, undefined, [{
      kitId: kit.kitId,
      version: kit.currentVersion ?? submission.version ?? '0.0.0',
      summary: kit.summary,
      packageSizeBytes: typeof submission.packageSizeBytes === 'number' ? submission.packageSizeBytes : null,
      sha256: submission.sha256,
      publishedAt,
    }]),
  });
}

async function hideAdminKit(
  request: CoreRequest,
  adminRepository: AdminRepository,
  allowedOrigins: string[],
): Promise<CoreResponse> {
  const kitId = request.pathParameters?.kitId;
  if (!kitId) {
    return json(request, allowedOrigins, 400, { message: 'Missing kitId' });
  }

  const kit = await adminRepository.hideKit(kitId);
  if (!kit) {
    return json(request, allowedOrigins, 404, { message: 'Kit not found' });
  }

  return json(request, allowedOrigins, 200, {
    item: {
      kitId: kit.kitId,
      status: kit.status,
      updatedAt: kit.updatedAt ?? null,
    },
  });
}

async function unhideAdminKit(
  request: CoreRequest,
  adminRepository: AdminRepository,
  allowedOrigins: string[],
): Promise<CoreResponse> {
  const kitId = request.pathParameters?.kitId;
  if (!kitId) {
    return json(request, allowedOrigins, 400, { message: 'Missing kitId' });
  }

  const existingKit = await adminRepository.getKit(kitId);
  if (!existingKit) {
    return json(request, allowedOrigins, 404, { message: 'Kit not found' });
  }

  if (existingKit.status !== 'hidden'
    || existingKit.validationStatus !== PUBLIC_VALIDATION_STATUS
    || existingKit.reviewStatus !== PUBLIC_REVIEW_STATUS) {
    return json(request, allowedOrigins, 409, {
      message: 'Only hidden, validated, approved kits can be unhidden',
    });
  }

  const kit = await adminRepository.unhideKit(kitId);

  return json(request, allowedOrigins, 200, {
    item: {
      kitId: kit?.kitId ?? existingKit.kitId,
      status: kit?.status ?? PUBLIC_STATUS,
      updatedAt: kit?.updatedAt ?? new Date().toISOString(),
    },
  });
}

async function removeAdminKit(
  request: CoreRequest,
  adminRepository: AdminRepository,
  allowedOrigins: string[],
): Promise<CoreResponse> {
  const kitId = request.pathParameters?.kitId;
  if (!kitId) {
    return json(request, allowedOrigins, 400, { message: 'Missing kitId' });
  }

  const removedAt = new Date().toISOString();
  const kit = await adminRepository.removeKit(kitId, removedAt);
  if (!kit) {
    return json(request, allowedOrigins, 404, { message: 'Kit not found' });
  }

  return json(request, allowedOrigins, 200, {
    item: {
      kitId: kit.kitId,
      status: kit.status,
      removedAt: kit.removedAt ?? removedAt,
      updatedAt: kit.updatedAt ?? removedAt,
    },
  });
}

async function removeOwnKit(
  request: CoreRequest,
  adminRepository: AdminRepository,
  allowedOrigins: string[],
): Promise<CoreResponse> {
  const kitId = request.pathParameters?.kitId;
  if (!kitId) {
    return json(request, allowedOrigins, 400, { message: 'Missing kitId' });
  }

  const actorUserId = requiredActorUserId(parseJsonBody(request));
  if (actorUserId instanceof Error) {
    return json(request, allowedOrigins, 400, { message: actorUserId.message });
  }

  const existingKit = await adminRepository.getKit(kitId);
  if (!existingKit) {
    return json(request, allowedOrigins, 404, { message: 'Kit not found' });
  }

  if (existingKit.ownerUserId !== actorUserId) {
    return json(request, allowedOrigins, 403, { message: 'Forbidden' });
  }

  const removedAt = new Date().toISOString();
  const kit = await adminRepository.removeKit(kitId, removedAt);

  return json(request, allowedOrigins, 200, {
    item: {
      kitId: kit?.kitId ?? existingKit.kitId,
      status: kit?.status ?? REMOVED_STATUS,
      removedAt: kit?.removedAt ?? removedAt,
      updatedAt: kit?.updatedAt ?? removedAt,
    },
  });
}

async function createKitDownloadUrlById(
  request: CoreRequest,
  adminRepository: AdminRepository,
  packageUploadService: PackageUploadService,
  allowedOrigins: string[],
): Promise<CoreResponse> {
  const kitId = request.pathParameters?.kitId;
  if (!kitId) {
    return json(request, allowedOrigins, 400, { message: 'Missing kitId' });
  }

  const kit = await adminRepository.getKit(kitId);
  return createKitDownloadUrl(request, adminRepository, packageUploadService, allowedOrigins, kit);
}

async function createKitDownloadUrlBySlug(
  request: CoreRequest,
  adminRepository: AdminRepository,
  packageUploadService: PackageUploadService,
  allowedOrigins: string[],
): Promise<CoreResponse> {
  const slug = request.pathParameters?.slug;
  if (!slug) {
    return json(request, allowedOrigins, 400, { message: 'Missing slug' });
  }

  const kit = await adminRepository.getKitBySlug(slug);
  return createKitDownloadUrl(request, adminRepository, packageUploadService, allowedOrigins, kit);
}

async function createKitDownloadUrl(
  request: CoreRequest,
  adminRepository: AdminRepository,
  packageUploadService: PackageUploadService,
  allowedOrigins: string[],
  kit: KitRecord | undefined,
): Promise<CoreResponse> {
  if (!kit || !isPublicKit(kit)) {
    return json(request, allowedOrigins, 404, { message: 'Kit not found' });
  }

  if (!kit.currentVersion) {
    return json(request, allowedOrigins, 409, { message: 'Kit has no current version' });
  }

  const version = await adminRepository.getKitVersion(kit.kitId, kit.currentVersion);
  if (!version?.packageS3Key || typeof version.packageS3Key !== 'string') {
    return json(request, allowedOrigins, 409, { message: 'Kit package is not available' });
  }

  const downloadUrl = await packageUploadService.createDownloadUrl(version.packageS3Key);
  await adminRepository.incrementKitDownloads(kit.kitId);

  return json(request, allowedOrigins, 200, {
    kitId: kit.kitId,
    slug: kit.slug,
    version: version.version,
    fileName: version.packageFileName ?? safeDownloadFileName(kit.slug, version.version),
    packageSizeBytes: typeof version.packageSizeBytes === 'number' ? version.packageSizeBytes : null,
    sha256: typeof version.sha256 === 'string' ? version.sha256 : null,
    downloadUrl,
    expiresIn: DOWNLOAD_URL_EXPIRES_IN_SECONDS,
  });
}

function requireAdmin(
  request: CoreRequest,
  allowedOrigins: string[],
  adminKey: string | undefined,
): CoreResponse | null {
  if (!adminKey) {
    return json(request, allowedOrigins, 500, {
      message: 'Admin API key is not configured',
    });
  }

  const providedKey = headerValue(request, ADMIN_HEADER);
  if (!providedKey || providedKey !== adminKey) {
    return json(request, allowedOrigins, 401, {
      message: 'Unauthorized',
    });
  }

  return null;
}

function parseJsonBody(request: CoreRequest): unknown {
  if (!request.body) {
    return undefined;
  }

  try {
    const body = request.isBase64Encoded
      ? Buffer.from(request.body, 'base64').toString('utf8')
      : request.body;
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function headerValue(request: CoreRequest, name: string): string | undefined {
  const lowerName = name.toLowerCase();
  for (const [headerName, value] of Object.entries(request.headers ?? {})) {
    if (headerName.toLowerCase() === lowerName) {
      return value;
    }
  }

  return undefined;
}

function parseCatalogQuery(query: CoreRequest['queryStringParameters']): CatalogQuery | Error {
  const limitValue = query?.limit;
  if (limitValue !== undefined && !/^\d+$/.test(limitValue)) {
    return new Error('limit must be a positive integer');
  }
  if (limitValue !== undefined && Number.parseInt(limitValue, 10) < 1) {
    return new Error('limit must be a positive integer');
  }

  const limit = parseLimit(limitValue);
  const q = optionalTrimmedQueryValue(query?.q, 'q');
  if (q instanceof Error) {
    return q;
  }

  const category = optionalTrimmedQueryValue(query?.category, 'category');
  if (category instanceof Error) {
    return category;
  }

  const tag = optionalTrimmedQueryValue(query?.tag, 'tag');
  if (tag instanceof Error) {
    return tag;
  }

  const featured = parseOptionalBoolean(query?.featured, 'featured');
  if (featured instanceof Error) {
    return featured;
  }

  const cursor = query?.cursor ?? query?.nextToken;

  return {
    limit,
    cursor,
    q,
    category,
    tag,
    featured,
  };
}

function parseAdminSubmissionQuery(query: CoreRequest['queryStringParameters']): AdminSubmissionQuery | Error {
  const limitValue = query?.limit;
  if (limitValue !== undefined && !/^\d+$/.test(limitValue)) {
    return new Error('limit must be a positive integer');
  }
  if (limitValue !== undefined && Number.parseInt(limitValue, 10) < 1) {
    return new Error('limit must be a positive integer');
  }

  const status = optionalTrimmedQueryValue(query?.status, 'status');
  if (status instanceof Error) {
    return status;
  }

  const validationStatus = optionalTrimmedQueryValue(query?.validationStatus, 'validationStatus');
  if (validationStatus instanceof Error) {
    return validationStatus;
  }

  const reviewStatus = optionalTrimmedQueryValue(query?.reviewStatus, 'reviewStatus');
  if (reviewStatus instanceof Error) {
    return reviewStatus;
  }

  const submittedByEmail = optionalTrimmedQueryValue(query?.submittedByEmail, 'submittedByEmail');
  if (submittedByEmail instanceof Error) {
    return submittedByEmail;
  }

  const submittedByUserId = optionalTrimmedQueryValue(query?.submittedByUserId, 'submittedByUserId');
  if (submittedByUserId instanceof Error) {
    return submittedByUserId;
  }

  const includeArchived = parseOptionalBoolean(query?.includeArchived, 'includeArchived');
  if (includeArchived instanceof Error) {
    return includeArchived;
  }

  const includeHistory = parseOptionalBoolean(query?.includeHistory, 'includeHistory');
  if (includeHistory instanceof Error) {
    return includeHistory;
  }

  const cursorOffset = decodeOffsetCursor(query?.cursor ?? query?.nextToken);
  if (cursorOffset instanceof Error) {
    return cursorOffset;
  }

  return {
    status,
    validationStatus,
    reviewStatus,
    submittedByEmail,
    submittedByUserId,
    includeArchived: includeArchived ?? false,
    includeHistory: includeHistory ?? includeArchived ?? false,
    limit: parseLimit(limitValue),
    cursorOffset,
  };
}

function filterAdminSubmissions(
  submissions: SubmissionRecord[],
  query: AdminSubmissionQuery,
): SubmissionRecord[] {
  const nowMs = Date.now();
  return submissions
    .filter((submission) => query.includeHistory || !isHiddenFromDefaultReviewQueue(submission, nowMs))
    .filter((submission) => !query.status || submission.status === query.status)
    .filter((submission) => !query.validationStatus || submission.validationStatus === query.validationStatus)
    .filter((submission) => !query.reviewStatus || submission.reviewStatus === query.reviewStatus)
    .filter((submission) => !query.submittedByEmail
      || normalizeFilterValue(submission.submittedByEmail ?? '') === normalizeFilterValue(query.submittedByEmail))
    .filter((submission) => !query.submittedByUserId || submission.submittedByUserId === query.submittedByUserId)
    .sort((left, right) => (right.createdAt ?? right.updatedAt).localeCompare(left.createdAt ?? left.updatedAt));
}

function filterPublicKits(
  kits: KitRecord[],
  publishers: Map<string, PublisherRecord>,
  query: CatalogQuery,
): KitRecord[] {
  return kits
    .filter(isPublicKit)
    .filter((kit) => query.featured === undefined || (kit.featured === true) === query.featured)
    .filter((kit) => !query.category || normalizedStringArray(kit.categories).includes(normalizeFilterValue(query.category)))
    .filter((kit) => !query.tag || normalizedStringArray(kit.tags).includes(normalizeFilterValue(query.tag)))
    .filter((kit) => !query.q || searchableKitText(kit, publishers.get(kit.publisherId)).includes(normalizeFilterValue(query.q)));
}

function json(
  request: CoreRequest,
  allowedOrigins: string[],
  statusCode: number,
  body: JsonRecord,
): CoreResponse {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(request, allowedOrigins),
    },
    body: JSON.stringify(body),
  };
}

function corsHeaders(request: CoreRequest, allowedOrigins: string[]): Record<string, string> {
  const origin = request.headers.origin ?? request.headers.Origin;
  const allowOrigin = origin && allowedOrigins.includes(origin)
    ? origin
    : (allowedOrigins[0] ?? '');

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': `Content-Type,Authorization,${ADMIN_HEADER}`,
    'Vary': 'Origin',
  };
}
