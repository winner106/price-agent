import { createHash } from 'node:crypto'
import { itemSchema, type Draft, type Template } from '../data/validators'
import { fieldValue } from './engine'

export const CSV_MAX_BYTES = 10 * 1024 * 1024
const CSV_MAX_COLUMNS = 100
const CSV_MAX_ROWS = 10_000
const CSV_MAX_CELL = 4096
export type CsvRow = { row: number; cells: string[] }
export type CsvDocument = { header: CsvRow; rows: CsvRow[] }
export class CsvFault extends Error {
  constructor(public code: string, public position?: { row: number; column?: number }, public status = 422) { super(code) }
}

export async function readCsv(request: Request): Promise<{ digest: string; text: string }> {
  const reader = request.body?.getReader()
  if (!reader) throw new CsvFault('csv_empty')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const hash = createHash('sha256')
  const deadline = Date.now() + 8_000
  const chunks: string[] = []
  let bytes = 0
  try {
    while (true) {
      const remain = deadline - Date.now()
      if (remain <= 0) throw new CsvFault('csv_timeout', undefined, 408)
      let timer: ReturnType<typeof setTimeout> | undefined
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new CsvFault('csv_timeout', undefined, 408)), remain) }),
      ]).finally(() => clearTimeout(timer))
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > CSV_MAX_BYTES) throw new CsvFault('csv_too_large', undefined, 413)
      hash.update(next.value)
      chunks.push(decoder.decode(next.value, { stream: true }))
    }
    chunks.push(decoder.decode())
    return { digest: hash.digest('hex'), text: chunks.join('') }
  } catch (error) {
    void reader.cancel().catch(() => undefined)
    if (error instanceof CsvFault) throw error
    throw new CsvFault('csv_encoding')
  } finally { reader.releaseLock() }
}

// Strict comma-delimited CSV. The existing sync_excel reader tolerates unclosed
// quotes and collapses duplicate headers into objects; an audited quote import
// needs physical coordinates and must refuse ambiguous records instead.
export function parseCsv(text: string, headerRow = 1): CsvDocument {
  let header: CsvRow | undefined
  const rows: CsvRow[] = []
  let row = 1, start = 1, cells: string[] = [], value = '', mode: 'start' | 'plain' | 'quoted' | 'closed' = 'start'
  const position = () => ({ row, column: cells.length + 1 })
  const append = (character: string) => {
    value += character
    if (value.length > CSV_MAX_CELL) throw new CsvFault('csv_cell_too_long', position())
  }
  const nextCell = () => {
    cells.push(value); value = ''; mode = 'start'
    if (cells.length > CSV_MAX_COLUMNS) throw new CsvFault('csv_too_many_columns', position())
  }
  const nextRow = () => {
    nextCell()
    if (start === headerRow && cells.some((x) => x.trim())) header = { row: start, cells }
    if (start > headerRow && cells.some((x) => x.trim())) {
      if (!header) throw new CsvFault('csv_header_missing', { row: headerRow })
      if (cells.length > header.cells.length) throw new CsvFault('csv_width_mismatch', { row: start })
      rows.push({ row: start, cells })
      if (rows.length > CSV_MAX_ROWS) throw new CsvFault('csv_too_many_rows', { row: start })
    }
    cells = []
  }
  const deadline = Date.now() + 4_000
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    if ((i & 4095) === 0 && Date.now() > deadline) throw new CsvFault('csv_timeout', undefined, 408)
    const char = text[i]
    if (char === '\0') throw new CsvFault('csv_encoding', position())
    if (mode === 'quoted') {
      if (char === '"') {
        if (text[i + 1] === '"') { append('"'); i++ } else mode = 'closed'
      } else if (char === '\n' || char === '\r') {
        if (char === '\r' && text[i + 1] === '\n') i++
        append('\n'); row++
      } else append(char)
      continue
    }
    if (char === ',') nextCell()
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++
      nextRow(); row++; start = row
    } else if (char === '"' && mode === 'start') mode = 'quoted'
    else if (char === '"' || mode === 'closed') throw new CsvFault('csv_invalid_quotes', position())
    else { append(char); mode = 'plain' }
  }
  if (mode === 'quoted') throw new CsvFault('csv_invalid_quotes', position())
  if (mode !== 'start' || cells.length) nextRow()
  if (!header) throw new CsvFault('csv_header_missing', { row: headerRow })
  if (!rows.length) throw new CsvFault('csv_no_rows', { row: headerRow })
  return { header, rows }
}

const normal = (s: string) => s.normalize('NFKC').trim().toLowerCase()
export function csvTargets(template: Template, canCost: boolean) {
  return [
    { key: 'name', label: '品名', aliases: ['名称', 'name'], required: true },
    { key: 'quantity', label: '数量', aliases: ['quantity', 'qty'], required: true },
    { key: 'price', label: '单位未税售价', aliases: ['单件未税售价', 'price'], required: false },
    ...template.fields.filter((f) => f.public || canCost).map((f) => ({ key: `field:${f.key}`, label: f.label, aliases: [f.key, ...f.aliases], required: false })),
  ]
}
export function csvSuggestions(header: string[], targets: ReturnType<typeof csvTargets>) {
  const candidates = targets.map((target) => ({ key: target.key, columns: header.flatMap((value, i) =>
    [target.key, target.label, ...target.aliases].some((alias) => normal(alias) === normal(value)) ? [i + 1] : []) }))
  return Object.fromEntries(candidates.map(({ key, columns }) => [key,
    columns.length === 1 && candidates.filter((c) => c.columns.includes(columns[0])).length === 1 ? columns[0] : null]))
}
export type MappedImport = { items: Draft['items']; sourceRows: Array<{ row: number; original: Record<string, string> }> }
export function mapRows(document: CsvDocument, template: Template, canCost: boolean, mapping: Record<string, number>, range: { from: number; to: number }): MappedImport {
  const permitted = new Set(csvTargets(template, canCost).map((t) => t.key))
  if (!mapping.name || !mapping.quantity) throw new CsvFault('csv_missing_mapping')
  const cols = Object.values(mapping)
  if (cols.length !== new Set(cols).size) throw new CsvFault('csv_mapping_conflict')
  for (const [key, column] of Object.entries(mapping)) {
    if (!permitted.has(key)) throw new CsvFault('csv_forbidden_mapping', undefined, 403)
    if (column < 1 || column > document.header.cells.length) throw new CsvFault('csv_invalid_mapping')
  }
  if (range.from > range.to || !document.rows.some((r) => r.row === range.from) || !document.rows.some((r) => r.row === range.to)) throw new CsvFault('csv_invalid_range')
  const selected = document.rows.filter((r) => r.row >= range.from && r.row <= range.to)
  if (selected.length > 50) throw new CsvFault('csv_quote_limit')
  const items: Draft['items'] = []
  const sourceRows: MappedImport['sourceRows'] = []
  const fields = new Map(template.fields.map((f) => [`field:${f.key}`, f]))
  for (const row of selected) {
    const original = Object.fromEntries(Object.entries(mapping).map(([key, col]) => [key, row.cells[col - 1] ?? '']))
    const fieldEntries: [string, string][] = []
    for (const [key, raw] of Object.entries(original)) {
      const value = raw.trim()
      if (raw.length > 250) throw new CsvFault('csv_cell_too_long', { row: row.row, column: mapping[key] })
      if (value.startsWith('=')) throw new CsvFault('csv_formula_value', { row: row.row, column: mapping[key] })
      const field = fields.get(key)
      if (!field || !value) continue
      if (!fieldValue(field, value)) throw new CsvFault('csv_invalid_field', { row: row.row, column: mapping[key] })
      fieldEntries.push([field.key, value])
    }
    const result = itemSchema.safeParse({ name: original.name.trim(), quantity: original.quantity.trim(), price: original.price?.trim() || '0', fields: Object.fromEntries(fieldEntries) })
    if (!result.success) throw new CsvFault('csv_invalid_field', { row: row.row, column: mapping[String(result.error.issues[0]?.path[0])] })
    items.push(result.data)
    sourceRows.push({ row: row.row, original })
  }
  return { items, sourceRows }
}
