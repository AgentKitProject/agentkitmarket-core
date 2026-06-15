/**
 * Pure helpers for Tier-2 paid/licensed kits.
 *
 * Holds the platform default EULA text + version, the effective-license
 * resolver, the set-pricing validation/normalization, and the deterministic
 * per-buyer watermark builder. No cloud, DB, or zip coupling — the route layer
 * and adapters compose these.
 */

import { createHash } from 'node:crypto';
import type { Entitlement, KitRecord } from '../types.js';
import type { KitPricingUpdate } from '../ports.js';

/** Version id of the platform default license. Mirrors DEFAULT_KIT_LICENSE_VERSION in contracts. */
export const DEFAULT_KIT_LICENSE_VERSION = 'default-v1';

/** The platform default kit EULA (version DEFAULT_KIT_LICENSE_VERSION). */
export const DEFAULT_KIT_LICENSE = `AgentKitMarket Default Kit License (v1)
This kit and its contents (instructions, skills, prompts, policies, and context) are licensed, not sold. By acquiring it you agree:
1. Grant. You receive a personal, non-exclusive, non-transferable, revocable license to use this kit with your own AI agents for your own purposes.
2. No redistribution. You may not copy, publish, share, sublicense, sell, or otherwise distribute the kit or its contents, in whole or in part.
3. No recreation. You may not reproduce, paraphrase, or create derivative or substantially similar kits from its contents, whether manually or using automated tools, for distribution or resale.
4. Online-only kits. If the kit is provided online-only, you may access it only through authorized AgentKitMarket clients and may not extract, export, or retain copies.
5. Integrity. You may not remove or alter license, ownership, or watermark markers embedded in the kit.
6. Revocation. Your license may be revoked for breach; on revocation you must cease use and delete any local copies.
7. No warranty. The kit is provided "as is" without warranty; the seller and AgentKitMarket are not liable for any damages arising from its use.
This is a template and not legal advice.
`;

/**
 * The license text in force for a kit: the custom body when licenseType ===
 * 'custom' (and a body is set), otherwise the platform default.
 */
export function effectiveLicenseText(kit: Pick<KitRecord, 'licenseType' | 'licenseText'>): string {
  if (kit.licenseType === 'custom' && typeof kit.licenseText === 'string' && kit.licenseText.length > 0) {
    return kit.licenseText;
  }
  return DEFAULT_KIT_LICENSE;
}

/** The license version label for a kit (custom kits carry 'custom', else the default version). */
export function effectiveLicenseVersion(kit: Pick<KitRecord, 'licenseType'>): string {
  return kit.licenseType === 'custom' ? 'custom' : DEFAULT_KIT_LICENSE_VERSION;
}

/** Whether a kit is publicly downloadable (free or explicitly downloadable paid kit). */
export function isKitDownloadable(kit: Pick<KitRecord, 'pricing' | 'downloadable'>): boolean {
  if (kit.pricing !== 'paid') {
    return true;
  }
  return kit.downloadable === true;
}

/**
 * Raw set-pricing fields (already type-narrowed by the contracts schema at the
 * route boundary; this validator enforces the cross-field business rules).
 */
export interface SetPricingFields {
  pricing: 'free' | 'paid';
  priceModel?: 'one_time' | 'subscription';
  priceCents?: number;
  currency?: string;
  interval?: 'month' | 'year';
  downloadable?: boolean;
  licenseType?: 'default' | 'custom';
  licenseText?: string;
}

/**
 * Validates + normalizes a set-pricing request into the KitPricingUpdate the
 * repository persists. Returns an Error (with a message) on a business-rule
 * violation, or the resolved update otherwise.
 *
 * Rules: paid requires priceCents>0 and priceModel; subscription requires
 * interval. Free kits drop pricing detail (price/model/interval cleared) and are
 * always downloadable. licenseVersion is resolved here so adapters store it.
 */
export function resolveKitPricingUpdate(fields: SetPricingFields): KitPricingUpdate | Error {
  const licenseType = fields.licenseType ?? 'default';
  if (licenseType === 'custom' && (typeof fields.licenseText !== 'string' || fields.licenseText.trim().length === 0)) {
    return new Error('licenseText is required when licenseType is custom');
  }
  const licenseVersion = licenseType === 'custom' ? 'custom' : DEFAULT_KIT_LICENSE_VERSION;
  const currency = fields.currency ?? 'USD';

  if (fields.pricing === 'free') {
    return {
      pricing: 'free',
      priceModel: undefined,
      priceCents: undefined,
      currency,
      interval: undefined,
      downloadable: true,
      licenseType,
      licenseText: licenseType === 'custom' ? fields.licenseText : undefined,
      licenseVersion,
    };
  }

  // paid
  if (typeof fields.priceCents !== 'number' || !Number.isInteger(fields.priceCents) || fields.priceCents <= 0) {
    return new Error('priceCents must be a positive integer for paid kits');
  }
  if (fields.priceModel !== 'one_time' && fields.priceModel !== 'subscription') {
    return new Error('priceModel (one_time | subscription) is required for paid kits');
  }
  if (fields.priceModel === 'subscription' && fields.interval !== 'month' && fields.interval !== 'year') {
    return new Error('interval (month | year) is required for subscription kits');
  }

  return {
    pricing: 'paid',
    priceModel: fields.priceModel,
    priceCents: fields.priceCents,
    currency,
    interval: fields.priceModel === 'subscription' ? fields.interval : undefined,
    // Paid kits default to online-only (not downloadable) unless explicitly true.
    downloadable: fields.downloadable === true,
    licenseType,
    licenseText: licenseType === 'custom' ? fields.licenseText : undefined,
    licenseVersion,
  };
}

/** Whether an entitlement currently grants access (active + not past expiry). */
export function isEntitlementActive(entitlement: Entitlement, nowMs: number = Date.now()): boolean {
  if (entitlement.status !== 'active') {
    return false;
  }
  if (entitlement.expiresAt) {
    const expiry = Date.parse(entitlement.expiresAt);
    if (Number.isFinite(expiry) && expiry <= nowMs) {
      return false;
    }
  }
  return true;
}

/** A per-buyer watermark canary. Deterministic so it is testable. */
export interface Watermark {
  entitlementId: string;
  userId: string;
  kitId: string;
  grantedAt: string;
  hash: string;
}

/** Builds the deterministic watermark canary for an entitlement. */
export function buildWatermark(entitlement: Entitlement): Watermark {
  const hash = createHash('sha256')
    .update(`${entitlement.entitlementId}|${entitlement.userId}|${entitlement.kitId}|${entitlement.grantedAt}`)
    .digest('hex');
  return {
    entitlementId: entitlement.entitlementId,
    userId: entitlement.userId,
    kitId: entitlement.kitId,
    grantedAt: entitlement.grantedAt,
    hash,
  };
}

/**
 * The watermark license file body injected at `.agentkit-license/LICENSE.txt`
 * in a per-buyer package: the effective license text plus a machine-readable
 * canary block keyed to the entitlement.
 */
export function buildLicenseFileContent(
  licenseText: string,
  watermark: Watermark,
): string {
  return `${licenseText}
----- AGENTKITMARKET LICENSE CANARY (do not remove) -----
entitlementId: ${watermark.entitlementId}
userId: ${watermark.userId}
kitId: ${watermark.kitId}
grantedAt: ${watermark.grantedAt}
hash: ${watermark.hash}
---------------------------------------------------------
`;
}
