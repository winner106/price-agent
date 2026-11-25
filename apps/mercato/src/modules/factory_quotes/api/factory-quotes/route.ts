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
import { csvPacket, mutationSchema, type Mutation } from '../../data/validators'
import { commandId } from '../../commands/workspace'
import { CsvFault, csvSuggestions, csvTargets, mapRows, parseCsv, readCsv } from '../../lib/csv'
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
  if (error instanceof CsvFault) return json({ error: error.code, position: error.position }, error.status)
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
async function prepareCsv(request: Request, em: EntityManager, access: Awaited<ReturnType<typeof resolveAccess>>) {
  deny(access.have.has('edit'), 'forbidden', 403)
  const header = request.headers.get('x-factory-csv')
  deny(header && header.length <= 8192, 'invalid_input', 400)
  let decoded: unknown
  try { decoded = JSON.parse(header) } catch { throw new QuoteFault(400, 'invalid_input') }
  const { id, revision, token, headerRow, templateId, apply } = csvPacket.parse(decoded)
  const row = await em.findOne(QuoteRecord, { id, kind: 'quote', ...access.scope })
  deny(row?.state.type === 'quote', 'not_found', 404)
  deny(row.state.templateId === templateId, 'stale_revision', 409)
  if (!apply) deny(row.revision === revision && row.state.stage === 'draft', 'stale_revision', 409)
  else {
    const preview = await em.findOne(QuoteEvent, { id: apply.receipt, actorId: access.actor, recordId: id, action: 'csv_preview', ...access.scope })
    deny(preview, 'csv_preview_mismatch', 409)
  }
  const { digest, text } = await readCsv(request)
  const doc = parseCsv(text, headerRow)
  if (apply) {
    const mapped = mapRows(doc, row.state.template, access.have.has('cost'), apply.mapping, apply)
    return { row, input: mutationSchema.parse({ id, revision, token, action: { type: 'csv_import', digest, headerRow, templateId, ...apply, ...mapped } }) }
  }
  const targets = csvTargets(row.state.template, access.have.has('cost'))
  return {
    row,
    input: mutationSchema.parse({ id, revision, token, action: { type: 'csv_preview', digest, templateId, headerRow, headers: doc.header.cells, totalRows: doc.rows.length } }),
    preview: { headers: doc.header.cells.map((cell) => cell.slice(0, 150)), totalRows: doc.rows.length, rows: doc.rows.slice(0, 5)
      .map((r) => ({ row: r.row, cells: r.cells.map((cell) => cell.slice(0, 150)) })),
      from: doc.rows[0].row, to: doc.rows[Math.min(49, doc.rows.length - 1)].row,
      targets: targets.map(({ key, label, required }) => ({ key, label, required })), suggestions: csvSuggestions(doc.header.cells, targets) },
  }
}
export async function POST(request: Request) {
  try {
    const ctx = await context(request)
    const access = await resolveAccess(ctx)
    const { actor, scope, grants } = access
    const media = request.headers.get('content-type')?.split(';')[0]
    deny((media === 'application/json' || media === 'text/csv') && request.headers.get('sec-fetch-site') !== 'cross-site', 'invalid_input', 400)
    const em = ctx.container.resolve<EntityManager>('em')
    const csv = media === 'text/csv' ? await prepareCsv(request, em, access) : undefined
    let input = csv?.input ?? mutationSchema.parse(await body(request))
    deny(csv || !['csv_preview', 'csv_import'].includes(input.action.type), 'invalid_input', 400)
    const initial = input
    const create = input.action.type === 'new_quote' || input.action.type === 'new_template'
    const row = csv?.row ?? (create ? null : await em.findOne(QuoteRecord, { id: input.id, ...scope }))
    deny(create || row, 'not_found', 404)
    const guards = [...getAllMutationGuardInstances()]
    const legacy = bridgeLegacyGuard(ctx.container)
    if (legacy) guards.push(legacy)
    const guardContext = { ...scope, userId: actor, resourceKind: row?.kind === 'template' || input.action.type === 'new_template' ? 'factory_quotes.template' : 'factory_quotes.quote',
      resourceId: create ? null : input.id, operation: create ? 'create' as const : 'update' as const, requestMethod: request.method, requestHeaders: request.headers }
    const decision = await runMutationGuards(guards, { ...guardContext, mutationPayload: input }, { userFeatures: grants })
    if (!decision.ok) return json(decision.errorBody ?? { error: 'guard_blocked' }, decision.errorStatus ?? 422)
    if (decision.modifiedPayload) {
      // Import is bound to the exact validated server-derived payload, including
      // provenance. Guards may stop it but must not substitute mapped data.
      if (csv) {
        const guarded = mutationSchema.parse({ ...input, ...decision.modifiedPayload })
        deny(JSON.stringify(guarded) === JSON.stringify(initial), 'guard_scope_changed', 403)
      }
      input = mutationSchema.parse({ ...input, ...decision.modifiedPayload })
      deny(initial.id === input.id && initial.revision === input.revision && initial.token === input.token && initial.action.type === input.action.type, 'guard_scope_changed', 403)
    }
    const bus = ctx.container.resolve<CommandBus>('commandBus')
    const { result } = await bus.execute<Mutation, { id: string; revision: number; receipt?: string }>(commandId, { input, ctx })
    for (const next of decision.afterSuccessCallbacks) {
      try { await next.guard.afterSuccess?.({ ...guardContext, resourceId: input.id, metadata: next.metadata ?? null }) }
      catch { getTelemetryRuntime()?.reportError(new Error('Factory quote after-success hook failed'), { module: 'factory_quotes', code: 'after_success_failed' }) }
    }
    return json(csv?.preview ? { ...result, preview: csv.preview } : result)
  } catch (error) { return onError(error) }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Factory Quotes', summary: 'Factory quoting workspace', methods: {
    GET: { summary: 'Read scoped workspace or record', query: z.object({ id: z.uuid().optional() }), responses: [{ status: 200, description: 'Scoped projection', schema: z.record(z.string(), z.unknown()) }] },
    POST: { summary: 'Apply a revision-checked workspace action', description: 'CSV upload accepts text/csv and the x-factory-csv JSON metadata header; use its preview receipt to confirm the same file and mapping.', requestBody: { contentType: 'application/json', schema: mutationSchema }, responses: [{ status: 200, description: 'Action result', schema: z.object({ id: z.uuid(), revision: z.number(), document: z.unknown().optional() }) }] },
  },
}
