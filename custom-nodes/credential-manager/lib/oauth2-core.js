'use strict';

/**
 * lib/oauth2-core.js
 *
 * Provider-agnostic OAuth2 helpers. Nothing in this file knows about
 * Google specifically — it only knows the standard OAuth2 authorization
 * code + refresh_token grant shapes. This is the piece that makes the
 * Credential Manager extensible: adding a new provider (Microsoft,
 * Slack, HubSpot, ...) later means writing a small
 * "<provider>-oauth2-credentials.js" config node that supplies its own
 * authorizeUrl/tokenUrl/scopes and reuses every function here — no
 * copy-pasting the token-exchange/refresh logic per provider.
 *
 * Node 22's built-in `fetch` is used, so no extra npm dependency is
 * needed for any of this.
 */

async function postForm(tokenUrl, params) {
    const body = new URLSearchParams(params);
    const resp = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
        const msg = data.error_description || data.error || `HTTP ${resp.status}`;
        throw new Error(`OAuth2 token endpoint error: ${msg}`);
    }
    return data;
}

/** Exchange an authorization code for tokens. */
function exchangeCode({ tokenUrl, clientId, clientSecret, redirectUri, code }) {
    return postForm(tokenUrl, {
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
    });
}

/** Use a refresh_token to obtain a new access_token. */
function refreshAccessToken({ tokenUrl, clientId, clientSecret, refreshToken }) {
    return postForm(tokenUrl, {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
    });
}

/** Build the browser-facing "Authorize" URL for the consent screen. */
function buildAuthorizeUrl({ authorizeUrl, clientId, redirectUri, scope, state, extraParams }) {
    const params = new URLSearchParams(
        Object.assign(
            {
                client_id: clientId,
                redirect_uri: redirectUri,
                response_type: 'code',
                scope,
                state,
            },
            extraParams || {}
        )
    );
    return `${authorizeUrl}?${params.toString()}`;
}

/** True if a stored token is expired (or about to be, within `skewMs`). */
function isExpired(tokenExpiryEpochMs, skewMs = 60000) {
    if (!tokenExpiryEpochMs) return true;
    return Date.now() > Number(tokenExpiryEpochMs) - skewMs;
}

/**
 * The core "get me a usable token" call every worker node (and the
 * local token endpoint used by Python scripts) goes through. Reads
 * the credential's current tokens via RED.nodes.getCredentials(id),
 * refreshes+persists via RED.nodes.addCredentials(id, ...) if the
 * access token is expired, and returns a valid access token string.
 *
 * This is the ONE place refresh logic lives — every consumer (a flow
 * node, the /token endpoint, a future provider) calls this instead of
 * re-implementing expiry checks.
 */
async function ensureValidToken(RED, id, { tokenUrl }) {
    const creds = RED.nodes.getCredentials(id) || {};
    if (!creds.accessToken) {
        throw new Error('Credential is not connected yet — use "Connect / Authorize" first.');
    }
    if (!isExpired(creds.tokenExpiry)) {
        return creds.accessToken;
    }
    if (!creds.refreshToken) {
        throw new Error('Access token expired and no refresh token is stored — reconnect this credential.');
    }
    const refreshed = await refreshAccessToken({
        tokenUrl,
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        refreshToken: creds.refreshToken,
    });
    const updated = Object.assign({}, creds, {
        accessToken: refreshed.access_token,
        // Some providers (Google included) omit refresh_token on a
        // refresh response — keep the previous one when that happens.
        refreshToken: refreshed.refresh_token || creds.refreshToken,
        tokenExpiry: String(Date.now() + Number(refreshed.expires_in || 3600) * 1000),
    });
    RED.nodes.addCredentials(id, updated);
    return updated.accessToken;
}

module.exports = {
    exchangeCode,
    refreshAccessToken,
    buildAuthorizeUrl,
    isExpired,
    ensureValidToken,
};
