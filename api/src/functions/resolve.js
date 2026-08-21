/**
 * POST /api/marketplace/resolve
 *
 * Exchanges a Marketplace purchase token for subscription details. Called by
 * the /marketplace landing page; the purchase token itself is the proof of
 * purchase, so no additional caller authentication is required or accepted.
 */
import { app } from '@azure/functions';
import { handleResolve } from '../lib/handlers.js';
import { getRuntime, toHttpResponse } from '../lib/runtime.js';
import { MarketplaceError, safeError, safeLog } from '../lib/logging.js';

app.http('marketplaceResolve', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'marketplace/resolve',
  handler: async (request, context) => {
    let runtime;
    try {
      runtime = await getRuntime(context);
    } catch (err) {
      safeLog(context, 'error', 'marketplace.resolve.unavailable', safeError(err));
      return toHttpResponse({
        status: 503,
        body: { error: err instanceof MarketplaceError ? err.code : 'not_configured' }
      });
    }

    const rawBody = await request.text();
    const result = await handleResolve({ rawBody, deps: { ...runtime, context } });
    return toHttpResponse(result);
  }
});
