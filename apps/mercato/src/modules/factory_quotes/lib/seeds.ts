import type { Template } from '../data/validators'
function field(key: string, label: string, type: Template['fields'][number]['type'] = 'text', isPublic = true): Template['fields'][number] {
  return { key, label, type, public: isPublic, required: true, aliases: [], options: [] }
}
export const machining: Template = {
  name: '定制机加工零件', brand: '#173b68', approval: { direct: false, minReturn: '0', maxAmount: '1000000' },
  fields: [field('drawing', '图号'), field('drawing_rev', '图纸版本'), field('material', '材料'),
    { ...field('length', '长度', 'measure'), unit: 'mm' }, field('tolerance', '公差'), field('finish', '表面处理'),
    field('prep', '准备工时', 'decimal', false), field('cycle', '单件工时', 'decimal', false),
    field('outsourced', '是否委外', 'boolean', false)],
  rules: [
    { key: 'material', label: '单件材料成本', basis: 'unit', layer: 'manufacturing' },
    { key: 'setup', label: '准备费', basis: 'prep_hours', layer: 'manufacturing', driver: 'prep' },
    { key: 'machine', label: '加工费', basis: 'piece_hours', layer: 'manufacturing', driver: 'cycle' },
    { key: 'outside', label: '委外批次费用', basis: 'batch', layer: 'manufacturing', when: { field: 'outsourced', equals: 'true' } },
    { key: 'packing', label: '包装和物流（整批）', basis: 'batch', layer: 'commercial' },
  ],
}
export const sku: Template = {
  ...machining, name: 'SKU 核价（人工依据）', fields: [field('sku', '料号')],
  rules: [{ key: 'purchase', label: '单件采购成本', basis: 'unit', layer: 'manufacturing' }],
}
