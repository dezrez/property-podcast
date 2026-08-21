/**
 * POST /api/marketplace/resolve
 *
 * Exchanges a Marketplace purchase token for subscription details. Called by
 * the /marketplace landing page; the purchase token is itself the proof of
 * purchase, so no additional caller authentication is required or accepted.
 */
import { app } from '@azure/functions';
import { handleResolve } from '../lib/handlers.js';
import { httpEntry, readBody } from '../lib/invoke.js';

app.http('marketplaceResolve', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'marketplace/resolve',
  handler: httpEntry('marketplace.resolve', async ({ request, context, runtime }) => {
    const rawBody = await readBody(request);
    return handleResolve({ rawBody, deps: { ...runtime, context } });
  })
});
