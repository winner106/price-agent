import { machining } from '../lib/seeds'
import { compareHistory } from '../lib/similarity'
import { type QuoteState } from '../lib/workflow'

function part(fields: Record<string, string>, quantity = '20'): QuoteState {
  return { type: 'quote', stage: 'draft', templateId: 't', template: machining, confirmations: {}, rates: [],
    draft: { customer: 'private customer', items: [{ fields, quantity, name: 'flange', price: '184' }],
      destination: '', payment: '', freight: '', taxRate: '0', exceptional: false } }
}
function history(fields: Record<string, string>): QuoteState {
  const row = part(fields, '30')
  // Only the frozen specs, date and price are read by the comparator.
  return { ...row, stage: 'published', release: { at: '2030-01-01', frozen: { template: row.template, draft: row.draft } } as NonNullable<QuoteState['release']> }
}

test('compares equivalent units exactly and reports original values, process and batch differences', () => {
  const row = part({ length: '10 cm', material: '6061', finish: 'clear', prep: '15' })
  const existing = history({ length: '100 mm', material: '6061', finish: 'black', prep: '9999' })
  const result = compareHistory(row, row.draft.items[0], [{ id: 'old', state: existing }, { id: 'draft', state: row }])
  expect(result).toMatchObject([{ id: 'old', matches: [{ key: 'material' }, { key: 'length', current: '10 cm', historical: '100 mm' }],
    differences: [{ key: 'finish', current: 'clear', historical: 'black' }, { key: '$quantity', current: '20', historical: '30' }] }])
  expect(JSON.stringify(result)).not.toMatch(/9999|private customer/)
})

test('invalid dimensions and only private matches do not qualify', () => {
  const row = part({ length: '10 cm', prep: '5' })
  expect(compareHistory(row, row.draft.items[0], [{ id: 'old', state: history({ length: '10 kg', prep: '5' }) }])).toEqual([])
})
