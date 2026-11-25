export const actions = ['view', 'configure', 'publish_template', 'edit', 'cost', 'technical', 'delivery', 'approve', 'release', 'review'] as const
export type Access = typeof actions[number]
export const features = actions.map((action) => ({ id: `factory_quotes.${action}`, title: `Factory quotes: ${action}`, module: 'factory_quotes',
  ...(action === 'view' ? {} : { dependsOn: ['factory_quotes.view'] }),
}))
