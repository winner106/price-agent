import { createHash, randomUUID } from 'node:crypto'
import { LockMode, UniqueConstraintViolationException } from '@mikro-orm/core'
import type { EntityManager } from '@mikro-orm/postgresql'
import { registerCommand, type CommandHandler } from '@open-mercato/shared/lib/commands'
import { QuoteEvent, QuoteRecord } from '../data/entities'
import { mutationSchema, type Mutation } from '../data/validators'
import { resolveAccess } from '../lib/access'
import { actionAccess, apply, deny, QuoteFault, startQuote } from '../lib/workflow'

export const commandId = 'factory_quotes.workspace.apply'
const command: CommandHandler<Mutation, { id: string; revision: number; document?: unknown; receipt?: string }> = {
  id: commandId,
  async execute(raw, ctx) {
    const input = mutationSchema.parse(raw)
    const { id, token, revision, action } = input
    const { actor, scope, have } = await resolveAccess(ctx)
    deny(have.has(actionAccess(action)), 'forbidden', 403)
    if (action.type === 'actual') deny(have.has('cost'), 'forbidden', 403)
    const em = ctx.container.resolve<EntityManager>('em')
    const fingerprint = createHash('sha256').update(JSON.stringify({ revision, action })).digest('hex')
    const now = new Date()
    try {
      return await em.fork().transactional(async (tx) => {
        let row = await tx.findOne(QuoteRecord, { id, ...scope }, { lockMode: LockMode.PESSIMISTIC_WRITE })
        const creating = action.type === 'new_quote' || action.type === 'new_template'
        if (row) {
          const prior = await tx.findOne(QuoteEvent, { recordId: id, actorId: actor, token, ...scope })
          if (prior) {
            deny(prior.fingerprint === fingerprint, 'token_reuse', 409)
            return { id, revision: prior.revision, ...(action.type === 'csv_preview' ? { receipt: prior.id } : {}), ...(action.type === 'export' && row.state.type === 'quote' ? { document: row.state.release?.document } : {}) }
          }
        }
        let eventId = randomUUID()
        if (action.type === 'csv_import') {
          deny(row?.state.type === 'quote', 'not_found', 404)
          const preview = await tx.findOne(QuoteEvent, { id: action.receipt, recordId: id, actorId: actor, action: 'csv_preview', ...scope })
          const staged = preview?.details.action as { digest?: string; headerRow?: number; templateId?: string } | undefined
          deny(preview && staged?.digest === action.digest && staged.headerRow === action.headerRow && staged.templateId === action.templateId, 'csv_preview_mismatch', 409)
          deny(preview.revision === revision, 'stale_revision', 409)
          deny(preview.createdAt.getTime() > now.getTime() - 30 * 60 * 1000, 'csv_preview_expired', 409)
          // Same file, selected range and mapping cannot append again through a
          // new retry token; deterministic receipt lookup is inside the row lock.
          const digest = createHash('sha256').update(JSON.stringify([scope.tenantId, scope.organizationId, id,
            action.digest, action.headerRow, action.from, action.to, Object.entries(action.mapping).sort()])).digest('hex')
          eventId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`
          const duplicate = await tx.findOne(QuoteEvent, { id: eventId, recordId: id, ...scope })
          deny(!duplicate, 'csv_already_imported', 409)
        }
        if (creating) {
          deny(!row && revision === -1, 'stale_revision', 409)
          if (action.type === 'new_template') {
            row = tx.create(QuoteRecord, { ...scope, id, kind: 'template', title: action.spec.name, revision: 0,
              state: { type: 'template', stage: 'draft', spec: action.spec, tested: false }, createdAt: now, updatedAt: now })
          } else {
            const template = await tx.findOne(QuoteRecord, { id: action.templateId, kind: 'template', ...scope })
            deny(template?.state.type === 'template', 'template_not_found', 404)
            row = tx.create(QuoteRecord, { ...scope, id, kind: 'quote', title: action.draft.customer, revision: 0,
              state: startQuote(template.state, template.id, action.draft, have.has('cost')), createdAt: now, updatedAt: now })
          }
        } else {
          deny(row, 'not_found', 404)
          deny(row.revision === revision, 'stale_revision', 409)
          row.state = apply(row.state, action, actor, now.toISOString(), have.has('cost'))
          row.title = row.state.type === 'template' ? row.state.spec.name : row.state.draft.customer
          // Chat and export audit events don't invalidate in-flight business edits.
          if (!['message', 'export', 'sent', 'csv_preview'].includes(action.type)) { row.revision++; row.updatedAt = now }
        }
        const details: Record<string, unknown> = { action }
        if (row.state.type === 'quote' && action.type === 'submit') details.frozen = row.state.submission?.frozen
        tx.persist(row)
        if (creating) await tx.flush()
        tx.persist(tx.create(QuoteEvent, { ...scope, id: eventId, recordId: id, actorId: actor, token,
          action: action.type, fingerprint, revision: row.revision, details, createdAt: now }))
        return { id, revision: row.revision, ...(action.type === 'csv_preview' ? { receipt: eventId } : {}), ...(action.type === 'export' && row.state.type === 'quote' ? { document: row.state.release?.document } : {}) }
      })
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) throw new QuoteFault(409, 'concurrent_submission')
      throw error
    }
  },
}
registerCommand(command)
