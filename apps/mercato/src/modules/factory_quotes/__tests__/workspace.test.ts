import { evaluate, publicQuote, validateTemplate } from '../lib/engine'
import { machining, sku } from '../lib/seeds'
import { apply, project, startQuote, templateTest, type QuoteState, type TemplateState } from '../lib/workflow'
import type { Draft, Evidence, Template } from '../data/validators'

const time = '2032-01-01T10:00:00.000Z'
const day = time.slice(0, 10)
const customer = '虚构工厂'
const template = (spec: Template = machining): TemplateState => ({ type: 'template', stage: 'published', tested: true, spec })
const inquiry = (): Draft => ({ customer, items: [{ name: '样例法兰', price: '184', quantity: '600', fields: {
  drawing: '00017', drawing_rev: 'B', material: '6061', length: '10 cm', tolerance: '±0.05 mm', finish: '阳极氧化', prep: '2', cycle: '0.5', outsourced: 'true',
} }], requestedDelivery: day, delivery: '2032-02-01', validUntil: '2032-01-31', payment: '预付', freight: '含至指定地点', destination: '苏州', taxRate: '0.13', exceptional: false })
const evidence = (rate: string): Evidence => ({ rate, source: 'Internal cost source', validFrom: day, validUntil: '2032-01-03' })
const rates = (): QuoteState['rates'] => [{ material: evidence('120'), setup: evidence('300'), machine: evidence('40'), outside: evidence('600'), packing: evidence('1200') }]
const confirm = { actor: 'operator', at: time, evidence: 'Confirmed' }
const confirmations = { technical: confirm, cost: confirm, delivery: confirm }
const applyQuote = (row: QuoteState, action: Parameters<typeof apply>[1], by = 'operator', at = time) => apply(row, action, by, at, true) as QuoteState
const ready = (): QuoteState => ({ ...startQuote(template(), 'v1', inquiry(), true), rates: rates(), confirmations })

test('CNY exact calculation and a threshold higher than the unrounded yield', () => {
  const spec = { ...machining, approval: { ...machining.approval, direct: true, minReturn: '0.2174' } }
  const result = evaluate(spec, inquiry(), rates(), confirmations, day)
  expect(result).toMatchObject({ sale: '110400.00', total: '86400.00', income: '24000.00', returnPercent: '21.74', status: 'APPROVAL_REQUIRED', reasons: ['return'] })
  expect(result.rows[0].unitCost).toBe('144.00')
  expect(evaluate({ ...spec, approval: { ...spec.approval, minReturn: '0.21739' } }, inquiry(), rates(), confirmations, day).status).toBe('DIRECT_RELEASE')
})

test('compatible dimension accepted, unknown condition and wrong dimension block', () => {
  const q = inquiry()
  expect(evaluate(machining, q, rates(), confirmations, day).missing).toEqual([])
  q.items[0].fields.length = '10 kg'
  delete q.items[0].fields.outsourced
  expect(evaluate(machining, q, rates(), confirmations, day)).toMatchObject({ status: 'BLOCKED', missing: ['1:invalid:length', '1:outsourced'] })
})

test('missing subcontract evidence cannot be approved and expired evidence prevents release', () => {
  const row = ready()
  delete row.rates[0].outside
  expect(() => applyQuote(row, { type: 'submit' })).toThrow('publication_blocked')
  const pending = applyQuote(ready(), { type: 'submit' })
  expect(() => applyQuote(pending, { type: 'approve' })).toThrow('self_approval')
  const approved = applyQuote(pending, { type: 'approve' }, 'approver')
  expect(() => applyQuote(approved, { type: 'release' }, 'releaser', '2032-01-05T01:00:00.000Z')).toThrow('publication_blocked')
})

test('drawing edit reopens reviews without changing the frozen proposal', () => {
  const pending = applyQuote(ready(), { type: 'submit' })
  const draft = inquiry()
  draft.items[0].fields.drawing_rev = 'C'
  const edited = applyQuote(pending, { type: 'edit_quote', draft })
  expect(edited).toMatchObject({ stage: 'draft', rates: [], confirmations: {} })
  expect(edited.submission).toBeUndefined()
  expect(pending.submission?.frozen.draft.items[0].fields.drawing_rev).toBe('B')
})

test('formal output and unrestricted projection exclude cost data', () => {
  const row = ready()
  const calc = evaluate(row.template, row.draft, row.rates, row.confirmations, day)
  const external = JSON.stringify(publicQuote(row.template, row.draft, calc))
  const regular = JSON.stringify(project(row, day, false))
  for (const secret of ['Internal cost source', '86400', 'prep', 'cycle', '24000']) {
    expect(external).not.toContain(secret)
    expect(regular).not.toContain(secret)
  }
  expect(external).toContain('00017')
  expect(() => startQuote(template(), 'v1', inquiry(), false)).toThrow('protected_field')
})

test('formal records are immutable; actuals create a comparison without changing publication', () => {
  const approved = applyQuote(applyQuote(ready(), { type: 'submit' }), { type: 'approve' }, 'approver')
  const released = applyQuote(approved, { type: 'release' }, 'releaser')
  expect(() => applyQuote(released, { type: 'edit_quote', draft: inquiry() })).toThrow('immutable_quote')
  const won = applyQuote(released, { type: 'outcome', result: 'won', source: 'Acceptance' })
  const final = applyQuote(won, { type: 'actual', actual: { totalCost: '87000', quantity: '580', materialUsage: '200 kg', prepHours: '2', workHours: '300', subcontract: '700', source: 'MES extract', comment: 'Batch reduced' } })
  expect(final.release).toEqual(released.release)
  expect(project(final, day, true).variance).toMatchObject({ quotedQuantity: '600', quotedUnitCost: '144.00', actualUnitCost: '150.00', unitDifference: '6.00' })
})

test('seed trial validates aliases and missing dependency', () => {
  expect(templateTest(machining).missing).toEqual([])
  expect(templateTest(sku).missing).toEqual([])
  const spec = structuredClone(machining)
  spec.fields[1].aliases = ['ＤＲＡＷＩＮＧ']
  spec.fields[1].requiredWhen = { field: 'drawing_rev', equals: 'A' }
  expect(validateTemplate(spec)).toEqual(['alias:drawing', 'condition:drawing_rev'])
})

test('drafts can mix offline delivery attribution and online cost confirmation', () => {
  const row = { ...ready(), confirmations: {} }
  const submitted = applyQuote(row, { type: 'confirm', confirmation: { kind: 'delivery', sourcePerson: '线下计划员', evidence: '排程记录' } })
  expect(submitted.confirmations.delivery?.sourcePerson).toBe('线下计划员')
  expect(() => applyQuote(submitted, { type: 'confirm', confirmation: { kind: 'cost', sourcePerson: '代录', evidence: '采购' } })).toThrow('online_confirmation_required')
  expect(applyQuote(submitted, { type: 'confirm', confirmation: { kind: 'cost', evidence: '采购依据' } }, 'purchasing').confirmations.cost?.actor).toBe('purchasing')
})
