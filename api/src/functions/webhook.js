/**
 * POST /api/marketplace/webhook
 *
 * Publicly reachable by Microsoft, but authenticated: the Entra JWT in the
 * Authorization header is fully validated, and the payload is corroborated
 * against Microsoft's own APIs before anything is persisted.
 */
import { app } from '@azure/functions';
import { handleWebhook } from '../lib/handlers.js';
import { header, httpEntry, readBody } from '../lib/invoke.js';

app.http('marketplaceWebhook', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'marketplace/webhook',
  handler: httpEntry('marketplace.webhook', async ({ request, context, runtime }) => {
    const rawBody = await readBody(request);
    return handleWebhook({
      authorizationHeader: header(request, 'authorization'),
      rawBody,
      deps: { ...runtime, context }
    });
  })
});
