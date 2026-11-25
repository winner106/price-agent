import { z } from 'zod'
import { decimalPattern } from '../lib/money'

const key = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/).refine((v) => !['constructor', 'prototype'].includes(v))
const text = z.string().trim().min(1).max(250)
const decimal = z.string().regex(decimalPattern)
const date = z.iso.date()
const unit = z.enum(['mm', 'cm', 'm', 'mm2', 'cm2', 'm2', 'g', 'kg', 'min', 'h'])
const condition = z.object({ field: key, equals: text }).strict()
const field = z.object({
  key, label: text, aliases: z.array(text).max(8), public: z.boolean(), required: z.boolean(),
  type: z.enum(['text', 'integer', 'decimal', 'date', 'boolean', 'select', 'multi', 'measure', 'reference']),
  options: z.array(text).max(30), unit: unit.optional(), requiredWhen: condition.optional(),
}).strict()
const rule = z.object({
  key, label: text, basis: z.enum(['batch', 'unit', 'prep_hours', 'piece_hours']),
  driver: key.optional(), layer: z.enum(['manufacturing', 'commercial']), when: condition.optional(),
}).strict()
export const templateSchema = z.object({
  name: text, fields: z.array(field).min(1).max(40), rules: z.array(rule).min(1).max(24),
  approval: z.object({ direct: z.boolean(), minReturn: decimal, maxAmount: decimal }).strict(),
  brand: z.string().regex(/^#[a-fA-F0-9]{6}$/),
}).strict()
export const evidenceSchema = z.object({
  rate: decimal, source: text, validFrom: date, validUntil: date,
}).strict().refine((e) => e.validFrom <= e.validUntil)
export const itemSchema = z.object({
  name: text, quantity: z.string().regex(/^[1-9]\d{0,8}$/), price: decimal,
  fields: z.record(key, z.string().max(250)),
}).strict()
export const draftSchema = z.object({
  customer: text, items: z.array(itemSchema).min(1).max(50), requestedDelivery: date.optional(),
  delivery: date.optional(), destination: z.string().trim().max(250), payment: z.string().trim().max(250),
  freight: z.string().trim().max(250), validUntil: date.optional(), taxRate: decimal, exceptional: z.boolean(),
}).strict()
const confirmation = z.object({ kind: z.enum(['technical', 'cost', 'delivery']), evidence: text, sourcePerson: text.optional() }).strict()
const actual = z.object({ quantity: z.string().regex(/^[1-9]\d{0,8}$/), totalCost: decimal,
  materialUsage: text, prepHours: decimal, workHours: decimal, subcontract: decimal, source: text, comment: text }).strict()
const csvHash = z.string().regex(/^[a-f0-9]{64}$/)
export const csvPosition = z.number().int().min(1).max(10 * 1024 * 1024)
const csvKey = z.string().regex(/^(name|quantity|price|field:[a-z][a-z0-9_]{0,47})$/)
export const csvMapping = z.record(csvKey, z.number().int().min(1).max(100))
export const csvPacket = z.object({
  id: z.uuid(), token: z.uuid(), revision: z.number().int().min(0).max(1_000_000_000),
  headerRow: csvPosition, templateId: z.uuid(),
  apply: z.object({ receipt: z.uuid(), mapping: csvMapping, from: csvPosition, to: csvPosition }).strict().optional(),
}).strict()
export const mutationSchema = z.object({
  id: z.uuid(), token: z.uuid(), revision: z.number().int().min(-1).max(1_000_000_000),
  action: z.discriminatedUnion('type', [
    z.object({ type: z.literal('new_template'), spec: templateSchema }).strict(),
    z.object({ type: z.literal('edit_template'), spec: templateSchema }).strict(),
    z.object({ type: z.literal('test_template') }).strict(),
    z.object({ type: z.literal('publish_template') }).strict(),
    z.object({ type: z.literal('new_quote'), templateId: z.uuid(), draft: draftSchema }).strict(),
    z.object({ type: z.literal('edit_quote'), draft: draftSchema }).strict(),
    z.object({ type: z.literal('evidence'), rates: z.array(z.record(key, evidenceSchema)).max(50) }).strict(),
    z.object({ type: z.literal('confirm'), confirmation }).strict(),
    z.object({ type: z.literal('submit') }).strict(),
    z.object({ type: z.literal('approve') }).strict(),
    z.object({ type: z.literal('return'), reason: text }).strict(),
    z.object({ type: z.literal('release') }).strict(),
    z.object({ type: z.literal('export') }).strict(),
    z.object({ type: z.literal('sent'), source: text }).strict(),
    z.object({ type: z.literal('outcome'), result: z.enum(['won', 'lost', 'revision_requested']), source: text }).strict(),
    z.object({ type: z.literal('actual'), actual }).strict(),
    z.object({ type: z.literal('message'), text: z.string().trim().min(1).max(4000) }).strict(),
    z.object({ type: z.literal('csv_preview'), digest: csvHash, templateId: z.uuid(), headerRow: csvPosition,
      headers: z.array(z.string().max(4096)).min(1).max(100), totalRows: z.number().int().min(1).max(10_000) }).strict(),
    z.object({ type: z.literal('csv_import'), digest: csvHash, templateId: z.uuid(), headerRow: csvPosition, receipt: z.uuid(),
      mapping: csvMapping, from: csvPosition, to: csvPosition, items: z.array(itemSchema).min(1).max(50),
      sourceRows: z.array(z.object({ row: csvPosition, original: z.record(csvKey, z.string().max(250)) }).strict()).min(1).max(50) }).strict(),
  ]),
}).strict()
export type Template = z.infer<typeof templateSchema>
export type Draft = z.infer<typeof draftSchema>
export type Evidence = z.infer<typeof evidenceSchema>
export type Mutation = z.infer<typeof mutationSchema>
