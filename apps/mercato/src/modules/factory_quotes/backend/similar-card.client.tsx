'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Button } from '@open-mercato/ui/primitives/button'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import type { SimilarQuote } from '../lib/similarity'

export function SimilarCard({ id, items }: { id: string; items: { name: string }[] }) {
  const t = useT()
  const [item, setItem] = useState(1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [result, setResult] = useState<{ items: SimilarQuote[]; scanned: number; truncated: boolean } | null>(null)
  async function load() {
    setBusy(true); setError(false); setResult(null)
    try {
      const response = await apiCall<NonNullable<typeof result>>(`/api/factory-quotes?id=${encodeURIComponent(id)}&similar=${item}`, { cache: 'no-store' })
      if (!response.ok || !response.result) setError(true)
      else setResult(response.result)
    } catch { setError(true) } finally { setBusy(false) }
  }
  return <section className="space-y-3 rounded-lg border bg-card p-4 text-card-foreground">
    <h2 className="font-semibold">{t('factory_quotes.similar.title', '相似历史报价')}</h2>
    <p className="text-sm text-muted-foreground">{t('factory_quotes.similar.reference', '只比较已保存的规格。历史售价仅供参考，不写回本单；正式核价仍需要本次有效依据。')}</p>
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-2 text-sm">{t('factory_quotes.similar.item', '报价项')}
        <select disabled={busy} className="rounded-md border bg-background px-2 py-2" value={item} onChange={(e) => { setItem(Number(e.currentTarget.value)); setResult(null); setError(false) }}>
          {items.map(({ name }, index) => <option value={index + 1} key={index}>{index + 1}. {name}</option>)}
        </select>
      </label>
      <Button variant="outline" disabled={busy} onClick={() => void load()}>{busy ? t('factory_quotes.similar.loading', '检索中…') : t('factory_quotes.similar.search', '查找相似单')}</Button>
    </div>
    {error && <p role="alert">{t('factory_quotes.similar.failed', '未能读取相似单，请重试。')}</p>}
    {result && <div aria-live="polite" className="space-y-2">
      {result.truncated && <p className="text-sm text-muted-foreground">{t('factory_quotes.similar.truncated', '仅比较本组织最近更新的 150 份已发布报价。')}</p>}
      {!result.items.length && <p>{t('factory_quotes.similar.empty', '本次检索范围内没有足够匹配的历史报价。')}</p>}
      {result.items.map((row) => <article key={`${row.id}:${row.line}`} className="space-y-1 rounded-md border p-3 text-sm">
        <Link className="font-semibold underline" href={`/backend/factory_quotes?id=${encodeURIComponent(row.id)}`} target="_blank" rel="noopener noreferrer">{row.item} · #{row.line}</Link>
        <p>{t('factory_quotes.similar.source', '来源：已发布报价')} · <time dateTime={row.publishedAt}>{row.publishedAt.slice(0, 10)}</time></p>
        <p className="break-all text-muted-foreground">{t('factory_quotes.similar.version', '模板版本')}：{row.templateId}</p>
        <p>{t('factory_quotes.similar.price', '参考未税单价')} ¥{row.historicUnitPrice}{row.validUntil ? ` · ${t('factory_quotes.similar.validity', '原有效期至')} ${row.validUntil}` : ''}</p>
        <p>{t('factory_quotes.similar.matches', '匹配依据')}：{row.matches.map((value) => `${value.label} (${value.current} / ${value.historical})`).join('；')}</p>
        {!!row.differences.length && <div>{t('factory_quotes.similar.differences', '差异（本次 / 历史）')}：<ul className="list-inside list-disc">{row.differences.map((value) => <li key={value.key}>{value.label}：{value.current ?? '—'} / {value.historical ?? '—'} {value.relation === 'unknown' ? t('factory_quotes.similar.unknown', '（待核实）') : ''}</li>)}</ul></div>}
      </article>)}
    </div>}
  </section>
}
