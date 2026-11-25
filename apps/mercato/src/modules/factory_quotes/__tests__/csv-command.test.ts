import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { QuoteEvent, QuoteRecord } from '../data/entities'
import type { Mutation } from '../data/validators'
import { resolveAccess } from '../lib/access'
import { machining } from '../lib/seeds'
import '../commands/workspace'
import { registerCommand } from '@open-mercato/shared/lib/commands'

jest.mock('@open-mercato/shared/lib/commands', () => ({ registerCommand: jest.fn() }))
jest.mock('@mikro-orm/core', () => ({ LockMode: { PESSIMISTIC_WRITE: 'write' }, UniqueConstraintViolationException: class UniqueConstraintViolationException extends Error {} }))
jest.mock('../data/entities', () => ({ QuoteEvent: class QuoteEvent {}, QuoteRecord: class QuoteRecord {} }))
jest.mock('../lib/access', () => ({ resolveAccess: jest.fn() }))

const command = jest.mocked(registerCommand).mock.calls[0][0] as CommandHandler<Mutation, { receipt?: string; revision: number }>
const actor = '2d347750-6778-4565-98b9-046733584c9a'
const scope = { organizationId: 'org-test', tenantId: 'tenant-test' }
const id = 'a921d7b4-334b-41b6-8153-6aa9edad21ed'
const templateId = '66e43b8c-c83d-4f63-a95a-be6109cbbefe'
const digest = 'a'.repeat(64)
const empty = { customer: 'TEST', items: [{ name: '01', quantity: '1', price: '0', fields: {} }], destination: '', payment: '', freight: '', taxRate: '0', exceptional: false }
const importKey = '68ac2622-a3d9-4d82-82a7-95adccc1ab73'
const previewKey = '81aa09be-025c-475a-ac81-8d24a92fb4d1'
const previewAction = { type: 'csv_preview' as const, templateId, digest, headerRow: 1, headers: ['name', 'qty'], totalRows: 1 }
const item = { name: '法兰', quantity: '1', price: '0', fields: {} }
function setup() {
  const events: QuoteEvent[] = []
  const row = Object.assign(new QuoteRecord(), { ...scope, id, revision: 0, state: { type: 'quote', stage: 'draft', templateId, template: machining, draft: empty, rates: [], confirmations: {} } })
  const findOne = jest.fn(async (entity, criteria: Record<string, unknown>) => {
    const rows = entity === QuoteRecord ? [row] : events
    return rows.find((r) => Object.entries(criteria).every(([k, v]) => Reflect.get(r, k) === v)) ?? null
  })
  const tx = { findOne, create: (entity: new () => object, data: object) => Object.assign(new entity(), data),
    persist: (entity: QuoteEvent | QuoteRecord) => { if (entity instanceof QuoteEvent) events.push(entity) } }
  const transactional = async <T>(fn: (tm: typeof tx) => Promise<T>) => fn(tx)
  const ctx = { container: { resolve: () => ({ fork: () => ({ transactional }) }) } } as unknown as CommandRuntimeContext
  jest.mocked(resolveAccess).mockResolvedValue({ actor, scope, have: new Set(['edit', 'view']), grants: [] })
  const run = (action: Mutation['action'], token: string, revision = 0) => command.execute({ id, action, token, revision }, ctx)
  return { events, row, findOne, run }
}
function importAction(receipt: string) {
  return { type: 'csv_import' as const, templateId, digest, headerRow: 1, receipt,
    mapping: { name: 1, quantity: 2 }, from: 2, to: 2, items: [item], sourceRows: [{ row: 2, original: { name: item.name, quantity: item.quantity } }] }
}

test('same request token replays; same batch with a fresh preview and token does not append', async () => {
  const { run, row, events } = setup()
  const preview = await run(previewAction, previewKey)
  const action = importAction(preview.receipt!)
  expect(row.revision).toBe(0)
  expect(await run(action, importKey)).toEqual({ id, revision: 1 })
  expect(await run(action, importKey)).toEqual({ id, revision: 1 })
  expect(events.filter((event) => event.action === 'csv_import')).toHaveLength(1)
  expect(row.state.draft.items).toHaveLength(1)
  const second = await run(previewAction, crypto.randomUUID(), 1)
  await expect(run(importAction(second.receipt!), crypto.randomUUID(), 1)).rejects.toMatchObject({ status: 409, code: 'csv_already_imported' })
})

test('different content, users and stale revisions cannot reuse a staged preview', async () => {
  const { run, row, events, findOne } = setup()
  const preview = await run(previewAction, previewKey)
  const action = importAction(preview.receipt!)
  await expect(run({ ...action, digest: 'b'.repeat(64) }, importKey)).rejects.toMatchObject({ status: 409, code: 'csv_preview_mismatch' })
  jest.mocked(resolveAccess).mockResolvedValueOnce({ actor: crypto.randomUUID(), scope, have: new Set(['edit', 'view']), grants: [] })
  await expect(run(action, importKey)).rejects.toMatchObject({ status: 409, code: 'csv_preview_mismatch' })
  jest.mocked(resolveAccess).mockResolvedValueOnce({ actor, scope: { ...scope, organizationId: 'other' }, have: new Set(['edit', 'view']), grants: [] })
  await expect(run(action, importKey)).rejects.toMatchObject({ status: 404, code: 'not_found' })
  row.revision = 1
  await expect(run(action, importKey)).rejects.toMatchObject({ status: 409, code: 'stale_revision' })
  expect(events).toHaveLength(1)
  expect(findOne.mock.calls.some(([entity, criteria]) => entity === QuoteRecord && criteria.organizationId === 'other')).toBe(true)
})
