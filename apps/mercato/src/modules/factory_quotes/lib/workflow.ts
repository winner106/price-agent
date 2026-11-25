import type { Access } from '../acl'
import type { Draft, Mutation, Template } from '../data/validators'
import { evaluate, publicQuote, validateTemplate, type Confirmation, type ConfirmationKind, type Rates } from './engine'
import { display, exact, S } from './money'

export type TemplateState = { type: 'template'; spec: Template; stage: 'draft' | 'published'; tested: boolean; test?: { missing: string[]; total: string } }
type Frozen = { template: Template; draft: Draft; rates: Rates; confirmations: QuoteState['confirmations']; calc: ReturnType<typeof evaluate> }
type Action = Mutation['action']
export type QuoteState = {
  type: 'quote'; templateId: string; template: Template; stage: 'draft' | 'submitted' | 'approved' | 'published';
  draft: Draft; rates: Rates; confirmations: Partial<Record<ConfirmationKind, Confirmation>>;
  submission?: { by: string; at: string; frozen: Frozen; approvedBy?: string };
  release?: { by: string; at: string; frozen: Frozen; document: ReturnType<typeof publicQuote> };
  outcome?: { status: 'won' | 'lost' | 'revision_requested'; source: string };
  actual?: Extract<Action, {type: 'actual'}>['actual'];
}
export class QuoteFault extends Error { constructor(public status: number, public code: string) { super(code) } }
export function deny(ok: unknown, code: string, status = 422): asserts ok { if (!ok) throw new QuoteFault(status, code) }
// Capture human tasks separately from permissions to edit document data.
export function actionAccess(action: Action): Access {
  switch (action.type) {
    case 'new_template': case 'edit_template': case 'test_template': return 'configure'
    case 'publish_template': return 'publish_template'
    case 'evidence': return 'cost'
    case 'confirm': return action.confirmation.kind
    case 'approve': case 'return': return 'approve'
    case 'release': return 'release'
    case 'actual': return 'review'
    case 'export': return 'view'
    default: return 'edit'
  }
}
function checkDraft(t: Template, draft: Draft, previous: Draft | undefined, canCost: boolean): Draft {
  const fields = new Map(t.fields.map((field) => [field.key, field]))
  // Replace in place only; a non-cost user cannot use a positional edit to
  // transfer a previously confirmed private input to a different line.
  if (!canCost && previous && previous.items.some((line) => Object.keys(line.fields).some((key) => !fields.get(key)?.public))) {
    deny(draft.items.length === previous.items.length && draft.items.every((line, i) => line.name === previous.items[i].name), 'protected_lines', 403)
  }
  const result = structuredClone(draft)
  for (const [i, item] of result.items.entries()) {
    for (const key of Object.keys(item.fields)) {
      const f = fields.get(key)
      deny(f, 'unknown_field')
      deny(f.public || canCost, 'protected_field', 403)
    }
    if (!canCost && previous?.items[i]) for (const [key, v] of Object.entries(previous.items[i].fields)) {
      if (!fields.get(key)?.public) item.fields[key] = v
    }
  }
  return result
}
export function startQuote(t: TemplateState, templateId: string, draft: Draft, canCost: boolean): QuoteState {
  deny(t.stage === 'published', 'template_not_published')
  return { type: 'quote', stage: 'draft', templateId, template: t.spec, draft: checkDraft(t.spec, draft, undefined, canCost), rates: [], confirmations: {} }
}
export function templateTest(t: Template) {
  const issues = validateTemplate(t)
  deny(!issues.length, issues.join(', '))
  const day = '2030-01-01'
  const fields = Object.fromEntries(t.fields.map((f) => [f.key, f.type === 'measure' ? `1 ${f.unit}` : f.type === 'date' ? day :
    f.type === 'boolean' ? 'true' : ['select', 'multi'].includes(f.type) ? f.options[0] : ['integer', 'decimal'].includes(f.type) ? '1' : 'DEMO']))
  const rates = Object.fromEntries(t.rules.map((r) => [r.key, { rate: '10', source: 'TEST', validFrom: day, validUntil: day }]))
  const confirmation = { actor: 'test', at: day, evidence: 'TEST' }
  const trial = evaluate(t, { customer: 'TEST', items: [{ name: 'TEST', fields, quantity: '2', price: '100' }],
    taxRate: '0.13', delivery: day, validUntil: day, freight: 'TEST', destination: 'TEST', payment: 'TEST', exceptional: false },
  [rates], { technical: confirmation, cost: confirmation, delivery: confirmation }, day)
  return { missing: [...trial.missing, ...trial.costing], total: trial.total }
}

export function apply(state: TemplateState | QuoteState, action: Action, actor: string, now: string, canCost: boolean) {
  const day = now.slice(0, 10)
  if (state.type === 'template') {
    deny(state.stage === 'draft', 'immutable_template', 409)
    if (action.type === 'edit_template') return { ...state, spec: action.spec, test: undefined, tested: false }
    if (action.type === 'test_template') { const test = templateTest(state.spec); return { ...state, test, tested: test.missing.length === 0 } }
    if (action.type === 'publish_template') { deny(state.tested, 'test_required'); return { ...state, stage: 'published' as const } }
    throw new QuoteFault(422, 'invalid_template_action')
  }
  switch (action.type) {
    case 'message': return state
    case 'csv_preview':
      deny(state.stage === 'draft' && action.templateId === state.templateId, 'draft_required', 409)
      return state
    case 'csv_import': {
      deny(state.stage === 'draft' && action.templateId === state.templateId, 'draft_required', 409)
      const added = checkDraft(state.template, { ...state.draft, items: action.items }, undefined, canCost).items
      // Replace only the module's untouched seed row, not user-entered lines.
      const [first] = state.draft.items
      const blank = state.draft.items.length === 1 && first.name === '01' && first.quantity === '1' && first.price === '0'
        && Object.keys(first.fields).length === 0 && !state.rates.length && !Object.values(state.confirmations).some(Boolean)
      const items = [...(blank ? [] : state.draft.items), ...added]
      deny(items.length <= 50, 'csv_quote_limit')
      return { ...state, draft: { ...state.draft, items }, rates: [], confirmations: {}, submission: undefined }
    }
    case 'edit_quote': {
      deny(state.stage !== 'published', 'immutable_quote', 409)
      const draft = checkDraft(state.template, action.draft, state.draft, canCost)
      // A new drawing, changed line ordering or any other business edit invalidates
      // rate applicability and all prior confirmations until re-entered.
      return { ...state, draft, rates: [], confirmations: {}, stage: 'draft' as const, submission: undefined }
    }
    case 'evidence': {
      deny(state.stage === 'draft', 'draft_required', 409)
      const keys = new Set(state.template.rules.map((r) => r.key))
      deny(action.rates.length === state.draft.items.length && action.rates.every((row) => Object.keys(row).every((k) => keys.has(k))), 'invalid_rates')
      return { ...state, rates: action.rates, confirmations: { ...state.confirmations, cost: undefined } }
    }
    case 'confirm': {
      deny(state.stage === 'draft', 'draft_required', 409)
      const { kind, evidence, sourcePerson } = action.confirmation
      deny(!sourcePerson || kind === 'delivery', 'online_confirmation_required')
      const calc = evaluate(state.template, state.draft, state.rates, state.confirmations, day)
      if (kind === 'cost') deny(calc.costing.length === 0 && !calc.missing.some((x) => /^\d+:/.test(x)), 'cost_basis_incomplete')
      if (kind === 'technical') deny(!calc.missing.some((x) => /^\d+:/.test(x)), 'technical_basis_incomplete')
      if (kind === 'delivery') deny(state.draft.delivery && state.draft.delivery >= day && state.draft.destination, 'delivery_basis_incomplete')
      return { ...state, confirmations: { ...state.confirmations, [kind]: { actor, at: now, evidence, ...(sourcePerson ? { sourcePerson } : {}) } } }
    }
    case 'submit': case 'approve': case 'release': {
      const calc = evaluate(state.template, state.draft, state.rates, state.confirmations, day)
      deny(calc.status !== 'BLOCKED', 'publication_blocked')
      const frozen: Frozen = { template: state.template, draft: state.draft, rates: state.rates, confirmations: state.confirmations, calc }
      if (action.type === 'submit') {
        deny(state.stage === 'draft' && calc.status === 'APPROVAL_REQUIRED', 'submission_not_allowed', 409)
        return { ...state, stage: 'submitted' as const, submission: { by: actor, at: now, frozen } }
      }
      if (action.type === 'approve') {
        deny(state.stage === 'submitted' && state.submission, 'not_submitted', 409)
        deny(state.submission.by !== actor, 'self_approval', 403)
        return { ...state, stage: 'approved' as const, submission: { ...state.submission, approvedBy: actor } }
      }
      deny((state.stage === 'draft' && calc.status === 'DIRECT_RELEASE') ||
        (state.stage === 'approved' && state.submission?.approvedBy && calc.status === 'APPROVAL_REQUIRED'), 'independent_approval_required', 409)
      return { ...state, stage: 'published' as const, release: { by: actor, at: now, frozen, document: publicQuote(state.template, state.draft, calc) } }
    }
    case 'return':
      deny(state.stage === 'submitted' || state.stage === 'approved', 'not_submitted', 409)
      return { ...state, stage: 'draft' as const, submission: undefined }
    case 'sent': case 'export':
      deny(state.stage === 'published' && state.release, 'not_published', 409)
      return state
    case 'outcome':
      deny(state.stage === 'published', 'not_published', 409)
      deny(!state.actual || action.result === 'won', 'actuals_already_recorded', 409)
      return { ...state, outcome: { status: action.result, source: action.source } }
    case 'actual':
      deny(state.stage === 'published' && state.outcome?.status === 'won', 'won_required', 409)
      return { ...state, actual: action.actual }
    default: throw new QuoteFault(422, 'invalid_quote_action')
  }
}

export function project(state: QuoteState, day: string, costs: boolean) {
  const calc = state.release?.frozen.calc ?? evaluate(state.template, state.draft, state.rates, state.confirmations, day)
  const { draft, template } = state
  const safeFields = template.fields.filter((f) => f.public || costs)
  const actual = costs && state.actual && state.release ? state.actual : null
  const quotedQuantity = draft.items.reduce((acc, item) => acc + BigInt(item.quantity), 0n)
  const quoted = BigInt(calc.total.replace('.', '')) * (S / 100n)
  return { stage: state.stage, templateId: state.templateId, outcome: state.outcome?.status,
    draft: { ...draft, items: draft.items.map((item) => ({ ...item, fields: Object.fromEntries(Object.entries(item.fields).filter(([k]) => safeFields.some((f) => f.key === k))) })) },
    fields: safeFields, rules: costs ? template.rules : [],
    confirmations: Object.keys(state.confirmations).filter((k) => !!state.confirmations[k as ConfirmationKind]),
    rates: costs ? state.rates : [], actual,
    variance: actual ? { quotedQuantity: quotedQuantity.toString(), quotedUnitCost: display(quoted, quotedQuantity * S),
      actualUnitCost: display(exact(actual.totalCost), BigInt(actual.quantity) * S),
      unitDifference: display(exact(actual.totalCost) * quotedQuantity - quoted * BigInt(actual.quantity), quotedQuantity * BigInt(actual.quantity) * S) } : null,
    calc: costs ? calc : { status: calc.status, sale: calc.sale, missing: calc.missing.filter((key) => !key.includes(':') ||
      key.startsWith('confirmation:') || safeFields.some((f) => key.endsWith(`:${f.key}`))),
      hasRestrictedBlockers: calc.costing.length > 0 || calc.missing.some((key) => /^\d+:/.test(key) && !safeFields.some((f) => key.endsWith(`:${f.key}`))) },
  }
}
