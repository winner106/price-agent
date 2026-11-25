import { csvSuggestions, csvTargets, mapRows, parseCsv, readCsv } from '../lib/csv'
import { machining } from '../lib/seeds'
import { apply, startQuote, type QuoteState } from '../lib/workflow'

const sample = '\ufeff说明\r\n品名,数量,单位未税售价,图号,长度,准备工时\r\n"法兰,独立\r\n行",600,184,00017,10 cm,2\r\n\r\n第三项,1,0,00018,5 mm,0\r\n'
const publicMapping = { name: 1, quantity: 2, price: 3, 'field:drawing': 4, 'field:length': 5 }
test('physical row coordinates survive blank lines, CRLF, quotes and a custom header', () => {
  const parsed = parseCsv(sample, 2)
  expect(parsed.header.row).toBe(2)
  expect(parsed.rows.map((row) => row.row)).toEqual([3, 6])
  expect(parsed.rows[0].cells).toEqual(['法兰,独立\n行', '600', '184', '00017', '10 cm', '2'])
  const result = mapRows(parsed, machining, false, publicMapping, { from: 3, to: 6 })
  expect(result.items[0]).toMatchObject({ quantity: '600', price: '184', fields: { drawing: '00017', length: '10 cm' } })
  expect(result.sourceRows[0]).toMatchObject({ row: 3, original: { 'field:drawing': '00017' } })
})

test('ambiguous and duplicated header matches are not auto-selected', () => {
  const parsed = parseCsv('品名,name,数量,数量\n法兰,法兰,1,2')
  expect(csvSuggestions(parsed.header.cells, csvTargets(machining, false))).toMatchObject({ name: null, quantity: null })
  expect(() => mapRows(parsed, machining, false, { name: 1, quantity: 1 }, { from: 2, to: 2 })).toThrow('csv_mapping_conflict')
  expect(mapRows(parsed, machining, false, { name: 1, quantity: 4 }, { from: 2, to: 2 }).items[0].quantity).toBe('2')
})

test('private mappings are denied and invalid rows cannot partially map', () => {
  const parsed = parseCsv(sample.replace('5 mm', '5 kg'), 2)
  expect(() => mapRows(parsed, machining, false, { ...publicMapping, 'field:prep': 6 }, { from: 3, to: 3 })).toThrow('csv_forbidden_mapping')
  expect(() => mapRows(parsed, machining, false, publicMapping, { from: 3, to: 6 })).toThrow('csv_invalid_field')
  expect(() => mapRows(parsed, machining, false, publicMapping, { from: 4, to: 6 })).toThrow('csv_invalid_range')
  expect(() => mapRows(parseCsv('品名,数量\n=FORMULA,1'), machining, false, { name: 1, quantity: 2 }, { from: 2, to: 2 })).toThrow('csv_formula_value')
})

test('strict quoting and row, column and UTF-8 limits fail closed', async () => {
  expect(() => parseCsv('h,b\n"x,1')).toThrow('csv_invalid_quotes')
  expect(() => parseCsv('h,b\n"x"suffix,1')).toThrow('csv_invalid_quotes')
  expect(() => parseCsv('h,b\nx,1,2')).toThrow('csv_width_mismatch')
  expect(() => parseCsv(`${'a,'.repeat(100)}a\nx,1`)).toThrow('csv_too_many_columns')
  expect(() => parseCsv(`h,b\n${'a,1\n'.repeat(10_001)}`)).toThrow('csv_too_many_rows')
  await expect(readCsv(new Request('http://localhost', { method: 'POST', body: new Uint8Array([0xC0, 0x80]) }))).rejects.toThrow('csv_encoding')
  await expect(readCsv(new Request('http://localhost', { method: 'POST', body: 'h,b\na,1\n' }))).resolves.toMatchObject({ text: 'h,b\na,1\n', digest: expect.stringMatching(/^[a-f0-9]{64}$/) })
})

test('preview is side-effect free and applying is limited to the draft and template version', () => {
  const draft = { customer: 'TEST', items: [{ name: '01', quantity: '1', price: '0', fields: {} }], destination: '', freight: '', payment: '', taxRate: '0', exceptional: false }
  const version = 'a5ff1f74-83e7-4a50-bf0d-57f0dad496d3'
  const row = startQuote({ type: 'template', stage: 'published', tested: true, spec: machining }, version, draft, false)
  const at = '2032-01-01T00:00:00Z'
  const parsed = parseCsv(sample, 2)
  const base = { templateId: version, digest: 'a'.repeat(64), headerRow: 2 }
  expect(apply(row, { ...base, type: 'csv_preview', headers: parsed.header.cells, totalRows: 2 }, 'user', at, false)).toBe(row)
  const payload = { ...base, type: 'csv_import' as const, receipt: version, mapping: publicMapping, from: 3, to: 6, ...mapRows(parsed, machining, false, publicMapping, { from: 3, to: 6 }) }
  const changed = apply(row, payload, 'user', at, false) as QuoteState
  expect(changed.draft.items).toHaveLength(2)
  expect(row.draft.items).toHaveLength(1)
  const existing = { ...row, draft: { ...row.draft, items: [{ ...row.draft.items[0], name: '既有项' }] } }
  const appended = apply(existing, payload, 'user', at, false) as QuoteState
  expect(appended.draft.items.map((i) => i.name)).toEqual(['既有项', '法兰,独立\n行', '第三项'])
  expect(() => apply({ ...row, stage: 'published' }, payload, 'user', at, false)).toThrow('draft_required')
  expect(() => apply(row, { ...payload, templateId: 'another' }, 'user', at, false)).toThrow('draft_required')
})
