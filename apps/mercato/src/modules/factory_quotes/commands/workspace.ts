import { createHash, randomUUID } from 'node:crypto'
import { LockMode, UniqueConstraintViolationException } from '@mikro-orm/core'
import type { EntityManager } from '@mikro-orm/postgresql'
import { registerCommand, type CommandHandler } from '@open-mercato/shared/lib/commands'
import { QuoteEvent, QuoteRecord } from '../data/entities'
import { mutationSchema, type Mutation } from '../data/validators'
import { resolveAccess } from '../lib/access'
import { actionAccess, apply, deny, QuoteFault, startQuote } from '../lib/workflow'

export const commandId = 'factory_quotes.workspace.apply'
const command: CommandHandler<Mutation, { id: string; revision: number; document?: unknown }> = {
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
            return { id, revision: prior.revision, ...(action.type === 'export' && row.state.type === 'quote' ? { document: row.state.release?.document } : {}) }
          }
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
          if (!['message', 'export', 'sent'].includes(action.type)) { row.revision++; row.updatedAt = now }
        }
        const details: Record<string, unknown> = { action }
        if (row.state.type === 'quote' && action.type === 'submit') details.frozen = row.state.submission?.frozen
        tx.persist(row)
        if (creating) await tx.flush()
        tx.persist(tx.create(QuoteEvent, { ...scope, id: randomUUID(), recordId: id, actorId: actor, token,
          action: action.type, fingerprint, revision: row.revision, details, createdAt: now }))
        return { id, revision: row.revision, ...(action.type === 'export' && row.state.type === 'quote' ? { document: row.state.release?.document } : {}) }
      })
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) throw new QuoteFault(409, 'concurrent_submission')
      throw error
    }
  },
}
registerCommand(command)
