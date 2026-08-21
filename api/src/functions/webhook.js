/**
 * POST /api/marketplace/webhook
 *
 * Publicly reachable by Microsoft, but authenticated: the Entra JWT in the
 * Authorization header is fully validated, and the payload is corroborated
 * against Microsoft's own APIs before anything is persisted.
 */
import { app } from '@azure/functions';
import { handleWebhook } from '../lib/handlers.js';
import { getRuntime, toHttpResponse } from '../lib/runtime.js';
import { MarketplaceError, safeError, safeLog } from '../lib/logging.js';

app.http('marketplaceWebhook', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'marketplace/webhook',
  handler: async (request, context) => {
    let runtime;
    try {
      runtime = await getRuntime(context);
    } catch (err) {
      safeLog(context, 'error', 'marketplace.webhook.unavailable', safeError(err));
      return toHttpResponse({
        status: 503,
        body: { error: err instanceof MarketplaceError ? err.code : 'not_configured' }
      });
    }

    const rawBody = await request.text();
    const result = await handleWebhook({
      authorizationHeader: request.headers.get('authorization'),
      rawBody,
      deps: { ...runtime, context }
    });
    return toHttpResponse(result);
  }
});
