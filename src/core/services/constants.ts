/**
 * Domain constants shared by the market core. Moved verbatim (Phase 1) from
 * agentkitmarket-infra's Lambda handler so the status strings, limits, TTLs, and
 * retention windows have a single home. Pure values only — no cloud SDK.
 */

export const API_VERSION = '0.1.0';
export const PUBLIC_STATUS = 'published';
export const PUBLIC_VALIDATION_STATUS = 'passed';
export const PUBLIC_REVIEW_STATUS = 'approved';
export const ARCHIVED_STATUS = 'archived';
export const CANCELED_STATUS = 'canceled';
export const REMOVED_STATUS = 'removed';
export const REVIEW_QUEUE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
// Never-finished awaiting_upload submissions auto-expire ~1h after creation.
// DynamoDB TTL ('expiresAt') sweeps them server-side; we also treat any
// awaiting_upload older than this as expired in app logic (lazy expiry) because
// the TTL sweep can lag up to ~48h and must not block a re-submit in the meantime.
export const AWAITING_UPLOAD_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;
export const ADMIN_HEADER = 'x-agentkitmarket-admin-key';
export const UPLOAD_URL_EXPIRES_IN_SECONDS = 900;
export const DOWNLOAD_URL_EXPIRES_IN_SECONDS = 300;
export const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'https://market.agentkitproject.com',
];
