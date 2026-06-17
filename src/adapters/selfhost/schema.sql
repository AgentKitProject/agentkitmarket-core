-- Self-host Postgres schema for @agentkitforge/market-core.
--
-- Maps the 5 DynamoDB tables (Kits, KitVersions, Publishers, Submissions,
-- ValidationJobs) to relational tables, preserving the DynamoDB GSIs as indexes.
-- Flexible / nested record fields are stored as jsonb so the row <-> record
-- mapping round-trips faithfully; the DynamoDB TTL `expiresAt` becomes a real
-- `bigint expires_at` (unix seconds) plus a partial index used by the periodic
-- cleanup job and by lazy-expiry queries.
--
-- Idempotent: safe to run on every startup (CREATE TABLE / INDEX IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS kits (
  kit_id              text PRIMARY KEY,
  slug                text NOT NULL,
  name                text NOT NULL,
  summary             text NOT NULL,
  publisher_id        text NOT NULL,
  owner_user_id       text,
  status              text NOT NULL,
  validation_status   text NOT NULL,
  review_status       text NOT NULL,
  current_version     text,
  verification_status text,
  description         text,
  import_url          text,
  download_url        text,
  created_at          text,
  updated_at          text,
  published_at        text,
  removed_at          text,
  downloads           bigint NOT NULL DEFAULT 0,
  featured            boolean,
  featured_rank       integer,
  -- Org ownership + private-catalog visibility (Market Phase 2).
  owner_org_id        text,
  visibility          text,
  -- Tier-2 paid/licensed-kit metadata. All nullable; absent = free behavior.
  pricing             text,
  price_model         text,
  price_cents         bigint,
  currency            text,
  interval            text,
  downloadable        boolean,
  license_type        text,
  license_text        text,
  license_version     text,
  -- nested / flexible fields
  publisher           jsonb,
  categories          jsonb,
  tags                jsonb,
  badges              jsonb,
  required_inputs     jsonb,
  prepared_prompts    jsonb,
  skills              jsonb,
  validation_summary  jsonb,
  latest_version      jsonb
);

-- Dynamo Kits had a unique `slug-index` GSI.
CREATE UNIQUE INDEX IF NOT EXISTS kits_slug_uidx ON kits (slug);

CREATE TABLE IF NOT EXISTS kit_versions (
  kit_id              text NOT NULL,
  version             text NOT NULL,
  file_name           text,
  package_file_name   text,
  package_size_bytes  bigint,
  summary             text,
  schema_version      text,
  published_at        text,
  package_s3_key      text,
  sha256              text,
  content_type        text,
  release_notes       text,
  validation_summary  jsonb,
  validation_result   jsonb,
  PRIMARY KEY (kit_id, version)
);

-- Dynamo KitVersions had a `sha256-index` GSI for dedup lookups.
CREATE INDEX IF NOT EXISTS kit_versions_sha256_idx ON kit_versions (sha256);

CREATE TABLE IF NOT EXISTS publishers (
  publisher_id    text PRIMARY KEY,
  display_name    text NOT NULL,
  handle          text,
  avatar_initials text,
  verified        boolean
);

CREATE UNIQUE INDEX IF NOT EXISTS publishers_handle_uidx ON publishers (handle)
  WHERE handle IS NOT NULL;

CREATE TABLE IF NOT EXISTS submissions (
  submission_id        text PRIMARY KEY,
  kit_id               text NOT NULL,
  version              text,
  publisher_id         text NOT NULL,
  submitted_by_user_id text,
  submitted_by_email   text,
  package_s3_key       text NOT NULL,
  file_name            text,
  package_file_name    text,
  package_size_bytes   bigint,
  sha256               text,
  content_type         text,
  schema_version       text,
  status               text NOT NULL,
  validation_status    text NOT NULL,
  review_status        text NOT NULL,
  submission_type      text,
  target_kit_id        text,
  owner_org_id         text,
  review_notes         text,
  validation_job_id    text,
  -- TTL: unix seconds; cleared (set NULL) once the upload is queued.
  expires_at           bigint,
  reviewed_at          text,
  published_at         text,
  archived_at          text,
  canceled_at          text,
  created_at           text NOT NULL,
  updated_at           text NOT NULL,
  -- nested / flexible fields
  publisher_snapshot   jsonb,
  listing_draft        jsonb NOT NULL,
  validation_summary   jsonb
);

CREATE INDEX IF NOT EXISTS submissions_kit_id_idx ON submissions (kit_id);
CREATE INDEX IF NOT EXISTS submissions_publisher_id_idx ON submissions (publisher_id);
-- Partial index over still-active awaiting_upload rows for the TTL cleanup job.
CREATE INDEX IF NOT EXISTS submissions_active_expiry_idx ON submissions (expires_at)
  WHERE status = 'awaiting_upload' AND expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS validation_jobs (
  job_id         text PRIMARY KEY,
  submission_id  text NOT NULL,
  kit_id         text NOT NULL,
  package_s3_key text NOT NULL,
  status         text NOT NULL,
  started_at     text,
  completed_at   text,
  created_at     text NOT NULL,
  updated_at     text NOT NULL,
  result         jsonb
);

CREATE INDEX IF NOT EXISTS validation_jobs_kit_id_idx ON validation_jobs (kit_id);

-- Upgrade-safe column adds: CREATE TABLE IF NOT EXISTS won't add columns to a
-- pre-existing table, so existing deployments need explicit ALTERs before the
-- index below references them.
ALTER TABLE kits ADD COLUMN IF NOT EXISTS owner_org_id text;
ALTER TABLE kits ADD COLUMN IF NOT EXISTS visibility text;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS owner_org_id text;

-- Tier-2 paid/licensed-kit columns (upgrade-safe).
ALTER TABLE kits ADD COLUMN IF NOT EXISTS pricing text;
ALTER TABLE kits ADD COLUMN IF NOT EXISTS price_model text;
ALTER TABLE kits ADD COLUMN IF NOT EXISTS price_cents bigint;
ALTER TABLE kits ADD COLUMN IF NOT EXISTS currency text;
ALTER TABLE kits ADD COLUMN IF NOT EXISTS interval text;
ALTER TABLE kits ADD COLUMN IF NOT EXISTS downloadable boolean;
ALTER TABLE kits ADD COLUMN IF NOT EXISTS license_type text;
ALTER TABLE kits ADD COLUMN IF NOT EXISTS license_text text;
ALTER TABLE kits ADD COLUMN IF NOT EXISTS license_version text;

-- Index for the private-catalog "list this org's kits" query.
CREATE INDEX IF NOT EXISTS kits_owner_org_id_idx ON kits (owner_org_id);

-- === Organizations (Market Phase 2) ===========================================

CREATE TABLE IF NOT EXISTS organizations (
  org_id                 text PRIMARY KEY,
  slug                   text NOT NULL,
  display_name           text NOT NULL,
  type                   text NOT NULL,
  owner_user_id          text NOT NULL,
  handle                 text,
  avatar_initials        text,
  verified               boolean,
  workos_organization_id text,
  created_at             text NOT NULL,
  updated_at             text NOT NULL
);

-- Dynamo Organizations had a unique slug-index GSI and an ownerUserId-index GSI.
CREATE UNIQUE INDEX IF NOT EXISTS organizations_slug_uidx ON organizations (slug);
CREATE INDEX IF NOT EXISTS organizations_owner_user_id_idx ON organizations (owner_user_id);

CREATE TABLE IF NOT EXISTS org_memberships (
  org_id             text NOT NULL,
  user_id            text NOT NULL,
  role               text NOT NULL,
  status             text NOT NULL,
  invited_by_user_id text,
  created_at         text NOT NULL,
  PRIMARY KEY (org_id, user_id)
);

-- Dynamo OrgMemberships had a userId-index GSI.
CREATE INDEX IF NOT EXISTS org_memberships_user_id_idx ON org_memberships (user_id);

CREATE TABLE IF NOT EXISTS org_invites (
  org_id             text NOT NULL,
  user_id            text NOT NULL,
  email              text,
  role               text NOT NULL,
  invited_by_user_id text NOT NULL,
  created_at         text NOT NULL,
  PRIMARY KEY (org_id, user_id)
);

-- Dynamo OrgInvites had a userId-index GSI.
CREATE INDEX IF NOT EXISTS org_invites_user_id_idx ON org_invites (user_id);

-- === Entitlements (Tier-2 paid/licensed kits) =================================
-- Dynamo EntitlementsTable: PK userId / SK kitId (hot path "does U hold K"),
-- GSI kitId-index (seller/admin analytics). Mirrored here as PK (user_id, kit_id)
-- + index on kit_id.

CREATE TABLE IF NOT EXISTS entitlements (
  entitlement_id        text NOT NULL,
  kit_id                text NOT NULL,
  user_id               text NOT NULL,
  status                text NOT NULL,
  source                text NOT NULL,
  license_version       text NOT NULL,
  license_accepted_at   text NOT NULL,
  license_text_snapshot text NOT NULL,
  granted_at            text NOT NULL,
  expires_at            text,
  stripe_subscription_id text,
  PRIMARY KEY (user_id, kit_id)
);

CREATE INDEX IF NOT EXISTS entitlements_kit_id_idx ON entitlements (kit_id);

-- === Favorites (cloud-synced kit references) ==================================
-- Dynamo FavoritesTable: PK userId / SK kitId. Mirrored here as PK
-- (user_id, kit_id) + index on user_id. References to a Market kit, never a
-- kit copy; cached display metadata is best-effort.

CREATE TABLE IF NOT EXISTS favorites (
  user_id        text NOT NULL,
  kit_id         text NOT NULL,
  slug           text NOT NULL,
  added_at       text NOT NULL,
  display_name   text,
  summary        text,
  publisher_name text,
  PRIMARY KEY (user_id, kit_id)
);

CREATE INDEX IF NOT EXISTS favorites_user_id_idx ON favorites (user_id);

-- Append-only audit log of significant Market mutations. Never updated/deleted.
-- `timestamp` is an ISO-8601 string (sorts lexicographically == chronologically).
CREATE TABLE IF NOT EXISTS audit_logs (
  audit_id      text PRIMARY KEY,
  timestamp     text NOT NULL,
  actor_user_id text NOT NULL,
  actor_email   text,
  actor_type    text NOT NULL,
  action        text NOT NULL,
  target_type   text NOT NULL,
  target_id     text NOT NULL,
  org_id        text,
  metadata      jsonb,
  ip            text
);

CREATE INDEX IF NOT EXISTS audit_logs_timestamp_idx ON audit_logs (timestamp DESC);
CREATE INDEX IF NOT EXISTS audit_logs_actor_user_id_idx ON audit_logs (actor_user_id);
CREATE INDEX IF NOT EXISTS audit_logs_target_idx ON audit_logs (target_type, target_id);
