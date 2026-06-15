/**
 * Backend-parametric repository contract suite.
 *
 * This is the anti-drift guard: it pins the EXACT behavioral contract of the
 * CatalogRepository + AdminRepository ports (the submission/kit state machine,
 * TTL/lazy-expiry, duplicate + sha256 dedup, review-queue retention, catalog
 * listing/visibility, pagination, version ordering, download counting, and
 * hide/unhide/remove). Any adapter — AWS/DynamoDB or self-host/Postgres — must
 * satisfy it identically.
 *
 * Usage:
 *   runRepositoryContract('postgres', async () => {
 *     // ...build repos backed by a fresh store...
 *     return { catalog, admin, reset };
 *   });
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { AdminRepository, CatalogRepository } from '../src/core/ports.js';
import type {
  CreateSubmissionInput,
  SubmissionRecord,
} from '../src/core/types.js';
import {
  AWAITING_UPLOAD_TTL_MS,
  REVIEW_QUEUE_RETENTION_MS,
} from '../src/core/services/constants.js';
import { isHiddenFromDefaultReviewQueue } from '../src/core/services/index.js';

export interface ContractRepos {
  catalog: CatalogRepository;
  admin: AdminRepository;
  /** Truncate/recreate all backing tables so each test starts clean. */
  reset: () => Promise<void>;
}

/** A repos factory. Called once; `reset` is called before each test. */
export type MakeRepos = () => Promise<ContractRepos>;

function baseInput(overrides: Partial<CreateSubmissionInput> = {}): CreateSubmissionInput {
  return {
    fileName: 'kit.agentkit.zip',
    version: '1',
    publisherId: 'Ada Lovelace',
    submittedByUserId: 'user_1',
    submittedByEmail: 'ada@example.com',
    listingDraft: {
      name: 'My Cool Kit',
      summary: 'A cool kit',
      description: 'Longer description',
      categories: ['productivity'],
      tags: ['cli'],
    },
    ...overrides,
  };
}

/** Drives a submission through to the point just before publish. */
async function uploadAndQueue(admin: AdminRepository, input: CreateSubmissionInput): Promise<SubmissionRecord> {
  const { submission } = await admin.createSubmission(input);
  const job = await admin.createValidationJob(submission);
  await admin.markSubmissionValidationQueued(submission.submissionId, job.jobId);
  const updated = await admin.getSubmission(submission.submissionId);
  if (!updated) {
    throw new Error('submission disappeared after queue');
  }
  return updated;
}

export function runRepositoryContract(name: string, makeRepos: MakeRepos): void {
  describe(`repository contract [${name}]`, () => {
    let repos: ContractRepos;

    beforeEach(async () => {
      if (!repos) {
        repos = await makeRepos();
      }
      await repos.reset();
    });

    describe('createSubmission', () => {
      it('creates an awaiting_upload submission with server-owned ids and a TTL', async () => {
        const { submission, version } = await repos.admin.createSubmission(baseInput());

        expect(version).toBe('1');
        expect(submission.submissionId).toMatch(/^submission_/);
        expect(submission.kitId).toMatch(/^kit_/);
        expect(submission.packageS3Key).toBe(`submissions/${submission.submissionId}/package.agentkit.zip`);
        expect(submission.status).toBe('awaiting_upload');
        expect(submission.validationStatus).toBe('pending');
        expect(submission.reviewStatus).toBe('pending');
        expect(submission.submissionType).toBe('new_kit');
        expect(typeof submission.expiresAt).toBe('number');
        expect(submission.listingDraft.name).toBe('My Cool Kit');
        expect(submission.listingDraft.categories).toEqual(['productivity']);
      });

      it('round-trips the submission through getSubmission', async () => {
        const { submission } = await repos.admin.createSubmission(baseInput());
        const fetched = await repos.admin.getSubmission(submission.submissionId);
        expect(fetched).toEqual(submission);
      });

      it('reuses the targetKitId for a version_update', async () => {
        const { submission } = await repos.admin.createSubmission(baseInput({
          submissionType: 'version_update',
          targetKitId: 'kit_existing_abcd1234',
          version: '2',
        }));
        expect(submission.kitId).toBe('kit_existing_abcd1234');
        expect(submission.submissionType).toBe('version_update');
        expect(submission.targetKitId).toBe('kit_existing_abcd1234');
      });

      it('returns undefined for an unknown submission', async () => {
        expect(await repos.admin.getSubmission('submission_nope')).toBeUndefined();
      });
    });

    describe('findActiveDuplicateSubmission', () => {
      it('returns undefined when there is no submitter user id', async () => {
        const input = baseInput({ submittedByUserId: undefined });
        await uploadAndQueue(repos.admin, baseInput());
        expect(await repos.admin.findActiveDuplicateSubmission(input)).toBeUndefined();
      });

      it('does NOT treat an awaiting_upload row as an active duplicate', async () => {
        // First attempt never uploaded -> still awaiting_upload -> not a duplicate.
        await repos.admin.createSubmission(baseInput());
        const dup = await repos.admin.findActiveDuplicateSubmission(baseInput());
        expect(dup).toBeUndefined();
      });

      it('detects an active (queued) duplicate for same user + version + slug', async () => {
        await uploadAndQueue(repos.admin, baseInput());
        const dup = await repos.admin.findActiveDuplicateSubmission(baseInput());
        expect(dup).toBeDefined();
        expect(dup?.status).toBe('validation_queued');
      });

      it('does not match a different version', async () => {
        await uploadAndQueue(repos.admin, baseInput());
        const dup = await repos.admin.findActiveDuplicateSubmission(baseInput({ version: '2' }));
        expect(dup).toBeUndefined();
      });

      it('does not match a different listing name (slug)', async () => {
        await uploadAndQueue(repos.admin, baseInput());
        const dup = await repos.admin.findActiveDuplicateSubmission(baseInput({
          listingDraft: { name: 'Different Kit', summary: 's' },
        }));
        expect(dup).toBeUndefined();
      });

      it('does not treat a rejected submission as an active duplicate', async () => {
        const queued = await uploadAndQueue(repos.admin, baseInput());
        await repos.admin.rejectSubmission(queued.submissionId, 'nope', new Date().toISOString());
        const dup = await repos.admin.findActiveDuplicateSubmission(baseInput());
        expect(dup).toBeUndefined();
      });
    });

    describe('state machine', () => {
      it('markSubmissionValidationQueued advances status and clears the TTL', async () => {
        const { submission } = await repos.admin.createSubmission(baseInput());
        const job = await repos.admin.createValidationJob(submission);
        await repos.admin.markSubmissionValidationQueued(submission.submissionId, job.jobId);

        const updated = await repos.admin.getSubmission(submission.submissionId);
        expect(updated?.status).toBe('validation_queued');
        expect(updated?.validationStatus).toBe('queued');
        expect(updated?.expiresAt).toBeUndefined();
      });

      it('createValidationJob persists a queued job', async () => {
        const { submission } = await repos.admin.createSubmission(baseInput());
        const job = await repos.admin.createValidationJob(submission);
        expect(job.jobId).toMatch(/^validation_/);
        expect(job.submissionId).toBe(submission.submissionId);
        expect(job.kitId).toBe(submission.kitId);
        expect(job.status).toBe('queued');
      });

      it('approveSubmission sets reviewStatus=approved with notes', async () => {
        const queued = await uploadAndQueue(repos.admin, baseInput());
        const reviewedAt = new Date().toISOString();
        const result = await repos.admin.approveSubmission(queued.submissionId, 'looks good', reviewedAt);
        expect(result?.reviewStatus).toBe('approved');
        expect(result?.reviewNotes).toBe('looks good');
        expect(result?.reviewedAt).toBe(reviewedAt);
        // status is unchanged by approve (publish flips status).
        expect(result?.status).toBe('validation_queued');
      });

      it('rejectSubmission flips status and reviewStatus to rejected', async () => {
        const queued = await uploadAndQueue(repos.admin, baseInput());
        const result = await repos.admin.rejectSubmission(queued.submissionId, 'bad', new Date().toISOString());
        expect(result?.reviewStatus).toBe('rejected');
        expect(result?.status).toBe('rejected');
        expect(result?.reviewNotes).toBe('bad');
      });

      it('archiveSubmission archives a non-published submission', async () => {
        const queued = await uploadAndQueue(repos.admin, baseInput());
        const result = await repos.admin.archiveSubmission(queued.submissionId, new Date().toISOString());
        expect(result?.status).toBe('archived');
      });

      it('archiveSubmission refuses a published submission', async () => {
        const queued = await uploadAndQueue(repos.admin, baseInput());
        await repos.admin.approveSubmission(queued.submissionId, null, new Date().toISOString());
        const published = await repos.admin.getSubmission(queued.submissionId);
        await repos.admin.publishSubmission(published!, new Date().toISOString());
        const result = await repos.admin.archiveSubmission(queued.submissionId, new Date().toISOString());
        expect(result).toBeUndefined();
      });

      it('cancelSubmission cancels a non-published submission', async () => {
        const queued = await uploadAndQueue(repos.admin, baseInput());
        const result = await repos.admin.cancelSubmission(queued.submissionId, new Date().toISOString());
        expect(result?.status).toBe('canceled');
      });
    });

    describe('publishSubmission', () => {
      it('atomically creates a public kit + version and marks the submission published', async () => {
        const queued = await uploadAndQueue(repos.admin, {
          ...baseInput(),
        });
        const enriched: SubmissionRecord = {
          ...queued,
          packageSizeBytes: 1234,
          sha256: 'abc123sha',
          schemaVersion: '0.1',
          validationStatus: 'passed',
        };
        await repos.admin.approveSubmission(queued.submissionId, null, new Date().toISOString());
        const publishedAt = new Date().toISOString();
        const kit = await repos.admin.publishSubmission(enriched, publishedAt);

        expect(kit.status).toBe('published');
        expect(kit.validationStatus).toBe('passed');
        expect(kit.reviewStatus).toBe('approved');
        expect(kit.slug).toBe('my-cool-kit');
        expect(kit.currentVersion).toBe('1');
        expect(kit.badges).toEqual(['Validated', 'Reviewed']);
        expect(kit.ownerUserId).toBe('user_1');
        expect(kit.downloads).toBe(0);

        const storedKit = await repos.admin.getKit(kit.kitId);
        expect(storedKit?.slug).toBe('my-cool-kit');

        const version = await repos.admin.getKitVersion(kit.kitId, '1');
        expect(version?.sha256).toBe('abc123sha');
        expect(version?.packageSizeBytes).toBe(1234);

        const sub = await repos.admin.getSubmission(queued.submissionId);
        expect(sub?.status).toBe('published');
        expect(sub?.publishedAt).toBe(publishedAt);
      });

      it('preserves owner, createdAt, downloads on a version update (re-publish)', async () => {
        // v1
        const queued1 = await uploadAndQueue(repos.admin, baseInput());
        const kit1 = await repos.admin.publishSubmission(
          { ...queued1, validationStatus: 'passed' },
          '2026-01-01T00:00:00.000Z',
        );
        await repos.admin.incrementKitDownloads(kit1.kitId);

        // v2 targeting the same kit
        const queued2 = await uploadAndQueue(repos.admin, baseInput({
          submissionType: 'version_update',
          targetKitId: kit1.kitId,
          version: '2',
          submittedByUserId: 'user_other',
        }));
        const kit2 = await repos.admin.publishSubmission(
          { ...queued2, validationStatus: 'passed' },
          '2026-02-01T00:00:00.000Z',
        );

        expect(kit2.kitId).toBe(kit1.kitId);
        expect(kit2.currentVersion).toBe('2');
        expect(kit2.ownerUserId).toBe('user_1'); // original owner kept
        expect(kit2.createdAt).toBe('2026-01-01T00:00:00.000Z');
        expect(kit2.publishedAt).toBe('2026-01-01T00:00:00.000Z'); // first publish time kept
        expect(kit2.downloads).toBe(1); // download count preserved

        const versions = await repos.admin.listKitVersions(kit1.kitId);
        expect(versions.map((v) => v.version)).toEqual(['1', '2']);
      });
    });

    describe('catalog listing + visibility', () => {
      async function publishKit(input: CreateSubmissionInput): Promise<string> {
        const queued = await uploadAndQueue(repos.admin, input);
        const kit = await repos.admin.publishSubmission(
          { ...queued, validationStatus: 'passed' },
          new Date().toISOString(),
        );
        return kit.kitId;
      }

      it('lists only published∧passed∧approved kits', async () => {
        await publishKit(baseInput({ listingDraft: { name: 'Published Kit', summary: 's' } }));
        // A queued-but-not-published submission must not appear.
        await uploadAndQueue(repos.admin, baseInput({
          submittedByUserId: 'user_2',
          listingDraft: { name: 'Pending Kit', summary: 's' },
        }));

        const page = await repos.catalog.listKits(20, undefined);
        expect(page.kits).toHaveLength(1);
        expect(page.kits[0]?.slug).toBe('published-kit');
      });

      it('hidden / removed kits are excluded from the catalog', async () => {
        const kitId = await publishKit(baseInput());
        await repos.admin.hideKit(kitId);
        let page = await repos.catalog.listKits(20, undefined);
        expect(page.kits).toHaveLength(0);

        await repos.admin.unhideKit(kitId);
        page = await repos.catalog.listKits(20, undefined);
        expect(page.kits).toHaveLength(1);

        await repos.admin.removeKit(kitId, new Date().toISOString());
        page = await repos.catalog.listKits(20, undefined);
        expect(page.kits).toHaveLength(0);
      });

      it('attaches publisher snapshots in the page', async () => {
        await publishKit(baseInput());
        const page = await repos.catalog.listKits(20, undefined);
        const kit = page.kits[0]!;
        // publisher snapshot is stored on the kit row itself in this design.
        expect(kit.publisherId).toBe('Ada Lovelace');
      });

      it('paginates with a nextToken cursor', async () => {
        for (let i = 0; i < 3; i += 1) {
          await publishKit(baseInput({
            submittedByUserId: `user_${i}`,
            listingDraft: { name: `Kit Number ${i}`, summary: 's' },
          }));
        }

        const page1 = await repos.catalog.listKits(2, undefined);
        expect(page1.kits).toHaveLength(2);
        expect(page1.nextToken).toBeTruthy();

        const page2 = await repos.catalog.listKits(2, page1.nextToken ?? undefined);
        expect(page2.kits).toHaveLength(1);

        const seen = new Set([...page1.kits, ...page2.kits].map((k) => k.kitId));
        expect(seen.size).toBe(3);
      });

      it('getKitBySlug returns a published kit with versions newest-first', async () => {
        const queued1 = await uploadAndQueue(repos.admin, baseInput());
        const kit = await repos.admin.publishSubmission({ ...queued1, validationStatus: 'passed' }, new Date().toISOString());
        const queued2 = await uploadAndQueue(repos.admin, baseInput({
          submissionType: 'version_update', targetKitId: kit.kitId, version: '2',
        }));
        await repos.admin.publishSubmission({ ...queued2, validationStatus: 'passed' }, new Date().toISOString());

        const detail = await repos.catalog.getKitBySlug('my-cool-kit');
        expect(detail.kit?.kitId).toBe(kit.kitId);
        expect(detail.versions.map((v) => v.version)).toEqual(['2', '1']);
      });

      it('getKitBySlug hides non-public kits', async () => {
        const kitId = await publishKit(baseInput());
        await repos.admin.hideKit(kitId);
        const detail = await repos.catalog.getKitBySlug('my-cool-kit');
        expect(detail.kit).toBeUndefined();
        expect(detail.versions).toEqual([]);
      });
    });

    describe('sha256 dedup', () => {
      it('findKitVersionBySha256 finds a published version by digest', async () => {
        const queued = await uploadAndQueue(repos.admin, baseInput());
        await repos.admin.publishSubmission(
          { ...queued, sha256: 'deadbeef', validationStatus: 'passed' },
          new Date().toISOString(),
        );
        const found = await repos.admin.findKitVersionBySha256('deadbeef');
        expect(found?.sha256).toBe('deadbeef');
        expect(await repos.admin.findKitVersionBySha256('nope')).toBeUndefined();
      });
    });

    describe('incrementKitDownloads', () => {
      it('increments the download counter', async () => {
        const queued = await uploadAndQueue(repos.admin, baseInput());
        const kit = await repos.admin.publishSubmission({ ...queued, validationStatus: 'passed' }, new Date().toISOString());
        await repos.admin.incrementKitDownloads(kit.kitId);
        await repos.admin.incrementKitDownloads(kit.kitId);
        const updated = await repos.admin.getKit(kit.kitId);
        expect(updated?.downloads).toBe(2);
      });
    });

    describe('hide / unhide guards', () => {
      it('hideKit / unhideKit / removeKit return undefined for unknown kits', async () => {
        expect(await repos.admin.hideKit('kit_nope')).toBeUndefined();
        expect(await repos.admin.unhideKit('kit_nope')).toBeUndefined();
        expect(await repos.admin.removeKit('kit_nope', new Date().toISOString())).toBeUndefined();
      });

      it('unhideKit refuses a kit that is not hidden', async () => {
        const queued = await uploadAndQueue(repos.admin, baseInput());
        const kit = await repos.admin.publishSubmission({ ...queued, validationStatus: 'passed' }, new Date().toISOString());
        expect(await repos.admin.unhideKit(kit.kitId)).toBeUndefined();
      });
    });

    describe('TTL / lazy-expiry semantics (via listSubmissions + service rule)', () => {
      it('a fresh awaiting_upload row is not yet hidden, a stale one is', async () => {
        await repos.admin.createSubmission(baseInput());
        const submissions = await repos.admin.listSubmissions();
        expect(submissions).toHaveLength(1);
        const sub = submissions[0]!;

        const now = Date.now();
        expect(isHiddenFromDefaultReviewQueue(sub, now)).toBe(false);
        // Past the TTL window -> lazily expired -> hidden from the queue.
        const wayLater = (sub.expiresAt ?? 0) * 1000 + AWAITING_UPLOAD_TTL_MS + 1;
        expect(isHiddenFromDefaultReviewQueue(sub, wayLater)).toBe(true);
      });

      it('an approved submission drops out of the queue after the retention window', async () => {
        const queued = await uploadAndQueue(repos.admin, baseInput());
        const reviewedAt = new Date().toISOString();
        await repos.admin.approveSubmission(queued.submissionId, null, reviewedAt);
        const sub = await repos.admin.getSubmission(queued.submissionId);

        const reviewedMs = Date.parse(reviewedAt);
        expect(isHiddenFromDefaultReviewQueue(sub!, reviewedMs + 1000)).toBe(false);
        expect(isHiddenFromDefaultReviewQueue(sub!, reviewedMs + REVIEW_QUEUE_RETENTION_MS + 1000)).toBe(true);
      });
    });
  });
}
