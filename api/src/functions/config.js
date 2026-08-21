/**
 * GET /api/marketplace/config
 *
 * Public, non-secret values the landing page needs in order to start a
 * Microsoft Entra sign-in. Exists so no tenant or client identifier has to be
 * baked into the static bundle, and so the same files work against a different
 * registration without a rebuild.
 *
 * Only ever returns values that are public by design. The fulfillment client
 * ID, tenant ID and client secret are deliberately absent.
 *
 * Unlike the other endpoints this does not require full configuration, so it
 * answers even when the app is only partly set up - the landing page then shows
 * a clear "not configured" state rather than failing opaquely.
 */
import { app } from '@azure/functions';
import { loadConfig } from '../lib/config.js';
import { toHttpResponse } from '../lib/runtime.js';
import { safeError, safeLog } from '../lib/logging.js';

app.http('marketplaceConfig', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'marketplace/config',
  handler: async (request, context) => {
    try {
      const { config } = loadConfig();
      return toHttpResponse({
        status: 200,
        body: {
          // A public identifier for a multitenant app registration.
          buyerClientId: config.buyerClientId || null,
          // 'common' admits both work/school accounts and personal Microsoft
          // accounts, which is what Microsoft requires of the landing page.
          authority: 'https://login.microsoftonline.com/common'
        }
      });
    } catch (err) {
      safeLog(context, 'error', 'marketplace.config.unhandled', safeError(err));
      return toHttpResponse({ status: 500, body: { error: 'unhandled' } });
    }
  }
});
