import { randomUUID } from 'node:crypto'
import { MikroORM } from '@mikro-orm/postgresql'
import { Migrator } from '@mikro-orm/migrations'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { GET, POST } from '../api/factory-quotes/route'
import { QuoteEvent, QuoteRecord } from '../data/entities'
import type { Mutation } from '../data/validators'
import { sku } from '../lib/seeds'
import { Migration20261125190000_factory_quotes } from '../migrations/Migration20261125190000_factory_quotes'

jest.mock('@open-mercato/shared/lib/auth/server', () => ({ getAuthFromRequest: jest.fn() }))
jest.mock('@open-mercato/shared/lib/di/container', () => ({ createRequestContainer: jest.fn() }))
jest.mock('@open-mercato/shared/lib/commands', () => ({ registerCommand: jest.fn() }))
jest.mock('@open-mercato/core/modules/directory/utils/organizationScope', () => ({ resolveOrganizationScopeForRequest: jest.fn(async () => null) }))
jest.mock('@open-mercato/shared/lib/crud/mutation-guard-store', () => ({ getAllMutationGuardInstances: () => [] }))
jest.mock('@open-mercato/shared/lib/crud/mutation-guard-registry', () => ({ bridgeLegacyGuard: () => null, runMutationGuards: jest.fn(async () => ({ ok: true, afterSuccessCallbacks: [] })) }))
jest.mock('@open-mercato/shared/lib/commands/errors', () => ({ getCommandInterceptorHttpRejection: () => null }))
jest.mock('@open-mercato/shared/lib/telemetry/runtime', () => ({ getTelemetryRuntime: () => ({ reportError: jest.fn() }) }))

const url = process.env.FACTORY_QUOTES_TEST_DATABASE_URL
const withPg = url ? describe : describe.skip
const command = jest.mocked(registerCommand).mock.calls[0][0] as CommandHandler<Mutation, { id: string; revision: number; receipt?: string }>
const endpoint = 'http://localhost/api/factory-quotes'
const tenant = randomUUID(), org = randomUUID(), operator = randomUUID(), approver = randomUUID(), reader = randomUUID()
const full = ['view', 'edit', 'configure', 'publish_template', 'cost', 'technical', 'delivery', 'approve', 'release', 'review'].map(x => `factory_quotes.${x}`)

withPg('factory quote HTTP handlers on PostgreSQL', () => {
  let orm: MikroORM
  const schema = `fq_${randomUUID().replaceAll('-', '')}`
  beforeAll(async () => {
    const target = new URL(url!)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) throw new Error('Use an isolated localhost test database')
    orm = await MikroORM.init({ clientUrl: url, schema, entities: [QuoteRecord, QuoteEvent], extensions: [Migrator],
      migrations: { migrationsList: [Migration20261125190000_factory_quotes], snapshot: false }, pool: { max: 6 } })
    await orm.em.fork().execute(`create schema "${schema}"`)
    await orm.migrator.up({ schema })
    jest.mocked(getAuthFromRequest).mockImplementation(async (request) => {
      const sub = request.headers.get('x-test-user')
      const orgId = request.headers.get('x-test-org') ?? org
      return sub ? { sub, orgId, tenantId: request.headers.get('x-test-tenant') ?? tenant, roles: [] } : null
    })
    jest.mocked(createRequestContainer).mockImplementation(async () => {
      const services: Record<string, unknown> = {
        em: orm.em.fork(), rbacService: {
          getGrantedFeatures: async (sub: string) => sub === reader ? ['factory_quotes.view'] : full,
          userHasAllFeatures: async (sub: string, required: string[]) => required.every(x => sub === reader ? x === 'factory_quotes.view' : full.includes(x)),
        },
        commandBus: { execute: async (_id: string, params: { input: Mutation; ctx: CommandRuntimeContext }) => ({ result: await command.execute(params.input, params.ctx) }) },
      }
      return { resolve: (key: string) => services[key] } as Awaited<ReturnType<typeof createRequestContainer>>
    })
  }, 30_000)
  afterAll(async () => {
    if (!orm) return
    try { await orm.em.fork().execute(`drop schema if exists "${schema}" cascade`) } finally { await orm.close(true) }
  })
  const post = (id: string, revision: number, action: Mutation['action'], user = operator) => POST(new Request(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': user }, body: JSON.stringify({ id, revision, action, token: randomUUID() }),
  }))
  async function ok(response: Promise<Response>) {
    const res = await response
    const body = await res.json()
    expect({ status: res.status, error: body.error }).toEqual({ status: 200, error: undefined })
    return body
  }

  test('migration, concurrent CSV idempotency, permission projection, approval and formal publication', async () => {
    const templateId = randomUUID(), id = randomUUID()
    await ok(post(templateId, -1, { type: 'new_template', spec: sku }))
    await ok(post(templateId, 0, { type: 'test_template' }))
    await ok(post(templateId, 1, { type: 'publish_template' }))
    const now = new Date().toISOString().slice(0, 10)
    const future = '2099-01-01'
    await ok(post(id, -1, { type: 'new_quote', templateId, draft: { customer: '虚构客户', items: [{ name: '01', quantity: '1', price: '0', fields: {} }],
      destination: '苏州', freight: '含运费', payment: '预付', taxRate: '0.13', delivery: future, validUntil: future, exceptional: false } }))
    const csv = '品名,数量,单位未税售价,料号\n虚构零件,600,184,00017\n'
    const upload = (action?: { receipt: string; mapping: Record<string, number>; from: number; to: number }, token = randomUUID()) => POST(new Request(endpoint, {
      method: 'POST', headers: { 'content-type': 'text/csv', 'x-test-user': operator,
        'x-factory-csv': JSON.stringify({ id, revision: 0, templateId, headerRow: 1, token, apply: action }) }, body: csv,
    }))
    const stage = await ok(upload())
    const apply = { receipt: stage.receipt, mapping: { name: 1, quantity: 2, price: 3, 'field:sku': 4 }, from: 2, to: 2 }
    const token = randomUUID()
    const replays = await Promise.all([ok(upload(apply, token)), ok(upload(apply, token))])
    expect(replays.map((r) => r.revision)).toEqual([1, 1])
    expect((await upload(apply)).status).toBe(409)
    expect(await orm.em.fork().count(QuoteEvent, { recordId: id, action: 'csv_import' })).toBe(1)
    await ok(post(id, 1, { type: 'evidence', rates: [{ purchase: { rate: '144', source: 'PRIVATE-SUPPLIER', validFrom: now, validUntil: future } }] }))
    for (const [index, kind] of (['technical', 'cost', 'delivery'] as const).entries()) {
      await ok(post(id, 2 + index, { type: 'confirm', confirmation: { kind, evidence: '虚构依据' } }))
    }
    await ok(post(id, 5, { type: 'submit' }))
    expect((await post(id, 6, { type: 'approve' })).status).toBe(403)
    await ok(post(id, 6, { type: 'approve' }, approver))
    await ok(post(id, 7, { type: 'release' }))
    const formal = await ok(post(id, 8, { type: 'export' }, reader))
    expect(formal.document).toMatchObject({ subtotal: '110400.00', items: [{ quantity: '600', specs: [{ value: '00017' }] }] })
    expect(JSON.stringify(formal.document)).not.toContain('PRIVATE-SUPPLIER')
    const detail = (headers: Record<string, string>) => GET(new Request(`${endpoint}?id=${id}`, { headers }))
    const safe = await ok(detail({ 'x-test-user': reader }))
    expect(JSON.stringify(safe)).not.toContain('PRIVATE-SUPPLIER')
    expect(safe.state.calc).not.toHaveProperty('total')
    expect((await detail({})).status).toBe(401)
    expect((await detail({ 'x-test-user': operator, 'x-test-org': randomUUID() })).status).toBe(404)
    expect((await detail({ 'x-test-user': operator, 'x-test-tenant': randomUUID() })).status).toBe(404)
    expect((await post(id, 8, { type: 'release' }, reader)).status).toBe(403)
    await ok(post(id, 8, { type: 'outcome', result: 'won', source: '虚构订单' }))
    await ok(post(id, 9, { type: 'actual', actual: { quantity: '580', totalCost: '87000', materialUsage: '200 kg', prepHours: '2', workHours: '300', subcontract: '700', source: '模拟履约记录', comment: '批量下调' } }))
    const reviewed = await ok(detail({ 'x-test-user': operator }))
    expect(reviewed.state.variance).toMatchObject({ quotedQuantity: '600', quotedUnitCost: '144.00', actualUnitCost: '150.00', unitDifference: '6.00' })
    expect((await ok(post(id, 10, { type: 'export' }, reader))).document).toEqual(formal.document)
    const candidate = randomUUID()
    await ok(post(candidate, -1, { type: 'new_quote', templateId, draft: { customer: '新询价',
      items: [{ name: '样件', quantity: '500', price: '0', fields: { sku: '00017' } }],
      destination: '', freight: '', payment: '', taxRate: '0', exceptional: false } }))
    const similar = (headers: Record<string, string>) => GET(new Request(`${endpoint}?id=${candidate}&similar=1`, { headers }))
    const matches = await ok(similar({ 'x-test-user': reader }))
    expect(matches.items).toMatchObject([{ id, templateId, historicUnitPrice: '184',
      matches: [{ key: 'sku', historical: '00017' }], differences: [{ key: '$quantity', current: '500', historical: '600' }] }])
    expect(JSON.stringify(matches)).not.toContain('PRIVATE-SUPPLIER')
    expect((await similar({ 'x-test-user': operator, 'x-test-org': randomUUID() })).status).toBe(404)
    expect((await similar({ 'x-test-user': operator, 'x-test-tenant': randomUUID() })).status).toBe(404)
    const unchanged = await ok(GET(new Request(`${endpoint}?id=${candidate}`, { headers: { 'x-test-user': operator } })))
    expect(unchanged).toMatchObject({ revision: 0, state: { rates: [], draft: { items: [{ price: '0' }] } } })

  })
})
