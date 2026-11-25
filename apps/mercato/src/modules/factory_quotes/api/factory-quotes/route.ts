import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { getCommandInterceptorHttpRejection } from '@open-mercato/shared/lib/commands/errors'
import { bridgeLegacyGuard, runMutationGuards } from '@open-mercato/shared/lib/crud/mutation-guard-registry'
import { getAllMutationGuardInstances } from '@open-mercato/shared/lib/crud/mutation-guard-store'
import { getTelemetryRuntime } from '@open-mercato/shared/lib/telemetry/runtime'
import { QuoteEvent, QuoteRecord } from '../../data/entities'
import { mutationSchema, type Mutation } from '../../data/validators'
import { commandId } from '../../commands/workspace'
import { resolveAccess } from '../../lib/access'
import { deny, project, QuoteFault } from '../../lib/workflow'

const gate = { requireAuth: true, requireFeatures: ['factory_quotes.view'] }
export const metadata = { GET: gate, POST: gate }
const noStore = { headers: { 'Cache-Control': 'private, no-store' } }
function json(body: unknown, status = 200) { return Response.json(body, { status, ...noStore }) }

async function context(request: Request): Promise<CommandRuntimeContext> {
  const auth = await getAuthFromRequest(request)
  deny(auth?.tenantId && auth.sub && !auth.isApiKey, 'unauthorized', 401)
  const container = await createRequestContainer()
  const scope = await resolveOrganizationScopeForRequest({ container, auth, request })
  return { container, auth, organizationScope: scope, selectedOrganizationId: scope ? scope.selectedId : auth.orgId ?? null,
    organizationIds: scope?.filterIds ?? (auth.orgId ? [auth.orgId] : []), request }
}
function onError(error: unknown) {
  if (error instanceof QuoteFault) return json({ error: error.code }, error.status)
  if (error instanceof z.ZodError) return json({ error: 'invalid_input', fields: error.issues.map((i) => i.path.join('.')) }, 400)
  const rejection = getCommandInterceptorHttpRejection(error)
  if (rejection) return json(rejection.body, rejection.status)
  getTelemetryRuntime()?.reportError(new Error('Factory quote operation failed'), { module: 'factory_quotes', code: 'operation_failed' })
  return json({ error: 'operation_failed' }, 500)
}
function templateProjection(row: QuoteRecord, canConfigure: boolean, cost: boolean) {
  deny(row.state.type === 'template' && (canConfigure || row.state.stage === 'published'), 'not_found', 404)
  if (canConfigure) return row.state
  return { type: 'template', stage: row.state.stage, spec: { name: row.state.spec.name,
    fields: row.state.spec.fields.filter((f) => f.public || cost) } }
}
export async function GET(request: Request) {
  try {
    const ctx = await context(request)
    const { have, scope, actor } = await resolveAccess(ctx)
    const config = have.has('configure') || have.has('publish_template')
    const em = ctx.container.resolve<EntityManager>('em')
    const id = new URL(request.url).searchParams.get('id')
    if (!id) {
      const [quotes, templates] = await Promise.all([
        em.find(QuoteRecord, { ...scope, kind: 'quote' }, { orderBy: { updatedAt: 'desc' }, limit: 100 }),
        em.find(QuoteRecord, { ...scope, kind: 'template' }, { orderBy: { updatedAt: 'desc' }, limit: 100 }),
      ])
      const summary = (r: QuoteRecord) => ({ id: r.id, title: r.title, stage: r.state.stage, revision: r.revision })
      return json({ capabilities: [...have], quotes: quotes.map(summary), templates: templates.filter((r) => config || r.state.stage === 'published').map(summary) })
    }
    const row = await em.findOne(QuoteRecord, { id: z.uuid().parse(id), ...scope })
    deny(row, 'not_found', 404)
    const day = new Date().toISOString().slice(0, 10)
    const state = row.state.type === 'template' ? templateProjection(row, config, have.has('cost'))
      : { type: 'quote', ...project(row.state, day, have.has('cost')) }
    const messages = row.kind === 'quote' ? await em.find(QuoteEvent, { ...scope, recordId: id, actorId: actor, action: 'message' }, { orderBy: { createdAt: 'desc' }, limit: 50 }) : []
    return json({ id, updatedAt: row.updatedAt.toISOString(), revision: row.revision, capabilities: [...have], state,
      messages: messages.reverse().map((e) => ({ id: e.id, at: e.createdAt.toISOString(), text: (e.details.action as { text: string }).text })) })
  } catch (error) { return onError(error) }
}
async function body(request: Request): Promise<unknown> {
  const source = request.body?.getReader()
  deny(source, 'invalid_input', 400)
  const decode = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0, text = ''
  try {
    while (true) {
      const { value, done } = await source.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 1024 * 1024) { await source.cancel(); throw new QuoteFault(413, 'payload_too_large') }
      text += decode.decode(value, { stream: true })
    }
    return JSON.parse(text + decode.decode()) as unknown
  } catch (error) {
    if (error instanceof QuoteFault) throw error
    throw new QuoteFault(400, 'invalid_input')
  } finally { source.releaseLock() }
}
export async function POST(request: Request) {
  try {
    const ctx = await context(request)
    const { actor, scope, grants } = await resolveAccess(ctx)
    deny(request.headers.get('content-type')?.split(';')[0] === 'application/json' && request.headers.get('sec-fetch-site') !== 'cross-site', 'invalid_input', 400)
    let input = mutationSchema.parse(await body(request))
    const initial = input
    const em = ctx.container.resolve<EntityManager>('em')
    const create = input.action.type === 'new_quote' || input.action.type === 'new_template'
    const row = create ? null : await em.findOne(QuoteRecord, { id: input.id, ...scope })
    deny(create || row, 'not_found', 404)
    const guards = [...getAllMutationGuardInstances()]
    const legacy = bridgeLegacyGuard(ctx.container)
    if (legacy) guards.push(legacy)
    const guardContext = { ...scope, userId: actor, resourceKind: row?.kind === 'template' || input.action.type === 'new_template' ? 'factory_quotes.template' : 'factory_quotes.quote',
      resourceId: create ? null : input.id, operation: create ? 'create' as const : 'update' as const, requestMethod: request.method, requestHeaders: request.headers }
    const decision = await runMutationGuards(guards, { ...guardContext, mutationPayload: input }, { userFeatures: grants })
    if (!decision.ok) return json(decision.errorBody ?? { error: 'guard_blocked' }, decision.errorStatus ?? 422)
    if (decision.modifiedPayload) {
      input = mutationSchema.parse({ ...input, ...decision.modifiedPayload })
      deny(initial.id === input.id && initial.revision === input.revision && initial.token === input.token && initial.action.type === input.action.type, 'guard_scope_changed', 403)
    }
    const bus = ctx.container.resolve<CommandBus>('commandBus')
    const { result } = await bus.execute<Mutation, unknown>(commandId, { input, ctx })
    for (const next of decision.afterSuccessCallbacks) {
      try { await next.guard.afterSuccess?.({ ...guardContext, resourceId: input.id, metadata: next.metadata ?? null }) }
      catch { getTelemetryRuntime()?.reportError(new Error('Factory quote after-success hook failed'), { module: 'factory_quotes', code: 'after_success_failed' }) }
    }
    return json(result)
  } catch (error) { return onError(error) }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Factory Quotes', summary: 'Factory quoting workspace', methods: {
    GET: { summary: 'Read scoped workspace or record', query: z.object({ id: z.uuid().optional() }), responses: [{ status: 200, description: 'Scoped projection', schema: z.record(z.string(), z.unknown()) }] },
    POST: { summary: 'Apply a revision-checked workspace action', requestBody: { contentType: 'application/json', schema: mutationSchema }, responses: [{ status: 200, description: 'Action result', schema: z.object({ id: z.uuid(), revision: z.number(), document: z.unknown().optional() }) }] },
  },
}
