/**
 * Domain types for the AgentKitMarket backend core.
 *
 * Moved verbatim from agentkitmarket-infra's Lambda handler in Phase 1 so the
 * record/value shapes have a single home shared by both deployments. These are
 * pure data types — no cloud SDK, no runtime coupling.
 */

export type JsonRecord = Record<string, unknown>;

/** Org-member role. Mirrors `OrgRole` in @agentkitforge/contracts. */
export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer';

/** Membership lifecycle. Mirrors `OrgMembershipStatus` in @agentkitforge/contracts. */
export type OrgMembershipStatus = 'active' | 'invited' | 'removed';

/** Organization type. Mirrors `OrgType` in @agentkitforge/contracts. */
export type OrgType = 'personal' | 'team';

/** Kit visibility. Mirrors `KitVisibility` in @agentkitforge/contracts. */
export type KitVisibility = 'public' | 'private';

/** Whether a kit is free or paid (Tier-2). Mirrors `KitPricing` in @agentkitforge/contracts. */
export type KitPricing = 'free' | 'paid';

/** Pricing model for a paid kit. Mirrors `PriceModel` in @agentkitforge/contracts. */
export type PriceModel = 'one_time' | 'subscription';

/** Billing interval for a subscription kit. Mirrors `PriceInterval` in @agentkitforge/contracts. */
export type PriceInterval = 'month' | 'year';

/** Which license applies to a kit. Mirrors `LicenseType` in @agentkitforge/contracts. */
export type LicenseType = 'default' | 'custom';

/** Entitlement lifecycle. Mirrors `EntitlementStatus` in @agentkitforge/contracts. */
export type EntitlementStatus = 'active' | 'revoked' | 'expired';

/** How an entitlement was acquired. Mirrors `EntitlementSource` in @agentkitforge/contracts. */
export type EntitlementSource = 'purchase' | 'admin_grant' | 'free';

/**
 * A buyer's right to use a specific paid (or free, when explicitly granted) kit.
 * Mirrors `Entitlement` in @agentkitforge/contracts. The license text the buyer
 * accepted is snapshotted so a later license change does not rewrite history.
 */
export interface Entitlement {
  entitlementId: string;
  kitId: string;
  userId: string;
  status: EntitlementStatus;
  source: EntitlementSource;
  licenseVersion: string;
  licenseAcceptedAt: string;
  licenseTextSnapshot: string;
  grantedAt: string;
  /** For subscriptions; absent for one-time/free. */
  expiresAt?: string;
  /** Nullable; populated by the Phase B Stripe webhook. Never read in core. */
  stripeSubscriptionId?: string | null;
}

/** Input to grant (or idempotently re-grant) an entitlement. */
export interface GrantEntitlementInput {
  kitId: string;
  userId: string;
  source: EntitlementSource;
  licenseVersion: string;
  licenseAcceptedAt: string;
  licenseTextSnapshot: string;
  expiresAt?: string;
  stripeSubscriptionId?: string | null;
}

/** An organization that can own kits. Mirrors `Organization` in @agentkitforge/contracts. */
export interface Organization {
  orgId: string;
  slug: string;
  displayName: string;
  type: OrgType;
  ownerUserId: string;
  handle?: string;
  avatarInitials?: string;
  verified?: boolean;
  /** WorkOS Organization ID — null until SSO is configured (future). */
  workosOrganizationId?: string | null;
  /**
   * Stripe Connect seller-payout fields. Stored/returned by core only; all Stripe
   * API calls (account create, account links, account.updated) live in market-app.
   * `stripeAccountId` is the org's Express connected-account id; chargesEnabled/
   * payoutsEnabled mirror the connected account's capability state; payoutOnboardedAt
   * is stamped the first time payouts become enabled.
   */
  stripeAccountId?: string;
  chargesEnabled?: boolean;
  payoutsEnabled?: boolean;
  payoutOnboardedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** A user's membership in an org. Mirrors `OrgMembership` in @agentkitforge/contracts. */
export interface OrgMembership {
  orgId: string;
  userId: string;
  role: OrgRole;
  status: OrgMembershipStatus;
  invitedByUserId?: string;
  createdAt: string;
}

/** A pending org invite. Mirrors `OrgInvite` in @agentkitforge/contracts. */
export interface OrgInvite {
  orgId: string;
  userId?: string;
  email?: string;
  role: OrgRole;
  invitedByUserId: string;
  createdAt: string;
}

/**
 * A cloud-synced reference to a Market kit. Mirrors `Favorite` in
 * @agentkitforge/contracts. Never a copy of kit contents; cached display
 * metadata is optional/best-effort.
 */
export interface Favorite {
  userId: string;
  kitId: string;
  slug: string;
  addedAt: string;
  displayName?: string;
  summary?: string;
  publisherName?: string;
}

/** Cached display metadata + identity for a favorite, resolved at add time. */
export interface AddFavoriteInput {
  kitId: string;
  slug: string;
  displayName?: string;
  summary?: string;
  publisherName?: string;
}

/** Audit actor classification. Mirrors `AuditActorType` in @agentkitforge/contracts. */
export type AuditActorType = 'user' | 'admin' | 'system';

/** Audit target classification. Mirrors `AuditTargetType` in @agentkitforge/contracts. */
export type AuditTargetType =
  | 'submission'
  | 'kit'
  | 'org'
  | 'membership'
  | 'entitlement'
  | 'favorite';

/** Audit action enum. Mirrors `AuditAction` in @agentkitforge/contracts. */
export type AuditAction =
  | 'submission.created'
  | 'submission.validated'
  | 'submission.approved'
  | 'submission.rejected'
  | 'submission.archived'
  | 'submission.canceled'
  | 'submission.published'
  | 'kit.published'
  | 'kit.hidden'
  | 'kit.unhidden'
  | 'kit.removed'
  | 'kit.pricing_set'
  | 'kit.visibility_set'
  | 'kit.transferred'
  | 'org.created'
  | 'org.member_added'
  | 'org.member_removed'
  | 'org.invite_accepted'
  | 'org.deleted'
  | 'entitlement.granted'
  | 'entitlement.revoked'
  | 'entitlement.subscription_status_set';

/** Small metadata bag for an audit event (e.g. {fromStatus,toStatus}). */
export type AuditMetadata = Record<string, string | number | boolean | null>;

/**
 * An append-only audit event. Mirrors `AuditEvent` in @agentkitforge/contracts.
 * Records are never updated or deleted. The route/handler layer supplies the
 * timestamp (core forbids Date.now()); the repository stamps `auditId`.
 */
export interface AuditEvent {
  auditId: string;
  timestamp: string;
  actorUserId: string;
  actorEmail?: string;
  actorType: AuditActorType;
  action: AuditAction;
  targetType: AuditTargetType;
  targetId: string;
  orgId?: string;
  metadata?: AuditMetadata;
  ip?: string;
}

/** Input to record an audit event. The repository assigns `auditId`. */
export interface RecordAuditInput {
  timestamp: string;
  actorUserId: string;
  actorEmail?: string;
  actorType: AuditActorType;
  action: AuditAction;
  targetType: AuditTargetType;
  targetId: string;
  orgId?: string;
  metadata?: AuditMetadata;
  ip?: string;
}

/** Filters + pagination for listing audit events. */
export interface ListAuditInput {
  limit?: number;
  nextToken?: string;
  actorUserId?: string;
  targetType?: AuditTargetType;
  targetId?: string;
  action?: AuditAction;
  since?: string;
  until?: string;
}

/** A page of audit events, newest first. */
export interface AuditPage {
  items: AuditEvent[];
  nextToken?: string;
}

export interface SafeInput {
  name: string;
  label?: string;
  type?: string;
  description?: string;
}

export interface SafePreparedPrompt {
  name: string;
  title?: string;
  summary?: string;
}

export interface SafeSkill {
  name: string;
  title?: string;
  summary?: string;
}

export interface SafeValidationSummary {
  status?: string;
  summary?: string;
  checkedAt?: string;
  errors?: string[];
}

export interface PublisherSnapshot {
  displayName?: string | null;
  handle?: string | null;
  avatarInitials?: string | null;
  verified?: boolean;
}

export interface PublicPublisherSnapshot extends PublisherSnapshot {
  publisherId: string;
}

export interface KitRecord {
  kitId: string;
  slug: string;
  name: string;
  summary: string;
  publisherId: string;
  ownerUserId?: string;
  /** The organization that owns this kit (absent on legacy kits). */
  ownerOrgId?: string;
  /** Catalog visibility; `private` kits are excluded from the public catalog. Defaults to `public` when absent. */
  visibility?: KitVisibility;
  /** Tier-2 pricing/license metadata. All optional; absent = free, default license, downloadable. */
  pricing?: KitPricing;
  priceModel?: PriceModel;
  /** USD minor units (cents). */
  priceCents?: number;
  /** v1 is USD-only; the field is still stored. */
  currency?: string;
  interval?: PriceInterval;
  /** Subscription free-trial length in days; only meaningful for subscription kits. */
  trialDays?: number;
  /** Paid kits default false (online-only); free kits are treated as downloadable. */
  downloadable?: boolean;
  licenseType?: LicenseType;
  /** Custom license body, used when licenseType === 'custom'. */
  licenseText?: string;
  /** The default-license version applied (e.g. 'default-v1'). */
  licenseVersion?: string;
  publisher?: unknown;
  status: string;
  validationStatus: string;
  reviewStatus: string;
  categories?: unknown;
  tags?: unknown;
  currentVersion?: string;
  verificationStatus?: string;
  badges?: unknown;
  requiredInputs?: unknown;
  preparedPrompts?: unknown;
  skills?: unknown;
  description?: string;
  validationSummary?: unknown;
  importUrl?: string;
  downloadUrl?: string;
  createdAt?: string;
  updatedAt?: string;
  publishedAt?: string;
  removedAt?: string;
  downloads?: number;
  featured?: boolean;
  featuredRank?: number | null;
  latestVersion?: unknown;
}

export interface PublisherRecord {
  publisherId: string;
  displayName: string;
  handle?: string;
  avatarInitials?: string;
  verified?: boolean;
}

export interface KitVersionRecord {
  kitId: string;
  version: string;
  fileName?: string | null;
  packageFileName?: string | null;
  packageSizeBytes?: number | null;
  summary?: string;
  schemaVersion?: string;
  publishedAt?: string;
  packageS3Key?: string;
  sha256?: string;
  contentType?: string;
  validationSummary?: unknown;
  validationResult?: unknown;
  releaseNotes?: string;
}

export interface CatalogPage {
  kits: KitRecord[];
  publishers: Map<string, PublisherRecord>;
  nextToken: string | null;
}

export interface CatalogDetail {
  kit: KitRecord | undefined;
  publisher: PublisherRecord | undefined;
  versions: KitVersionRecord[];
}

export interface ListingDraft {
  name: string;
  summary: string;
  description?: string;
  categories?: string[];
  tags?: string[];
}

export interface SubmissionRecord {
  submissionId: string;
  kitId: string;
  version?: string;
  publisherId: string;
  submittedByUserId?: string;
  submittedByEmail?: string;
  publisherSnapshot?: PublisherSnapshot;
  packageS3Key: string;
  fileName?: string;
  packageFileName?: string;
  packageSizeBytes?: number;
  sha256?: string;
  contentType?: string;
  schemaVersion?: string;
  status: string;
  validationStatus: string;
  reviewStatus: string;
  submissionType?: string;
  targetKitId?: string;
  /** The organization that will own the published kit (absent → submitter's personal org). */
  ownerOrgId?: string;
  reviewNotes?: string | null;
  listingDraft: ListingDraft;
  validationSummary?: JsonRecord;
  expiresAt?: number;
  reviewedAt?: string;
  publishedAt?: string;
  archivedAt?: string;
  canceledAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ValidationJobRecord {
  jobId: string;
  submissionId: string;
  kitId: string;
  packageS3Key: string;
  status: string;
  result?: JsonRecord;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSubmissionInput {
  fileName: string;
  version: string;
  publisherId: string;
  submittedByUserId?: string;
  submittedByEmail?: string;
  publisherSnapshot?: PublisherSnapshot;
  listingDraft: ListingDraft;
  submissionType?: string;
  targetKitId?: string;
  /** Optional org the submitter wants to own the kit; ignored unless they are a member. */
  ownerOrgId?: string;
  allowDuplicate?: boolean;
}

export interface CreateSubmissionResult {
  submission: SubmissionRecord;
  version: string;
}
