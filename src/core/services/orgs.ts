/**
 * Pure helpers for Market Phase 2 organizations.
 *
 * Slug dedupe + personal-org slug derivation live here so the AWS (DynamoDB)
 * and self-host (Postgres) adapters share identical behavior. No cloud or DB
 * coupling — just string logic over a set of already-taken slugs.
 */

import { slugifyForUrl } from './index.js';

/**
 * Returns `base` if it is free, otherwise the first `base-2`, `base-3`, ...
 * not present in `taken`. Mirrors the numeric-suffix dedupe used for kit slugs.
 */
export function dedupeSlug(base: string, taken: Iterable<string>): string {
  const used = new Set<string>(taken);
  if (!used.has(base)) {
    return base;
  }
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
}

/**
 * Base slug for a user's personal org. Uses the display name when it yields a
 * meaningful slug, otherwise falls back to a stable per-user slug so two users
 * with the same display name still dedupe deterministically.
 */
export function personalOrgSlugBase(displayName: string, userId: string): string {
  const fromName = slugifyForUrl(displayName);
  if (fromName && fromName !== 'agentkit') {
    return fromName;
  }
  return slugifyForUrl(`user-${userId}`);
}
