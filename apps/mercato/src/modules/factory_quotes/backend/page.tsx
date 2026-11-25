'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode, type FormEvent } from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import type { Access } from '../acl'
import type { Draft, Mutation, Template } from '../data/validators'
import type { project, TemplateState } from '../lib/workflow'
import type { publicQuote, Rates } from '../lib/engine'
import { CsvCard } from './csv-card.client'
import { machining, sku } from '../lib/seeds'

const path = '/api/factory-quotes'
const selectClass = 'rounded-md border bg-background px-2 py-2 text-sm'
type Entry = { id: string; title: string; stage: string }
type Listing = { capabilities: Access[]; quotes: Entry[]; templates: Entry[] }
type Detail = { id: string; revision: number; state: TemplateState | (ReturnType<typeof project> & { type: 'quote' }); messages: { id: string; at: string; text: string }[] }
type Action = Mutation['action']
const line = (): Draft['items'][number] => ({ name: '', quantity: '1', price: '0', fields: {} })
const initial = (customer: string): Draft => ({ customer, items: [{ ...line(), name: '01' }], destination: '', payment: '', freight: '', taxRate: '0.13', exceptional: false })
const blankRate = { rate: '', source: '', validFrom: '', validUntil: '' }
const msg = (fd: FormData, key: string) => String(fd.get(key) ?? '').trim()
function Panel({ title, children }: { title: string; children: ReactNode }) {
  return <section className="space-y-3 rounded-lg border bg-card p-4 text-card-foreground"><h2 className="font-semibold">{title}</h2>{children}</section>
}
function Field({ label, value, onChange, type = 'text' }: { label: string; value: string; type?: string; onChange: (value: string) => void }) {
  return <label className="grid gap-1 text-sm">{label}<Input type={type} value={value} onChange={(e) => onChange(e.currentTarget.value)} /></label>
}
export default function FactoryQuotePage() {
  const t = useT()
  const [listing, setListing] = useState<Listing | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [issue, setIssue] = useState('')
  const [busy, setBusy] = useState(false)
  const pending = useRef<{ key: string; payload: Mutation } | null>(null)
  const [printed, setPrinted] = useState<ReturnType<typeof publicQuote> | null>(null)
  const [mobile, setMobile] = useState<'chat' | 'data'>('chat')
  const { runMutation } = useGuardedMutation({ contextId: 'factory-quotes-workspace' })
  const load = useCallback(async (id?: string) => {
    const list = await apiCall<Listing>(path)
    if (!list.ok || !list.result) throw new Error('workspace_unavailable')
    setListing(list.result)
    if (id) {
      const next = await apiCall<Detail>(`${path}?id=${encodeURIComponent(id)}`)
      if (!next.ok || !next.result) throw new Error('not_found')
      setDetail(next.result)
    }
  }, [])
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('id') ?? undefined
    void load(id).catch(() => setIssue('workspace_unavailable'))
  }, [load])
  const open = async (id: string) => {
    setBusy(true); setIssue(''); setPrinted(null)
    try {
      await load(id)
      window.history.replaceState(null, '', `?id=${encodeURIComponent(id)}`)
    } catch { setIssue('not_found') } finally { setBusy(false) }
  }
  const act = async (action: Action, create = false) => {
    if (busy || (!create && !detail)) return false
    const revision = create ? -1 : detail!.revision
    const key = JSON.stringify([create ? null : detail!.id, revision, action])
    const previous = pending.current
    const payload = previous?.key === key ? previous.payload : { id: create ? crypto.randomUUID() : detail!.id, token: crypto.randomUUID(), revision, action }
    pending.current = { key, payload }
    const { id } = payload
    setBusy(true); setIssue('')
    try {
      const result = await runMutation({ context: { resourceId: id, action: action.type }, operation: async () => {
        const res = await apiCall<{ id: string; document?: ReturnType<typeof publicQuote>; error?: string }>(path, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        })
        if (!res.ok || !res.result) {
          if (res.status < 500) pending.current = null
          throw new Error(res.result?.error ?? 'operation_failed')
        }
        return res.result
      } })
      await load(id)
      window.history.replaceState(null, '', `?id=${encodeURIComponent(id)}`)
      if (result.document) setPrinted(result.document)
      pending.current = null
      return true
    } catch (error) { setIssue(error instanceof Error ? error.message : 'operation_failed'); return false }
    finally { setBusy(false) }
  }
  const has = (f: Access) => listing?.capabilities.includes(f) ?? false
  const state = detail?.state
  return <main className="space-y-4 p-4 lg:p-6">
    <header className="print:hidden"><h1 className="text-2xl font-semibold">{t('factory_quotes.title', '工厂报价')}</h1><p className="text-sm text-muted-foreground">{t('factory_quotes.intro', '内部工作台 · 手工模式 · 以结构化报价单为准')}</p></header>
    {issue && <p role="alert" className="print:hidden rounded-md border p-3">{t(`factory_quotes.error.${issue}`, issue)} <Button size="sm" variant="outline" disabled={!detail || busy} onClick={() => detail && void open(detail.id)}>{t('factory_quotes.refresh', '重新读取')}</Button></p>}
    <div className="print:hidden space-y-4">
      <Panel title={t('factory_quotes.select', '报价与模板')}>
        <div className="flex flex-wrap gap-2">
          <select className={selectClass} aria-label="报价或模板" disabled={busy || !listing} value={detail?.id ?? ''} onChange={(e) => void open(e.currentTarget.value)}>
            <option value="" disabled>选择记录</option>
            <optgroup label="询价">{listing?.quotes.map((x) => <option key={x.id} value={x.id}>{x.title} · {x.stage}</option>)}</optgroup>
            <optgroup label="模板">{listing?.templates.map((x) => <option key={x.id} value={x.id}>{x.title} · {x.stage}</option>)}</optgroup>
          </select>
          {has('configure') && <><Button disabled={busy} variant="outline" onClick={() => void act({ type: 'new_template', spec: machining }, true)}>创建机加工模板草稿</Button>
            <Button disabled={busy} variant="outline" onClick={() => void act({ type: 'new_template', spec: sku }, true)}>创建 SKU 模板草稿</Button></>}
        </div>
        {has('edit') && <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); void act({ type: 'new_quote', templateId: msg(f, 'template'), draft: initial(msg(f, 'customer')) }, true) }}>
          <select name="template" required className={selectClass} aria-label="已发布模板"><option value="">选择已发布模板</option>{listing?.templates.filter((x) => x.stage === 'published').map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}</select>
          <Input name="customer" placeholder="客户名称" aria-label="客户名称" required className="max-w-64" /><Button disabled={busy}>新建询价</Button>
        </form>}
      </Panel>
      {state?.type === 'template' && 'rules' in state.spec && detail && <TemplateEditor key={`${detail.id}:${detail.revision}`} state={state} act={act} busy={busy} edit={has('configure')} publish={has('publish_template')} />}
      {state?.type === 'quote' && detail && <>
        <nav aria-label="报价工作视图" className="flex gap-2 lg:hidden"><Button variant="outline" aria-pressed={mobile === 'chat'} onClick={() => setMobile('chat')}>对话</Button><Button variant="outline" aria-pressed={mobile === 'data'} onClick={() => setMobile('data')}>报价资料</Button></nav>
        <div className="grid gap-4 lg:grid-cols-2">
          <div className={`${mobile === 'chat' ? '' : 'hidden'} lg:block space-y-4`}>
            <Panel title="询价笔记（仅本人可读；未连接模型）">
              <ul className="space-y-2">{detail.messages.map((m) => <li key={m.id} className="whitespace-pre-wrap rounded-md border p-2 text-sm">{m.text}</li>)}</ul>
              {has('edit') && <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); const form = e.currentTarget; const text = msg(new FormData(form), 'text'); if (text) void act({ type: 'message', text }).then((saved) => { if (saved) form.reset() }) }}>
                <Input name="text" aria-label="询价笔记" placeholder="粘贴询价要点；不自动写入规格" maxLength={4000} required /><Button disabled={busy}>保存</Button>
              </form>}
            </Panel>
            <Panel title="发布资格">
              <p>{state.stage === 'published' ? '已正式发布' : `非正式报价 · ${state.calc.status}`}</p>
              {!!state.calc.missing.length && <ul className="list-inside list-disc text-sm">{state.calc.missing.map((x) => <li key={x}>{x}</li>)}</ul>}
              {'hasRestrictedBlockers' in state.calc && state.calc.hasRestrictedBlockers && <p>存在需要授权岗位处理的缺项。</p>}
              {'total' in state.calc && <><p>未税销售 ¥{state.calc.sale} · 总成本试算 ¥{state.calc.total} · 收益 ¥{state.calc.income} · 收益率 {state.calc.returnPercent ?? '—'}%</p>
                <p>{[...state.calc.costing, ...state.calc.reasons].join(' · ')}</p>{state.calc.rows.map((row, i) => <details key={i}><summary>第 {i + 1} 项 · 单件 ¥{row.unitCost} · 批次 ¥{row.batchCost}</summary><ul>{row.details.map((d) => <li key={d.rule}>{d.label} ¥{d.amount} · {d.evidence.source}（至 {d.evidence.validUntil}）</li>)}</ul></details>)}</>}
              <div className="flex flex-wrap gap-2">
                {state.stage === 'draft' && state.calc.status === 'APPROVAL_REQUIRED' && has('edit') && <Button disabled={busy} onClick={() => void act({ type: 'submit' })}>送独立审批</Button>}
                {state.stage === 'submitted' && has('approve') && <Button disabled={busy} onClick={() => void act({ type: 'approve' })}>审批通过</Button>}
                {(state.stage === 'submitted' || state.stage === 'approved') && has('approve') && <TextAction label="退回理由" button="退回草稿" busy={busy} run={(reason) => act({ type: 'return', reason })} />}
                {has('release') && (state.stage === 'approved' || (state.stage === 'draft' && state.calc.status === 'DIRECT_RELEASE')) && <Button disabled={busy} onClick={() => void act({ type: 'release' })}>正式发布</Button>}
                {state.stage === 'published' && <Button disabled={busy} onClick={() => void act({ type: 'export' })}>生成打印版</Button>}
              </div>
            </Panel>
            {state.stage === 'draft' && <Panel title="岗位确认">{(['technical', 'cost', 'delivery'] as const).map((kind, index) => {
              const label = ['工艺可行', '成本依据', '交付承诺'][index]
              return <div key={kind}><p>{label}：{state.confirmations.includes(kind) ? '已确认' : '待确认'}</p>
              {has(kind) && <TextAction label={kind === 'delivery' ? '采购周期、设备负荷和排产依据' : '确认依据'} button={`确认${label}`} busy={busy} external={kind === 'delivery'} run={(evidence, sourcePerson) => act({ type: 'confirm', confirmation: { kind, evidence, sourcePerson } })} />}</div>
            })}</Panel>}
          </div>
          <div className={`${mobile === 'data' ? '' : 'hidden'} lg:block space-y-4`}>
            <QuoteEditor key={`${detail.id}:${detail.revision}`} state={state} act={act} edit={has('edit')} cost={has('cost')} busy={busy} identity={{ id: detail.id, revision: detail.revision }} onApplied={() => load(detail.id)} />
            {state.stage === 'published' && <Panel title="成交与复盘">
              <p>{state.outcome ?? '待登记'}</p>
              {has('edit') && <><TextAction label="发送来源或备注" button="登记人工发送" busy={busy} run={(source) => act({ type: 'sent', source })} />
                <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.currentTarget); void act({ type: 'outcome', result: msg(fd, 'status') as 'won' | 'lost' | 'revision_requested', source: msg(fd, 'source') }) }}>
                  <select className={selectClass} name="status" aria-label="客户反馈"><option value="won">接受</option><option value="lost">拒绝</option><option value="revision_requested">要求改价</option></select>
                  <Input name="source" placeholder="反馈来源" aria-label="反馈来源" required /><Button disabled={busy}>登记结果</Button>
                </form></>}
              {state.outcome === 'won' && has('cost') && <p>{state.variance ? `报价 ${state.variance.quotedQuantity} 件，实际 ${state.actual?.quantity} 件；单件成本差 ¥${state.variance.unitDifference}` : '实绩待采集'}</p>}
              {state.outcome === 'won' && has('cost') && has('review') && <ActualForm busy={busy} act={act} />}
            </Panel>}
          </div>
        </div>
      </>}
    </div>
    {printed && <Panel title="正式报价 · CNY"><article className="space-y-2" style={{ borderTop: `4px solid ${printed.brand}` }}>
      <p>客户：{printed.customer}</p>
      {printed.items.map((row, i) => <section key={i} className="border-b py-2"><h3>{row.name} · {row.quantity} 件 · 未税单价 ¥{row.unitPrice} · ¥{row.subtotal}</h3><p>{row.specs.map(({ label, value }) => `${label}：${value}`).join('；')}</p></section>)}
      <p>未税 ¥{printed.subtotal} · 税额 ¥{printed.tax} · 含税 ¥{printed.gross}</p><p>交付：{printed.delivery} / {printed.destination} · 运费：{printed.freight}</p><p>付款：{printed.payment} · 有效期：{printed.validUntil}</p>
      <Button className="print:hidden" onClick={() => window.print()}>打印 / 保存 PDF</Button>
    </article></Panel>}
  </main>
}

type Act = (action: Action, create?: boolean) => Promise<boolean>
function TextAction({ label, button, busy, run, external }: { label: string; button: string; busy: boolean; run: (value: string, source?: string) => Promise<boolean>; external?: boolean }) {
  const submit = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const f = new FormData(e.currentTarget); void run(msg(f, 'value'), msg(f, 'external') || undefined) }
  return <form className="my-2 flex flex-wrap gap-2" onSubmit={submit}><Input name="value" aria-label={label} placeholder={label} required maxLength={250} className="max-w-72" />{external && <Input name="external" aria-label="线下实际确认人" placeholder="线下实际确认人（可选）" className="max-w-56" />}<Button variant="outline" disabled={busy}>{button}</Button></form>
}
function ActualForm({ busy, act }: { busy: boolean; act: Act }) {
  return <form className="grid gap-2 sm:grid-cols-2" onSubmit={(e) => {
    e.preventDefault(); const f = new FormData(e.currentTarget); const v = (k: string) => msg(f, k)
    void act({ type: 'actual', actual: { quantity: v('quantity'), totalCost: v('totalCost'), materialUsage: v('materialUsage'), prepHours: v('prepHours'), workHours: v('workHours'), subcontract: v('subcontract'), source: v('source'), comment: v('comment') } })
  }}>
    {Object.entries({ quantity: '实绩数量', totalCost: '实绩总成本', materialUsage: '实绩材料消耗', prepHours: '准备工时', workHours: '加工工时', subcontract: '委外费用', source: '依据', comment: '偏差说明' }).map(([key, label]) => <label key={key}>{label}<Input name={key} required /></label>)}
    <Button disabled={busy}>登记实绩</Button>
  </form>
}

function QuoteEditor({ state, act, edit, cost, busy, identity, onApplied }: { state: ReturnType<typeof project>; act: Act; edit: boolean; cost: boolean; busy: boolean; identity: { id: string; revision: number }; onApplied: () => Promise<void> }) {
  const [draft, set] = useState(state.draft)
  const [rates, setRates] = useState<Rates>(() => state.draft.items.map((_, i) => state.rates[i] ?? {}))
  const [changed, setChanged] = useState(false)
  const update = (next: Draft) => { set(next); setChanged(true) }
  const item = (i: number, next: Draft['items'][number]) => update({ ...draft, items: draft.items.map((v, index) => i === index ? next : v) })
  return <>
    {edit && state.stage === 'draft' && <CsvCard {...identity} templateId={state.templateId} disabled={changed || busy} onApplied={onApplied} />}
    <Panel title="报价资料">
      <fieldset disabled={!edit || busy || state.stage === 'published'} className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-2">{([
          ['customer', '客户名称'], ['destination', '交付地点'], ['payment', '付款和账期'], ['freight', '运费范围'],
          ['taxRate', '税率（小数）'], ['requestedDelivery', '期望交期', 'date'], ['delivery', '已核实交期', 'date'], ['validUntil', '报价有效期', 'date'],
        ] as const).map(([key, label, type]) => <Field key={key} label={label} type={type} value={draft[key] ?? ''} onChange={(v) => update({ ...draft, [key]: v || (type === 'date' ? undefined : '') })} />)}</div>
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={draft.exceptional} onChange={(e) => update({ ...draft, exceptional: e.currentTarget.checked })} />非标工艺、特殊付款或加急</label>
        {draft.items.map((value, i) => <fieldset key={i} className="grid gap-2 rounded-md border p-3 sm:grid-cols-2"><legend>报价项 {i + 1}</legend>
          {([['name', '品名'], ['quantity', '数量'], ['price', '单件未税售价']] as const).map(([key, label]) => <Field key={key} label={label} value={value[key]} onChange={(v) => item(i, { ...value, [key]: v })} />)}
          {state.fields.map((f) => {
            const actual = value.fields[f.key] ?? ''
            const change = (v: string) => item(i, { ...value, fields: { ...value.fields, [f.key]: v } })
            if (f.type === 'boolean' || f.type === 'select') return <label key={f.key} className="grid gap-1 text-sm">{f.label}<select className={selectClass} value={actual} onChange={(e) => change(e.currentTarget.value)}><option value="">未填</option>{(f.type === 'boolean' ? ['true', 'false'] : f.options).map((v) => <option key={v} value={v}>{v}</option>)}</select></label>
            return <Field key={f.key} label={`${f.label}${f.unit ? `（例：1 ${f.unit}）` : ''}`} type={f.type === 'date' ? 'date' : 'text'} value={actual} onChange={change} />
          })}
          <Button variant="outline" disabled={draft.items.length < 2} onClick={() => update({ ...draft, items: draft.items.filter((_, index) => index !== i) })}>删除本项</Button>
        </fieldset>)}
        {edit && state.stage !== 'published' && <div className="flex gap-2"><Button variant="outline" disabled={draft.items.length >= 50} onClick={() => update({ ...draft, items: [...draft.items, line()] })}>添加报价项</Button><Button disabled={!changed || busy} onClick={() => void act({ type: 'edit_quote', draft })}>保存资料并重开确认</Button></div>}
      </fieldset>
    </Panel>
    {cost && state.stage === 'draft' && <Panel title="费率与依据（仅成本岗位）">
      {state.draft.items.map((v, i) => <fieldset key={i} disabled={changed || busy} className="space-y-2"><legend>{i + 1}. {v.name}</legend>
        {state.rules.map((r) => <fieldset key={r.key} className="grid gap-2 rounded-md border p-2 sm:grid-cols-2"><legend>{r.label}</legend>
          {([['rate', '费率 / 金额'], ['source', '出处及版本'], ['validFrom', '生效日期', 'date'], ['validUntil', '到期日期', 'date']] as const).map(([key, label, type]) => <Field key={key} label={label} type={type} value={rates[i]?.[r.key]?.[key] ?? ''} onChange={(value) => setRates((all) => all.map((row, index) => index === i ? { ...row, [r.key]: { ...blankRate, ...row[r.key], [key]: value } } : row))} />)}
        </fieldset>)}
      </fieldset>)}
      <Button disabled={changed || busy} onClick={() => void act({ type: 'evidence', rates: rates.map((row) => Object.fromEntries(Object.entries(row).filter(([, e]) => Object.values(e).some(Boolean)))) })}>保存依据并试算</Button>
    </Panel>}
  </>
}

function TemplateEditor({ state, act, busy, edit, publish }: { state: TemplateState; act: Act; busy: boolean; edit: boolean; publish: boolean }) {
  const [spec, set] = useState(state.spec)
  const changed = JSON.stringify(spec) !== JSON.stringify(state.spec)
  const field = (i: number, next: Template['fields'][number]) => set({ ...spec, fields: spec.fields.map((f, j) => j === i ? next : f) })
  const rule = (i: number, next: Template['rules'][number]) => set({ ...spec, rules: spec.rules.map((r, j) => j === i ? next : r) })
  return <Panel title={`模板配置 · ${state.stage}`}>
    <fieldset disabled={busy || !edit || state.stage !== 'draft'} className="space-y-3">
      <Field label="模板名称" value={spec.name} onChange={(name) => set({ ...spec, name })} />
      <Field label="品牌色（受限十六进制）" value={spec.brand} onChange={(brand) => set({ ...spec, brand })} />
      {/^#[a-f0-9]{6}$/i.test(spec.brand) && <p className="border bg-background p-2" style={{ borderTop: `4px solid ${spec.brand}` }}>品牌预览 · {spec.name}</p>}
      {spec.fields.map((f, i) => <fieldset className="grid gap-2 rounded-md border p-3 sm:grid-cols-3" key={i}><legend>字段 {i + 1}</legend>
        <Field label="稳定键" value={f.key} onChange={(key) => field(i, { ...f, key })} /><Field label="标签" value={f.label} onChange={(label) => field(i, { ...f, label })} />
        <label>类型<select className={selectClass} value={f.type} onChange={(e) => { const type = e.currentTarget.value as typeof f.type; field(i, { ...f, type, unit: type === 'measure' ? 'mm' : undefined }) }}>{['text','integer','decimal','date','boolean','select','multi','measure','reference'].map((v) => <option key={v}>{v}</option>)}</select></label>
        {f.type === 'measure' && <label>单位<select className={selectClass} value={f.unit} onChange={(e) => field(i, { ...f, unit: e.currentTarget.value as typeof f.unit })}>{['mm','cm','m','mm2','cm2','m2','g','kg','min','h'].map((v) => <option key={v}>{v}</option>)}</select></label>}
        <Field label="别名（逗号分隔）" value={f.aliases.join(',')} onChange={(v) => field(i, { ...f, aliases: v ? v.split(',') : [] })} />
        {(f.type === 'select' || f.type === 'multi') && <Field label="选项（逗号分隔）" value={f.options.join(',')} onChange={(v) => field(i, { ...f, options: v.split(',') })} />}
        {(['public','required'] as const).map((key) => <label key={key}><input type="checkbox" checked={f[key]} onChange={(e) => field(i, { ...f, [key]: e.currentTarget.checked })} />{key === 'public' ? '对外可见' : '始终必填'}</label>)}
        <Condition label="条件必填" value={f.requiredWhen} onChange={(requiredWhen) => field(i, { ...f, requiredWhen })} />
        <Button variant="outline" onClick={() => set({ ...spec, fields: spec.fields.filter((_, j) => j !== i) })}>删除字段</Button>
      </fieldset>)}
      <Button variant="outline" onClick={() => set({ ...spec, fields: [...spec.fields, { key: `field_${spec.fields.length + 1}`, label: '新字段', type: 'text', aliases: [], options: [], public: false, required: false }] })}>添加字段</Button>
      {spec.rules.map((r, i) => <fieldset className="grid gap-2 rounded-md border p-3 sm:grid-cols-3" key={i}><legend>计价组件 {i + 1}</legend>
        <Field label="成本键" value={r.key} onChange={(key) => rule(i, { ...r, key })} /><Field label="标签" value={r.label} onChange={(label) => rule(i, { ...r, label })} />
        <label>计费方式<select className={selectClass} value={r.basis} onChange={(e) => { const basis = e.currentTarget.value as typeof r.basis; rule(i, { ...r, basis, driver: basis.endsWith('hours') ? r.driver : undefined }) }}>{['batch','unit','prep_hours','piece_hours'].map((v) => <option key={v}>{v}</option>)}</select></label>
        {r.basis.endsWith('hours') && <Field label="工时字段键" value={r.driver ?? ''} onChange={(driver) => rule(i, { ...r, driver })} />}
        <label>成本层<select className={selectClass} value={r.layer} onChange={(e) => rule(i, { ...r, layer: e.currentTarget.value as typeof r.layer })}><option value="manufacturing">制造</option><option value="commercial">其他</option></select></label>
        <Condition label="启用条件" value={r.when} onChange={(when) => rule(i, { ...r, when })} />
        <Button variant="outline" onClick={() => set({ ...spec, rules: spec.rules.filter((_, j) => j !== i) })}>删除组件</Button>
      </fieldset>)}
      <Button variant="outline" onClick={() => set({ ...spec, rules: [...spec.rules, { key: `cost_${spec.rules.length + 1}`, label: '新组件', basis: 'batch', layer: 'manufacturing' }] })}>添加计价组件</Button>
      <div className="grid gap-2 sm:grid-cols-3">
        <label><input type="checkbox" checked={spec.approval.direct} onChange={(e) => set({ ...spec, approval: { ...spec.approval, direct: e.currentTarget.checked } })} />明确允许直接发布</label>
        <Field label="最低报价收益率（小数）" value={spec.approval.minReturn} onChange={(minReturn) => set({ ...spec, approval: { ...spec.approval, minReturn } })} />
        <Field label="独审金额阈值（未税）" value={spec.approval.maxAmount} onChange={(maxAmount) => set({ ...spec, approval: { ...spec.approval, maxAmount } })} />
      </div>
    </fieldset>
    {state.test && <p>虚构试算总成本 ¥{state.test.total} {state.test.missing.join(' · ')}</p>}
    <div className="flex flex-wrap gap-2">
      {state.stage === 'draft' && edit && <><Button disabled={!changed || busy} onClick={() => void act({ type: 'edit_template', spec })}>保存草稿</Button><Button variant="outline" disabled={changed || busy} onClick={() => void act({ type: 'test_template' })}>运行虚构样本</Button></>}
      {state.stage === 'draft' && publish && <Button disabled={changed || !state.tested || busy} onClick={() => void act({ type: 'publish_template' })}>确认发布模板</Button>}
      {state.stage === 'published' && edit && <Button disabled={busy} onClick={() => void act({ type: 'new_template', spec }, true)}>复制为新草稿</Button>}
    </div>
  </Panel>
}
function Condition({ label, value, onChange }: { label: string; value?: { field: string; equals: string }; onChange: (value?: { field: string; equals: string }) => void }) {
  return <div className="space-y-1">
    <label><input type="checkbox" checked={!!value} onChange={(e) => onChange(e.currentTarget.checked ? { field: '', equals: '' } : undefined)} />{label}</label>
    {value && <><Field label="依赖字段键" value={value.field} onChange={(field) => onChange({ ...value, field })} /><Field label="等于" value={value.equals} onChange={(equals) => onChange({ ...value, equals })} /></>}
  </div>
}
