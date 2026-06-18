/**
 * Contract test (consumer side): the org-kits listing surface in market-core
 * must stay in lockstep with @agentkitforge/contracts.
 *
 * Asserts that the Seam B route the router dispatches on matches the path the
 * published contract route builder produces, and verifies the handler respects
 * the membership gate.
 */
import { describe, it, expect } from 'vitest';
import { marketBackendOrgRoutes } from '@agentkitforge/contracts';
import { ROUTES } from '../src/entrypoints/route-table.js';
import { routeRequest } from '../src/core/routes/index.js';
import type { CoreRequest } from '../src/core/routes/types.js';
import type { RouterDeps } from '../src/core/routes/types.js';
import type {
  OrgRepository,
  CatalogRepository,
  AdminRepository,
} from '../src/core/ports.js';
import type { Organization, OrgMembership, KitRecord } from '../src/core/types.js';

describe('org-kits contract parity with @agentkitforge/contracts', () => {
  it('exposes GET /admin/orgs/{orgId}/kits in the route table (contract builder matches route table)', () => {
    // The contract builder uses encodeURIComponent, so use a literal orgId that
    // doesn't need encoding to check the path shape.
    const contractPath = marketBackendOrgRoutes.adminListOrgKits('org1');
    expect(contractPath).toBe('/admin/orgs/org1/kits');
    const found = ROUTES.some(
      (r) => r.method === 'GET' && r.template === '/admin/orgs/{orgId}/kits',
    );
    expect(found).toBe(true);
  });

  it('route table template matches the contract builder', () => {
    const expected = '/admin/orgs/{orgId}/kits';
    const found = ROUTES.some((r) => r.method === 'GET' && r.template === expected);
    expect(found).toBe(true);
  });

  it('handler returns 403 when actorUserId is not an active member', async () => {
    const org: Organization = {
      orgId: 'org_1',
      slug: 'acme',
      displayName: 'Acme',
      type: 'team',
      ownerUserId: 'u_owner',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const mockOrgRepo: Partial<OrgRepository> = {
      getOrg: async (_orgId: string) => org,
      getMembership: async (_orgId: string, _userId: string): Promise<OrgMembership | null> => null,
      listKitsForOrg: async (_orgId: string): Promise<KitRecord[]> => [],
    };

    const request: CoreRequest = {
      method: 'GET',
      resource: '/admin/orgs/{orgId}/kits',
      pathParameters: { orgId: 'org_1' },
      queryStringParameters: { actorUserId: 'u_nonmember' },
      headers: { 'x-agentkitmarket-admin-key': 'test-key' },
      body: null,
      sourceIp: '127.0.0.1',
    };

    const deps: RouterDeps = {
      repository: {} as CatalogRepository,
      adminRepository: {} as AdminRepository,
      orgRepository: mockOrgRepo as OrgRepository,
      adminKey: 'test-key',
    };

    const response = await routeRequest(request, deps);
    expect(response.statusCode).toBe(403);
  });

  it('handler returns 200 with kit items for an active member', async () => {
    const org: Organization = {
      orgId: 'org_1',
      slug: 'acme',
      displayName: 'Acme',
      type: 'team',
      ownerUserId: 'u_owner',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const activeMembership: OrgMembership = {
      orgId: 'org_1',
      userId: 'u_member',
      role: 'member',
      status: 'active',
      createdAt: new Date().toISOString(),
    };

    const kit: KitRecord = {
      kitId: 'kit_1',
      slug: 'acme-kit',
      publisherId: 'Acme',
      name: 'Acme Kit',
      summary: 'An Acme Kit',
      currentVersion: 1,
      ownerOrgId: 'org_1',
      visibility: 'private',
      status: 'published',
      publishedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const mockOrgRepo: Partial<OrgRepository> = {
      getOrg: async (_orgId: string) => org,
      getMembership: async (_orgId: string, _userId: string): Promise<OrgMembership | null> =>
        activeMembership,
      listKitsForOrg: async (_orgId: string): Promise<KitRecord[]> => [kit],
    };

    const request: CoreRequest = {
      method: 'GET',
      resource: '/admin/orgs/{orgId}/kits',
      pathParameters: { orgId: 'org_1' },
      queryStringParameters: { actorUserId: 'u_member' },
      headers: { 'x-agentkitmarket-admin-key': 'test-key' },
      body: null,
      sourceIp: '127.0.0.1',
    };

    const deps: RouterDeps = {
      repository: {} as CatalogRepository,
      adminRepository: {} as AdminRepository,
      orgRepository: mockOrgRepo as OrgRepository,
      adminKey: 'test-key',
    };

    const response = await routeRequest(request, deps);
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { items: KitRecord[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.kitId).toBe('kit_1');
  });
});
