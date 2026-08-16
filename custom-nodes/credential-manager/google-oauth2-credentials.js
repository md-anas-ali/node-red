'use strict';

/**
 * google-oauth2-credentials.js
 *
 * The "Credential Manager" entry for Google OAuth2, built as a
 * Node-RED CONFIG NODE — Node-RED's native mechanism for a single,
 * named, reusable object that any number of flow nodes can reference
 * by id, edited once in its own dialog, independent of any one flow.
 * That is exactly the role n8n's Credentials section plays, so
 * instead of building a parallel UI from scratch, this plugs into the
 * editor's existing config-node system (same place HTTP Request nodes'
 * "TLS configuration" or MQTT nodes' "broker" live).
 *
 * Fields declared under `credentials:` in RED.nodes.registerType below
 * (clientId, clientSecret, accessToken, refreshToken, tokenExpiry) are
 * automatically:
 *   - stored separately from flows.json (in the encrypted credentials
 *     file under /data), AES-256 encrypted using NODE_RED_CREDENTIAL_SECRET
 *   - never sent back to the browser in plaintext once saved — the
 *     editor only ever sees "is a value set?", not the value itself,
 *     for any field typed "password"
 * This is all existing Node-RED core behavior — nothing new was built
 * for encryption-at-rest or plaintext-hiding; we're reusing it.
 */

const oauth2 = require('./lib/oauth2-core');

const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
const DEFAULT_SCOPES = 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file';

module.exports = function (RED) {
    // --- Config node definition -----------------------------------------
    function GoogleOAuth2CredentialsNode(config) {
        RED.nodes.createNode(this, config);
        this.name = config.name;
        this.scopes = config.scopes || DEFAULT_SCOPES;
    }

    RED.nodes.registerType('google-oauth2-credentials', GoogleOAuth2CredentialsNode, {
        credentials: {
            clientId: { type: 'text' },
            clientSecret: { type: 'password' },
            accessToken: { type: 'password' },
            refreshToken: { type: 'password' },
            tokenExpiry: { type: 'text' }, // epoch ms — not secret on its own, kept alongside the tokens for convenience
        },
    });

    // --- Helpers -----------------------------------------------------------
    function computeRedirectUri(req) {
        const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        const adminRoot = RED.settings.httpAdminRoot === false ? '' : (RED.settings.httpAdminRoot || '/');
        const base = adminRoot.replace(/\/$/, '');
        return `${proto}://${host}${base}/credential-manager/google/oauth/callback`;
    }

    function isLoopback(req) {
        const ip = req.ip || (req.connection && req.connection.remoteAddress) || '';
        return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    }

    // --- 1. Kick off the consent flow --------------------------------------
    // Requires an editor session (adminAuth, when configured) — this is a
    // browser-initiated action from inside the Node-RED editor only.
    RED.httpAdmin.get(
        '/credential-manager/google/:id/authorize',
        RED.auth.needsPermission('flows.write'),
        function (req, res) {
            const id = req.params.id;
            const creds = RED.nodes.getCredentials(id) || {};
            if (!creds.clientId || !creds.clientSecret) {
                return res
                    .status(400)
                    .send('Save this credential (enter Client ID + Client Secret, then Deploy) before connecting.');
            }
            const node = RED.nodes.getNode(id);
            const scopes = (node && node.scopes) || DEFAULT_SCOPES;
            const url = oauth2.buildAuthorizeUrl({
                authorizeUrl: GOOGLE_AUTHORIZE_URL,
                clientId: creds.clientId,
                redirectUri: computeRedirectUri(req),
                scope: scopes,
                state: id,
                extraParams: {
                    access_type: 'offline', // required to receive a refresh_token
                    prompt: 'consent', // forces refresh_token on every reconnect, not just the first
                    include_granted_scopes: 'true',
                },
            });
            res.redirect(url);
        }
    );

    // --- 2. OAuth callback ---------------------------------------------------
    // MUST be reachable without an editor session — Google's redirect lands
    // here from the user's browser, which does carry the editor's session
    // cookie (the user is mid-flow from inside the editor), but Google
    // itself never authenticates against Node-RED, so no needsPermission here.
    RED.httpAdmin.get('/credential-manager/google/oauth/callback', async function (req, res) {
        const { code, state, error } = req.query;
        if (error) {
            return res.status(400).send(`Google returned an error: ${error}. You can close this tab.`);
        }
        const id = state;
        const creds = RED.nodes.getCredentials(id) || {};
        if (!id || !creds.clientId || !creds.clientSecret) {
            return res.status(400).send('Unknown or unsaved credential — save it first, then try connecting again.');
        }
        try {
            const tokenResp = await oauth2.exchangeCode({
                tokenUrl: GOOGLE_TOKEN_URL,
                clientId: creds.clientId,
                clientSecret: creds.clientSecret,
                redirectUri: computeRedirectUri(req),
                code,
            });
            const updated = Object.assign({}, creds, {
                accessToken: tokenResp.access_token,
                refreshToken: tokenResp.refresh_token || creds.refreshToken,
                tokenExpiry: String(Date.now() + Number(tokenResp.expires_in || 3600) * 1000),
            });
            RED.nodes.addCredentials(id, updated);
            RED.log.info(`[credential-manager] Google OAuth connected for credential ${id}`);
            res.send(
                '<html><body style="font-family:sans-serif;padding:2rem">' +
                    '<h3>Connected to Google &#10003;</h3>' +
                    '<p>You can close this tab and return to the Node-RED editor.</p>' +
                    '</body></html>'
            );
        } catch (e) {
            RED.log.error(`[credential-manager] Google OAuth callback failed: ${e.message}`);
            res.status(500).send(`Token exchange failed: ${e.message}`);
        }
    });

    // --- 3. Test connection ---------------------------------------------------
    RED.httpAdmin.get(
        '/credential-manager/google/:id/test',
        RED.auth.needsPermission('flows.write'),
        async function (req, res) {
            try {
                const token = await oauth2.ensureValidToken(RED, req.params.id, { tokenUrl: GOOGLE_TOKEN_URL });
                const r = await fetch(`${GOOGLE_TOKENINFO_URL}?access_token=${encodeURIComponent(token)}`);
                const info = await r.json();
                if (!r.ok) throw new Error(info.error_description || `tokeninfo returned ${r.status}`);
                res.json({ ok: true, scope: info.scope, expires_in: info.expires_in });
            } catch (e) {
                res.status(400).json({ ok: false, error: e.message });
            }
        }
    );

    // --- 4. Disconnect (clear tokens, keep Client ID/Secret) -------------------
    RED.httpAdmin.post(
        '/credential-manager/google/:id/disconnect',
        RED.auth.needsPermission('flows.write'),
        function (req, res) {
            const creds = RED.nodes.getCredentials(req.params.id) || {};
            RED.nodes.addCredentials(req.params.id, {
                clientId: creds.clientId,
                clientSecret: creds.clientSecret,
            });
            res.json({ ok: true });
        }
    );

    // --- 5. Local-only token endpoint, for Python (exec node) scripts -----------
    // Deliberately NOT behind RED.auth (Python has no editor session) and
    // deliberately NOT reachable from outside the container: gated on both
    // (a) the request originating from loopback, and (b) a shared secret
    // that Node-RED exports into its own environment at boot and that every
    // process it spawns (exec nodes) inherits automatically. See entrypoint.sh.
    RED.httpAdmin.get('/credential-manager/google/:id/token', async function (req, res) {
        const secret = process.env.NODE_RED_LOCAL_API_SECRET;
        if (!isLoopback(req) || !secret || req.get('x-local-secret') !== secret) {
            return res.status(403).json({ ok: false, error: 'forbidden' });
        }
        try {
            const token = await oauth2.ensureValidToken(RED, req.params.id, { tokenUrl: GOOGLE_TOKEN_URL });
            res.json({ ok: true, access_token: token });
        } catch (e) {
            res.status(400).json({ ok: false, error: e.message });
        }
    });
};
