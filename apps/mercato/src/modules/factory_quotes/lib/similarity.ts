import type { Draft, Template } from '../data/validators'
import { fieldValue, normalizedMeasure } from './engine'
import type { QuoteState } from './workflow'

const identifiers = new Set(['sku', 'drawing', 'material'])
const processFields = new Set(['finish', 'surface', 'surface_treatment', 'process', 'manufacturing_process', 'tolerance', 'drawing_rev'])
const normalize = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
type Change = { key: string; label: string; current: string | null; historical: string | null; relation: 'match' | 'different' | 'unknown' }
type History = { id: string; state: QuoteState }
export type SimilarQuote = {
  id: string; templateId: string; publishedAt: string; validUntil?: string; item: string; line: number;
  historicUnitPrice: string; matches: Change[]; differences: Change[];
}

/** Side-effect free. Do not pass unpublished states or project private fields. */
export function compareHistory(current: QuoteState, item: Draft['items'][number], history: History[]): SimilarQuote[] {
  const fields = current.template.fields.filter((f) => f.public &&
    (f.type === 'measure' || identifiers.has(f.key) || processFields.has(f.key)))
  const compareField = (field: Template['fields'][number], left?: string, right?: string): Change[] => {
    if (!left?.trim() && !right?.trim()) return []
    const base = { key: field.key, label: field.label, current: left || null, historical: right || null }
    if (!left?.trim() || !right?.trim() || !fieldValue(field, left) || !fieldValue(field, right)) return [{ ...base, relation: 'unknown' }]
    if (field.type === 'measure') {
      const lhs = normalizedMeasure(left)!, rhs = normalizedMeasure(right)!
      return [{ ...base, relation: lhs.dimension === rhs.dimension && lhs.amount === rhs.amount ? 'match' : 'different' }]
    }
    return [{ ...base, relation: normalize(left) === normalize(right) ? 'match' : 'different' }]
  }
  return history.flatMap(({ id, state }) => {
    if (state.stage !== 'published' || !state.release) return []
    const { frozen, at } = state.release
    const oldFields = new Map(frozen.template.fields.filter((field) => field.public).map((f) => [f.key, f]))
    return frozen.draft.items.flatMap((row, index) => {
      const comparisons = fields.flatMap((field) => {
        const old = oldFields.get(field.key)
        return old?.type === field.type ? compareField(field, item.fields[field.key], row.fields[field.key]) : []
      })
      const matches = comparisons.filter((x) => x.relation === 'match')
      // Similar quantity alone is not evidence that a part or process is similar.
      if (!matches.some((x) => x.key !== 'drawing_rev')) return []
      const differences = comparisons.filter((x) => x.relation !== 'match')
      const qty: Change = { key: '$quantity', label: '批量', current: item.quantity, historical: row.quantity,
        relation: item.quantity === row.quantity ? 'match' : 'different' }
      if (qty.relation === 'match') matches.push(qty)
      else differences.push(qty)
      const score = matches.reduce((sum, x) => sum + (identifiers.has(x.key) ? 4 : 1), 0)
      return [{ score, result: { id, templateId: state.templateId, publishedAt: at, validUntil: frozen.draft.validUntil,
        item: row.name, line: index + 1, historicUnitPrice: row.price, matches, differences } }]
    })
  }).sort((a, b) => b.score - a.score || a.result.differences.length - b.result.differences.length ||
    b.result.publishedAt.localeCompare(a.result.publishedAt) || a.result.id.localeCompare(b.result.id) || a.result.line - b.result.line)
    .slice(0, 8).map(({ result }) => result)
}
