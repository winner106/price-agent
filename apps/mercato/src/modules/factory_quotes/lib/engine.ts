import type { Draft, Evidence, Template } from '../data/validators'
import { S, exact, display, decimalPattern } from './money'

const units: Record<string, [string, bigint]> = {
  mm: ['length', 1n], cm: ['length', 10n], m: ['length', 1000n],
  mm2: ['area', 1n], cm2: ['area', 100n], m2: ['area', 1000000n],
  g: ['mass', 1n], kg: ['mass', 1000n], min: ['time', 1n], h: ['time', 60n],
}
const norm = (v: string) => v.normalize('NFKC').trim().toLowerCase()
export function validateTemplate(t: Template): string[] {
  const issues: string[] = []
  const names = new Map<string, string>()
  const fields = new Map(t.fields.map((f) => [f.key, f]))
  if (fields.size !== t.fields.length || new Set(t.rules.map((r) => r.key)).size !== t.rules.length) issues.push('duplicate_key')
  for (const field of t.fields) {
    for (const name of [field.key, field.label, ...field.aliases].map(norm)) {
      if (!name || (names.has(name) && names.get(name) !== field.key)) issues.push(`alias:${name}`)
      names.set(name, field.key)
    }
    if ((field.type === 'measure') !== !!field.unit) issues.push(`unit:${field.key}`)
    if (['select', 'multi'].includes(field.type) && (!field.options.length || new Set(field.options).size !== field.options.length)) issues.push(`options:${field.key}`)
    const seen = new Set([field.key])
    let dep = field.requiredWhen?.field
    while (dep) {
      if (!fields.has(dep) || seen.has(dep)) { issues.push(`condition:${field.key}`); break }
      seen.add(dep)
      dep = fields.get(dep)?.requiredWhen?.field
    }
  }
  for (const rule of t.rules) {
    if (rule.when && !fields.has(rule.when.field)) issues.push(`condition:${rule.key}`)
    const hours = rule.basis === 'prep_hours' || rule.basis === 'piece_hours'
    if (hours !== !!rule.driver || (rule.driver && !['integer', 'decimal'].includes(fields.get(rule.driver)?.type ?? ''))) issues.push(`driver:${rule.key}`)
  }
  if (exact(t.approval.minReturn) >= S) issues.push('invalid_return_threshold')
  return [...new Set(issues)]
}

export function normalizedMeasure(value: string): { dimension: string; amount: bigint } | null {
  const [amount, unit, extra] = value.trim().split(/\s+/)
  if (extra || !decimalPattern.test(amount) || !Object.hasOwn(units, unit)) return null
  const [dimension, factor] = units[unit]
  return { dimension, amount: exact(amount) * factor }
}

export function fieldValue(field: Template['fields'][number], value: string): boolean {
  switch (field.type) {
    case 'integer': return /^(0|[1-9]\d{0,11})$/.test(value)
    case 'decimal': return decimalPattern.test(value)
    case 'boolean': return value === 'true' || value === 'false'
    case 'select': return field.options.includes(value)
    case 'multi': { const entries = value.split(',').map((x) => x.trim()); return new Set(entries).size === entries.length && entries.every((x) => field.options.includes(x)) }
    case 'date': { const time = Date.parse(value); return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value }
    case 'measure': {
      const measure = normalizedMeasure(value)
      return !!measure && !!field.unit && measure.dimension === units[field.unit][0]
    }
    default: return !!value.trim()
  }
}

export type ConfirmationKind = 'technical' | 'cost' | 'delivery'
export type Confirmation = { actor: string; evidence: string; sourcePerson?: string; at: string }
export type Rates = Record<string, Evidence>[]
const condition = (fields: Record<string, string>, when?: { field: string; equals: string }) => !when ? true
  : Object.hasOwn(fields, when.field) && fields[when.field].trim() ? fields[when.field] === when.equals : undefined

export function evaluate(template: Template, draft: Draft, rates: Rates, confirmations: Partial<Record<ConfirmationKind, Confirmation>>, day: string) {
  const missing: string[] = []
  const costing: string[] = []
  let total = 0n, manufacturing = 0n, sales = 0n
  const rows = draft.items.map((item, i) => {
    const prefix = `${i + 1}:`
    let lineCost = 0n
    for (const field of template.fields) {
      const value = Object.hasOwn(item.fields, field.key) ? item.fields[field.key] : ''
      const active = condition(item.fields, field.requiredWhen)
      if (active === undefined) missing.push(`${prefix}${field.requiredWhen!.field}`)
      if (!value.trim() && (field.required || (field.requiredWhen && active === true))) missing.push(`${prefix}${field.key}`)
      if (value.trim() && !fieldValue(field, value)) missing.push(`${prefix}invalid:${field.key}`)
    }
    const quantity = BigInt(item.quantity)
    let activeRuleCount = 0
    const details = template.rules.flatMap((rule) => {
      const active = condition(item.fields, rule.when)
      if (active === false) return []
      if (active === undefined) { missing.push(`${prefix}${rule.when!.field}`); return [] }
      activeRuleCount++
      const e = rates[i]?.[rule.key]
      if (!e || day < e.validFrom || day > e.validUntil) { costing.push(`${prefix}basis:${rule.key}`); return [] }
      let factor = S
      if (rule.basis === 'unit') factor *= quantity
      if (rule.driver) {
        const value = item.fields[rule.driver]
        if (!value || !decimalPattern.test(value)) { missing.push(`${prefix}${rule.driver}`); return [] }
        factor = exact(value) * (rule.basis === 'piece_hours' ? quantity : 1n)
      }
      const cost = factor * exact(e.rate)
      lineCost += cost
      if (rule.layer === 'manufacturing') manufacturing += cost
      return [{ rule: rule.key, label: rule.label, basis: rule.basis, evidence: e, factor: display(factor, S, 6), amount: display(cost, S * S) }]
    })
    if (!activeRuleCount) costing.push(`${prefix}no_active_cost_rule`)
    total += lineCost
    const lineSales = exact(item.price) * quantity * S
    sales += lineSales
    return { details, unitCost: display(lineCost, S * S * quantity), batchCost: display(lineCost, S * S),
      sale: display(lineSales, S * S) }
  })
  if (!draft.delivery || draft.delivery < day) missing.push('delivery')
  if (!draft.validUntil || draft.validUntil < day) missing.push('valid_until')
  if (!draft.destination) missing.push('destination')
  if (!draft.payment) missing.push('payment')
  if (!draft.freight) missing.push('freight')
  if (exact(draft.taxRate) > S) missing.push('tax_rate')
  if (sales <= 0n || draft.items.some((item) => exact(item.price) === 0n)) missing.push('price')
  for (const key of ['technical', 'cost', 'delivery'] as const) if (!confirmations[key]) missing.push(`confirmation:${key}`)
  const needs = [!template.approval.direct && 'policy', draft.exceptional && 'exceptional',
    sales > exact(template.approval.maxAmount) * S && 'amount',
    sales > 0n && S * (sales - total) < exact(template.approval.minReturn) * sales && 'return',
  ].filter((v): v is string => typeof v === 'string')
  const status = missing.length || costing.length ? 'BLOCKED' : needs.length ? 'APPROVAL_REQUIRED' : 'DIRECT_RELEASE'
  return { status, missing: [...new Set(missing)], costing, reasons: needs, rows,
    sale: display(sales, S * S), tax: display(sales * exact(draft.taxRate), S ** 3n),
    gross: display(sales * (S + exact(draft.taxRate)), S ** 3n),
    total: display(total, S * S), manufacturing: display(manufacturing, S * S),
    income: display(sales - total, S * S), returnPercent: sales > 0n ? display((sales - total) * 100n, sales) : null }
}

export function publicQuote(template: Template, draft: Draft, calc: ReturnType<typeof evaluate>) {
  return { currency: 'CNY', customer: draft.customer, brand: template.brand,
    delivery: draft.delivery, destination: draft.destination, payment: draft.payment, freight: draft.freight,
    validUntil: draft.validUntil, taxRate: draft.taxRate, subtotal: calc.sale, tax: calc.tax, gross: calc.gross,
    items: draft.items.map((item, i) => ({ name: item.name, quantity: item.quantity, unitPrice: item.price,
      subtotal: calc.rows[i].sale, specs: template.fields.filter((f) => f.public && Object.hasOwn(item.fields, f.key) && item.fields[f.key])
        .map((f) => ({ label: f.label, value: item.fields[f.key] })),
    })) }
}
