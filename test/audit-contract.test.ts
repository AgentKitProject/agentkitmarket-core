/**
 * Contract test (consumer side): the market-core audit-log surface must stay in
 * lockstep with @agentkitforge/contracts. Asserts the Seam B route the router
 * dispatches matches the published route builder, and that a RecordAuditInput /
 * AuditEvent produced by core satisfies the published zod schemas.
 */
import { describe, it, expect } from 'vitest';
import {
  marketBackendAuditRoutes,
  auditEventSchema,
  auditActionSchema,
  listAuditLogsResponseSchema,
} from '@agentkitforge/contracts';
import { ROUTES } from '../src/entrypoints/route-table.js';
import type { AuditEvent, AuditAction } from '../src/core/types.js';

describe('audit log contract parity with @agentkitforge/contracts', () => {
  it('exposes the GET /admin/audit-logs route the contract builder declares', () => {
    const expected = marketBackendAuditRoutes.adminListAuditLogs();
    const found = ROUTES.some(
      (r) => r.method === 'GET' && r.template === expected,
    );
    expect(found).toBe(true);
  });

  it('core AuditEvent satisfies the published auditEventSchema', () => {
    const event: AuditEvent = {
      auditId: 'aud_1',
      timestamp: '2026-06-16T00:00:00.000Z',
      actorUserId: 'admin',
      actorType: 'admin',
      action: 'submission.approved',
      targetType: 'submission',
      targetId: 's_1',
      metadata: { fromStatus: 'validation_passed', toStatus: 'published' },
    };
    expect(() => auditEventSchema.parse(event)).not.toThrow();
    expect(() => listAuditLogsResponseSchema.parse({ items: [event], nextToken: 'x' })).not.toThrow();
  });

  it('every core AuditAction is a valid contract action', () => {
    const coreActions: AuditAction[] = [
      'submission.created', 'submission.validated', 'submission.approved',
      'submission.rejected', 'submission.archived', 'submission.canceled',
      'submission.published', 'kit.published', 'kit.hidden', 'kit.unhidden',
      'kit.removed', 'kit.pricing_set', 'kit.visibility_set', 'kit.transferred',
      'org.created', 'org.member_added', 'org.member_removed',
      'org.invite_accepted', 'org.deleted', 'entitlement.granted', 'entitlement.revoked',
    ];
    for (const a of coreActions) {
      expect(() => auditActionSchema.parse(a)).not.toThrow();
    }
  });
});
