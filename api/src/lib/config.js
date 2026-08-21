/**
 * Configuration for the Marketplace integration.
 *
 * Everything comes from environment variables (Static Web Apps application
 * settings in Azure, local.settings.json when running locally). Nothing here
 * is ever committed, and the secret is never returned by any accessor that
 * could reach a log or a response body.
 */

// The fixed application ID of Microsoft's Marketplace SaaS API. Documented as
// the resource to request tokens for, and as the value that appears in the
// webhook JWT's appid/azp claim.
// https://learn.microsoft.com/partner-center/marketplace-offers/pc-saas-registration
export const DEFAULT_SAAS_RESOURCE_ID = '20e940b3-4c77-4b0b-9a53-9e16a1b010a7';

// Current documented version of the SaaS Fulfillment APIs v2. Confirmed against
// Microsoft Learn (pc-saas-fulfillment-subscription-api, "Use 2018-08-31").
export const FULFILLMENT_API_VERSION = '2018-08-31';

export const FULFILLMENT_BASE_URL = 'https://marketplaceapi.microsoft.com/api/saas';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reads configuration and reports what is missing rather than throwing at
 * import time — a throwing module would take the whole Function host down and
 * make every endpoint fail opaquely instead of returning a clear 503.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {{ok: boolean, missing: string[], invalid: string[], config: object}}
 */
export function loadConfig(env = process.env) {
  const config = {
    tenantId: trim(env.MARKETPLACE_TENANT_ID),
    fulfillmentClientId: trim(env.MARKETPLACE_FULFILLMENT_CLIENT_ID),
    fulfillmentClientSecret: trim(env.MARKETPLACE_FULFILLMENT_CLIENT_SECRET),
    buyerClientId: trim(env.MARKETPLACE_BUYER_CLIENT_ID),
    saasResourceId: trim(env.MARKETPLACE_SAAS_RESOURCE_ID) || DEFAULT_SAAS_RESOURCE_ID,
    storageConnection: trim(env.MARKETPLACE_STORAGE_CONNECTION),
    tableName: trim(env.MARKETPLACE_TABLE_NAME) || 'MarketplaceSubscriptions'
  };

  const missing = [];
  for (const [key, name] of [
    ['tenantId', 'MARKETPLACE_TENANT_ID'],
    ['fulfillmentClientId', 'MARKETPLACE_FULFILLMENT_CLIENT_ID'],
    ['fulfillmentClientSecret', 'MARKETPLACE_FULFILLMENT_CLIENT_SECRET'],
    ['storageConnection', 'MARKETPLACE_STORAGE_CONNECTION']
  ]) {
    if (!config[key]) missing.push(name);
  }

  // The buyer client ID is only needed to validate buyer sign-in tokens, so a
  // missing value degrades that check rather than disabling the endpoints.
  const invalid = [];
  if (config.tenantId && !GUID.test(config.tenantId)) invalid.push('MARKETPLACE_TENANT_ID');
  if (config.fulfillmentClientId && !GUID.test(config.fulfillmentClientId)) {
    invalid.push('MARKETPLACE_FULFILLMENT_CLIENT_ID');
  }
  if (config.saasResourceId && !GUID.test(config.saasResourceId)) {
    invalid.push('MARKETPLACE_SAAS_RESOURCE_ID');
  }
  if (config.buyerClientId && !GUID.test(config.buyerClientId)) {
    invalid.push('MARKETPLACE_BUYER_CLIENT_ID');
  }

  return { ok: missing.length === 0 && invalid.length === 0, missing, invalid, config };
}

function trim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * A description of the configuration safe to write to a log: names only, never
 * values, and never any indication of the secret beyond whether it is set.
 */
export function describeConfig(result) {
  return {
    configured: result.ok,
    missing: result.missing,
    invalid: result.invalid,
    secretPresent: Boolean(result.config.fulfillmentClientSecret)
  };
}
