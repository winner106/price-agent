'use client'

import { useRef, useState } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { useT } from '@open-mercato/shared/lib/i18n/context'

type Preview = { headers: string[]; rows: { row: number; cells: string[] }[]; totalRows: number; from: number; to: number;
  targets: { key: string; label: string; required: boolean }[]; suggestions: Record<string, number | null> }
type PreviewResult = { receipt?: string; preview?: Preview; error?: string; position?: { row: number; column?: number } }
type Apply = { receipt: string; mapping: Record<string, number>; from: number; to: number }
const selectClass = 'rounded-md border bg-background px-2 py-2 text-sm'

export function CsvCard({ id, revision, templateId, disabled, onApplied }: {
  id: string; revision: number; templateId: string; disabled: boolean; onApplied: () => Promise<void>
}) {
  const t = useT()
  const [file, setFile] = useState<File | null>(null)
  const [headerRow, setHeaderRow] = useState('1')
  const [preview, setPreview] = useState<(Preview & { receipt: string }) | null>(null)
  const [mapping, setMapping] = useState<Record<string, number | null>>({})
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Pick<PreviewResult, 'error' | 'position'>>({})
  const pending = useRef<{ key: string; token: string } | null>(null)
  const { runMutation } = useGuardedMutation({ contextId: 'factory-quotes-csv' })
  const mappingValues = Object.values(mapping).filter((v) => v !== null)
  const conflict = mappingValues.length !== new Set(mappingValues).size
  const numeric = (value: string) => /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))
  const reset = () => { setPreview(null); setProblem({}); setConfirmed(false); pending.current = null }
  const submit = async (apply?: Apply) => {
    if (busy || disabled || !file || !numeric(headerRow)) return
    if (!file.name.toLowerCase().endsWith('.csv') || file.size > 10 * 1024 * 1024) { setProblem({ error: 'csv_type_or_size' }); return }
    const key = JSON.stringify([id, revision, headerRow, apply])
    const token = pending.current?.key === key ? pending.current.token : crypto.randomUUID()
    pending.current = { key, token }
    setBusy(true); setProblem({})
    try {
      const result = await runMutation({ context: { resourceId: id, action: apply ? 'csv_import' : 'csv_preview' }, operation: async () => {
        const res = await apiCall<PreviewResult>('/api/factory-quotes', { method: 'POST', body: file,
          headers: { 'Content-Type': 'text/csv', 'x-factory-csv': JSON.stringify({ id, revision, token, templateId, headerRow: Number(headerRow), apply }) } })
        if (!res.ok || !res.result) {
          if (res.status < 500) pending.current = null
          throw new CsvRequestError(res.result?.error ?? 'operation_failed', res.result?.position)
        }
        return res.result
      } })
      if (apply) { await onApplied(); reset() }
      else if (result.preview && result.receipt) {
        setPreview({ ...result.preview, receipt: result.receipt }); setMapping(result.preview.suggestions)
        setFrom(String(result.preview.from)); setTo(String(result.preview.to)); setConfirmed(false)
      } else throw new CsvRequestError('operation_failed')
      pending.current = null
    } catch (error) {
      setProblem(error instanceof CsvRequestError ? { error: error.message, position: error.position } : { error: 'operation_failed' })
    } finally { setBusy(false) }
  }
  return <section className="space-y-3 rounded-lg border bg-card p-4 text-card-foreground">
    <h2 className="font-semibold">{t('factory_quotes.csv.title', '导入 CSV 到本单')}</h2>
    <p className="text-sm text-muted-foreground">{t('factory_quotes.csv.hint', '只导入当前询价的报价项，不更新全局主数据。导入会重开本单确认；已有报价项不会被覆盖。')}</p>
    {problem.error && <p role="alert" className="text-sm">{t(`factory_quotes.error.${problem.error}`, problem.error)}{problem.position && ` · 第 ${problem.position.row} 行${problem.position.column ? `第 ${problem.position.column} 列` : ''}`}</p>}
    <fieldset disabled={disabled || busy} className="space-y-3">
      <label className="grid gap-1 text-sm">{t('factory_quotes.csv.file', 'UTF-8 逗号分隔 CSV，最多 10 MiB')}<Input type="file" accept=".csv,text/csv" onChange={(e) => { setFile(e.currentTarget.files?.[0] ?? null); reset() }} /></label>
      <label className="grid gap-1 text-sm">{t('factory_quotes.csv.headerRow', '表头所在行')}<Input type="number" min={1} value={headerRow} onChange={(e) => { setHeaderRow(e.currentTarget.value); reset() }} /></label>
      <Button variant="outline" disabled={!file || !numeric(headerRow)} onClick={() => void submit()}>{t('factory_quotes.csv.preview', '解析并预览')}</Button>
      {preview && <>
        <div className="space-y-2 text-sm">
          <p>{t('factory_quotes.csv.previewOnly', '预览不会修改报价。以下最多显示 5 行。')} ({preview.totalRows})</p>
          <ul className="space-y-1">{preview.rows.map((r) => <li key={r.row} className="break-words rounded-md border p-2">{r.row}: {r.cells.map((v, i) => `${i + 1}=${v}`).join(' · ')}</li>)}</ul>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">{preview.targets.map((target) => <label className="grid gap-1 text-sm" key={target.key}>
          {target.label}{target.required ? ' *' : ''}
          <select className={selectClass} value={mapping[target.key] ?? ''} onChange={(e) => {
            const value = e.currentTarget.value
            setMapping((old) => ({ ...old, [target.key]: value ? Number(value) : null })); setConfirmed(false)
          }}><option value="">{t('factory_quotes.csv.ignore', '不导入')}</option>{preview.headers.map((h, i) => <option value={i + 1} key={i}>{i + 1} · {h}</option>)}</select>
        </label>)}</div>
        {conflict && <p role="alert">{t('factory_quotes.error.csv_mapping_conflict', '同一列不能绑定到多个字段。')}</p>}
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="grid gap-1 text-sm">{t('factory_quotes.csv.from', '起始数据行')}<Input type="number" min={1} value={from} onChange={(e) => { setFrom(e.currentTarget.value); setConfirmed(false) }} /></label>
          <label className="grid gap-1 text-sm">{t('factory_quotes.csv.to', '最后数据行')}<Input type="number" min={1} value={to} onChange={(e) => { setTo(e.currentTarget.value); setConfirmed(false) }} /></label>
        </div>
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.currentTarget.checked)} />{t('factory_quotes.csv.confirm', '我已核对用途、表头、列映射和数据范围。')}</label>
        <Button disabled={!confirmed || conflict || !mapping.name || !mapping.quantity || !numeric(from) || !numeric(to) || Number(to) < Number(from)} onClick={() => void submit({
          receipt: preview.receipt, from: Number(from), to: Number(to), mapping: Object.fromEntries(Object.entries(mapping).flatMap(([k, v]) => v === null ? [] : [[k, v]]))
        })}>{t('factory_quotes.csv.apply', '确认导入并刷新本单')}</Button>
      </>}
    </fieldset>
  </section>
}
class CsvRequestError extends Error {
  constructor(message: string, public position?: PreviewResult['position']) { super(message) }
}
