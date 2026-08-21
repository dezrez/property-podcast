/**
 * Authenticates inbound Marketplace webhook calls.
 *
 * Microsoft's guidance is explicit that checking for the *presence* of an
 * Authorization header is not enough — the JWT must be validated, and the
 * payload separately corroborated by calling the Get Operation API:
 *
 *   "ISVs must validate the Microsoft Entra Token (JWT Token) on their webhook
 *    endpoint from the request header."
 *   "The SaaS service is required to call the Get Operation API to validate and
 *    authorize the webhook call and payload data before taking action."
 *   https://learn.microsoft.com/partner-center/marketplace-offers/pc-saas-fulfillment-webhook
 *
 * The documented claims are:
 *   aud          - the Entra application ID registered in Partner Center's
 *                  technical configuration (our Fulfillment app)
 *   appid | azp  - the Marketplace SaaS resource ID. Microsoft notes the value
 *                  may appear in either claim depending on app setup, so both
 *                  are accepted.
 *   tid          - the tenant ID registered in the technical configuration
 */
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { MarketplaceError } from './logging.js';

/** Tolerance for clock drift between Microsoft and the Function host. */
const CLOCK_TOLERANCE_SECONDS = 60;

export function createWebhookAuthenticator({ config, keyStore = null }) {
  const jwks =
    keyStore ||
    createRemoteJWKSet(
      new URL(`https://login.microsoftonline.com/${config.tenantId}/discovery/v2.0/keys`)
    );

  // Entra issues v1.0 and v2.0 format tokens with different issuer strings.
  // Both are legitimate for the same tenant, so accept either rather than
  // guessing which one the Marketplace service will present.
  const allowedIssuers = new Set([
    `https://sts.windows.net/${config.tenantId}/`,
    `https://login.microsoftonline.com/${config.tenantId}/v2.0`
  ]);

  /**
   * @param {string|undefined|null} authorizationHeader
   * @returns {Promise<object>} the verified claims
   */
  return async function authenticate(authorizationHeader) {
    if (typeof authorizationHeader !== 'string' || authorizationHeader.length === 0) {
      throw new MarketplaceError('auth_header_missing');
    }

    const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
    if (!match) throw new MarketplaceError('auth_scheme_invalid');
    const token = match[1].trim();
    if (!token) throw new MarketplaceError('auth_scheme_invalid');

    let claims;
    try {
      // Audience is enforced here so a token minted for a different
      // application can never pass, even if it is otherwise well formed.
      const verified = await jwtVerify(token, jwks, {
        audience: config.fulfillmentClientId,
        clockTolerance: CLOCK_TOLERANCE_SECONDS
      });
      claims = verified.payload;
    } catch (err) {
      throw mapVerifyError(err);
    }

    if (!allowedIssuers.has(claims.iss)) {
      throw new MarketplaceError('auth_issuer_invalid');
    }
    if (claims.tid !== config.tenantId) {
      throw new MarketplaceError('auth_tenant_invalid');
    }

    const callerAppId = claims.appid || claims.azp;
    if (callerAppId !== config.saasResourceId) {
      throw new MarketplaceError('auth_appid_invalid');
    }

    return claims;
  };
}

function mapVerifyError(err) {
  const code = err && err.code;
  if (code === 'ERR_JWT_EXPIRED') return new MarketplaceError('auth_token_expired');
  if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') {
    // jose reports which claim failed; audience is the one we assert here.
    return new MarketplaceError(
      err.claim === 'aud' ? 'auth_audience_invalid' : 'auth_claim_invalid'
    );
  }
  if (code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED') {
    return new MarketplaceError('auth_signature_invalid');
  }
  // Everything else (malformed token, unknown key, JWKS fetch failure) is
  // reported as a single opaque code so responses never describe the token.
  return new MarketplaceError('auth_token_invalid');
}
