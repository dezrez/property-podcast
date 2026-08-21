/**
 * Microsoft Marketplace onboarding page.
 *
 * Flow: Microsoft redirects the purchaser here with ?token=<purchase token>.
 * The buyer signs in with Microsoft Entra (the multitenant buyer application),
 * and the purchase token is sent to our backend, which exchanges it with
 * Microsoft's SaaS Fulfillment Resolve API using credentials that never leave
 * the server.
 *
 * Security notes:
 *  - The purchase token is never rendered, never logged, and is removed from
 *    the address bar as soon as it is read, so it does not linger in browser
 *    history or leak through a Referer header.
 *  - Nothing here holds or sees the fulfillment client secret. The only
 *    identifier the page knows is the buyer application's client ID, which is
 *    public by design and fetched from /api/marketplace/config.
 */
(function () {
  'use strict';

  var TOKEN_STASH_KEY = 'marketplace.purchaseToken';
  var PANELS = ['loading', 'signin', 'resolving', 'active', 'inactive', 'no-token', 'error'];

  var state = { token: null, config: null, msal: null, account: null };

  /* ------------------------------------------------------------------ view */

  function show(name) {
    PANELS.forEach(function (panel) {
      var el = document.getElementById('panel-' + panel);
      if (el) el.hidden = panel !== name;
    });
  }

  function setFacts(listId, subscription) {
    var dl = document.getElementById(listId);
    if (!dl) return;
    dl.textContent = '';

    var rows = [
      ['Plan', subscription.planId],
      ['Offer', subscription.offerId],
      ['Status', subscription.status],
      ['Subscription ID', subscription.subscriptionId],
      ['Term', termLabel(subscription.termUnit)]
    ];
    if (typeof subscription.quantity === 'number' && subscription.quantity > 1) {
      rows.push(['Quantity', String(subscription.quantity)]);
    }
    if (subscription.isFreeTrial) rows.push(['Free trial', 'Yes']);
    if (subscription.isTest) rows.push(['Test purchase', 'Yes']);

    rows.forEach(function (row) {
      if (!row[1]) return;
      var dt = document.createElement('dt');
      dt.textContent = row[0];
      var dd = document.createElement('dd');
      dd.textContent = row[1];
      dl.appendChild(dt);
      dl.appendChild(dd);
    });
  }

  function termLabel(termUnit) {
    if (termUnit === 'P1M') return '1 month';
    if (termUnit === 'P1Y') return '1 year';
    return termUnit || '';
  }

  function showError(code, message) {
    document.getElementById('errorBody').textContent = message;
    document.getElementById('errorCode').textContent = code || 'unknown';
    show('error');
  }

  /**
   * Maps backend error codes to something a buyer can act on. The wording for
   * an expired token follows Microsoft's own recommended guidance.
   */
  function messageForError(code) {
    switch (code) {
      case 'purchase_token_missing':
      case 'purchase_token_invalid':
        return "We couldn't identify this purchase. Reopen this subscription in the " +
          'Azure portal or Microsoft 365 admin centre and select Configure account ' +
          'or Manage account again — the link is only valid for 24 hours.';
      case 'token_rejected':
      case 'token_request_failed':
      case 'token_malformed':
      case 'fulfillment_unauthorized':
        return 'We could not reach Microsoft to confirm this purchase. This is a ' +
          'problem at our end rather than with your subscription. Please try again ' +
          'shortly, and contact support if it continues.';
      case 'store_not_configured':
      case 'store_unavailable':
      case 'store_read_failed':
      case 'store_write_failed':
      case 'not_configured':
        return 'This service is not fully configured yet. Please contact support so ' +
          'we can finish setting it up.';
      case 'network':
        return 'We could not reach our servers. Check your connection and try again.';
      default:
        return 'Something went wrong confirming this purchase. Please try again, and ' +
          'contact support if it keeps happening.';
    }
  }

  /* ----------------------------------------------------------------- token */

  /**
   * Reads the purchase token from the URL, stashing it so it survives the
   * Entra sign-in redirect, then strips it from the address bar.
   *
   * URLSearchParams already percent-decodes, so the value handed to the backend
   * is the decoded token Microsoft's Resolve API expects. It must not be
   * decoded a second time.
   */
  function readPurchaseToken() {
    var fromUrl = null;
    try {
      fromUrl = new URLSearchParams(window.location.search).get('token');
    } catch (e) {
      fromUrl = null;
    }

    if (fromUrl) {
      try {
        window.sessionStorage.setItem(TOKEN_STASH_KEY, fromUrl);
      } catch (e) {
        /* private mode — the in-memory value still works for this page load */
      }
      // Remove it from the visible URL and from history.
      try {
        window.history.replaceState({}, document.title, window.location.pathname);
      } catch (e) {
        /* non-fatal */
      }
      return fromUrl;
    }

    try {
      return window.sessionStorage.getItem(TOKEN_STASH_KEY);
    } catch (e) {
      return null;
    }
  }

  function clearStashedToken() {
    try {
      window.sessionStorage.removeItem(TOKEN_STASH_KEY);
    } catch (e) {
      /* nothing to do */
    }
  }

  /* ---------------------------------------------------------------- config */

  function loadConfig() {
    return fetch('api/marketplace/config', { headers: { accept: 'application/json' } })
      .then(function (res) {
        if (!res.ok) throw new Error('config');
        return res.json();
      });
  }

  /* ------------------------------------------------------------------ msal */

  function initMsal(config) {
    if (typeof msal === 'undefined' || !msal.PublicClientApplication) {
      return Promise.reject(new Error('msal_unavailable'));
    }

    var instance = new msal.PublicClientApplication({
      auth: {
        clientId: config.buyerClientId,
        authority: config.authority,
        // Must match the SPA redirect URI registered on the buyer application.
        redirectUri: window.location.origin + '/marketplace',
        navigateToLoginRequestUrl: false
      },
      cache: { cacheLocation: 'sessionStorage', storeAuthStateInCookie: false }
    });

    return instance.initialize().then(function () {
      return instance.handleRedirectPromise().then(function (result) {
        state.msal = instance;
        var account = (result && result.account) || instance.getAllAccounts()[0] || null;
        if (account) instance.setActiveAccount(account);
        return account;
      });
    });
  }

  function signIn() {
    if (!state.msal) return;
    state.msal
      .loginRedirect({ scopes: ['openid', 'profile'], prompt: 'select_account' })
      .catch(function () {
        showError('signin_failed', 'We could not start the Microsoft sign-in. Please try again.');
      });
  }

  function showSignedInAs(account) {
    if (!account) return;
    var el = document.getElementById('signedInAs');
    var who = account.username || account.name;
    if (!who) return;
    el.textContent = 'Signed in as ' + who;
    el.hidden = false;
  }

  /* --------------------------------------------------------------- resolve */

  function resolveSubscription(token) {
    show('resolving');

    return fetch('api/marketplace/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ token: token })
    })
      .then(function (res) {
        return res
          .json()
          .catch(function () {
            return {};
          })
          .then(function (body) {
            return { ok: res.ok, body: body };
          });
      })
      .then(function (result) {
        if (!result.ok) {
          var code = result.body && result.body.error;
          showError(code, messageForError(code));
          return;
        }

        var subscription = result.body && result.body.subscription;
        if (!subscription) {
          showError('resolve_malformed', messageForError('resolve_malformed'));
          return;
        }

        // The purchase token has served its purpose; do not keep it around.
        clearStashedToken();

        if (subscription.active) {
          setFacts('subscriptionFacts', subscription);
          show('active');
        } else {
          setFacts('inactiveFacts', subscription);
          document.getElementById('inactiveBody').textContent = inactiveMessage(subscription.status);
          show('inactive');
        }
      })
      .catch(function () {
        showError('network', messageForError('network'));
      });
  }

  function inactiveMessage(status) {
    switch (status) {
      case 'Suspended':
        return 'This subscription is suspended, usually because a payment did not go ' +
          'through. Once the payment method is updated in the Microsoft 365 admin ' +
          'centre it will be reinstated automatically.';
      case 'Unsubscribed':
        return 'This subscription has been cancelled. To use it again, purchase it ' +
          'once more from Microsoft Marketplace.';
      case 'PendingFulfillmentStart':
        return 'Microsoft has recorded the purchase but has not finished activating it ' +
          'yet. Please refresh this page in a few moments.';
      default:
        return 'This subscription is not currently active. Please contact support if ' +
          'you believe that is wrong.';
    }
  }

  /* ------------------------------------------------------------------ boot */

  function start() {
    show('loading');
    state.token = readPurchaseToken();

    loadConfig()
      .then(function (config) {
        state.config = config;

        if (!config || !config.buyerClientId) {
          showError('not_configured', messageForError('not_configured'));
          return null;
        }
        return initMsal(config);
      })
      .then(function (account) {
        if (account === null && (!state.config || !state.config.buyerClientId)) return;

        state.account = account;
        showSignedInAs(account);

        // No purchase token means the page was opened directly rather than
        // from Marketplace. Say so plainly instead of failing.
        if (!state.token) {
          show('no-token');
          return;
        }

        if (!account) {
          show('signin');
          return;
        }

        return resolveSubscription(state.token);
      })
      .catch(function (err) {
        var code = err && err.message === 'msal_unavailable' ? 'signin_unavailable' : 'startup_failed';
        showError(
          code,
          'We could not start the sign-in process. Please reload the page, and ' +
            'contact support if it keeps happening.'
        );
      });
  }

  document.getElementById('signInBtn').addEventListener('click', signIn);
  document.getElementById('retryBtn').addEventListener('click', function () {
    if (state.token && state.account) {
      resolveSubscription(state.token);
    } else {
      window.location.reload();
    }
  });

  start();
})();
