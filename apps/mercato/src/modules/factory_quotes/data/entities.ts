import { Entity, Index, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy'
import type { QuoteState, TemplateState } from '../lib/workflow'

@Entity({ tableName: 'factory_quote_records' })
@Index({ name: 'factory_quote_records_scope_idx', properties: ['tenantId', 'organizationId', 'kind', 'updatedAt'] })
export class QuoteRecord {
  @PrimaryKey({ type: 'uuid' }) id!: string
  @Property({ type: 'uuid' }) tenantId!: string
  @Property({ type: 'uuid' }) organizationId!: string
  @Property({ type: 'text' }) kind!: 'quote' | 'template'
  @Property({ type: 'text' }) title!: string
  @Property({ type: 'integer' }) revision!: number
  @Property({ type: 'json' }) state!: TemplateState | QuoteState
  @Property({ type: Date }) updatedAt!: Date
  @Property({ type: Date }) createdAt!: Date
}

@Entity({ tableName: 'factory_quote_events' })
@Unique({ name: 'factory_quote_events_idempotency_uq', properties: ['recordId', 'actorId', 'token'] })
export class QuoteEvent {
  @PrimaryKey({ type: 'uuid' }) id!: string
  @Property({ type: 'uuid' }) recordId!: string
  @Property({ type: 'uuid' }) tenantId!: string
  @Property({ type: 'uuid' }) organizationId!: string
  @Property({ type: 'uuid' }) actorId!: string
  @Property({ type: 'uuid' }) token!: string
  @Property({ type: 'text' }) action!: string
  @Property({ type: 'text' }) fingerprint!: string
  @Property({ type: 'integer' }) revision!: number
  @Property({ type: 'json' }) details!: Record<string, unknown>
  @Property({ type: Date }) createdAt!: Date
}
