import { isOrganizationAccessAllowed } from '@open-mercato/shared/lib/auth/organizationAccess'
import type { CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { actions, type Access } from '../acl'
import { deny } from './workflow'

type Rbac = {
  userHasAllFeatures: (actor: string, features: string[], scope: { tenantId: string; organizationId: string }) => Promise<boolean>
  getGrantedFeatures: (actor: string, scope: { tenantId: string; organizationId: string }) => Promise<string[]>
}
export async function resolveAccess(ctx: CommandRuntimeContext) {
  const auth = ctx.auth
  const tenantId = auth?.tenantId
  const organizationId = ctx.selectedOrganizationId
  const actor = auth?.sub
  deny(auth && !auth.isApiKey && actor && tenantId, 'unauthorized', 401)
  const org = ctx.organizationScope
  deny(organizationId && !org?.selectionRejected && (!org?.tenantId || org.tenantId === tenantId) &&
    isOrganizationAccessAllowed({ isSuperAdmin: auth.isSuperAdmin === true, allowedOrganizationIds: org?.allowedIds !== undefined ? org.allowedIds : (auth.orgId ? [auth.orgId] : []), targetOrganizationId: organizationId }), 'org_required', 403)
  const scope = { tenantId, organizationId }
  const rbac = ctx.container.resolve<Rbac>('rbacService')
  const grants = await rbac.getGrantedFeatures(actor, scope)
  const have = new Set<Access>()
  await Promise.all(actions.map(async (action) => {
    const id = `factory_quotes.${action}`
    // Separation-of-duty policy: broad tenant/global wildcards alone must not
    // grant access to private costs, independent approval or releasing quotes.
    if (['cost', 'approve', 'release', 'review', 'technical', 'delivery'].includes(action) && !grants.includes(id)) return
    if (await rbac.userHasAllFeatures(actor, [id], scope)) have.add(action)
  }))
  deny(have.has('view'), 'forbidden', 403)
  return { actor, scope, have, grants }
}
