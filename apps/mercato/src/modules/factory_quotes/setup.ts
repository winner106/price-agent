import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: { admin: ['factory_quotes.view', 'factory_quotes.configure', 'factory_quotes.publish_template'] },
}
