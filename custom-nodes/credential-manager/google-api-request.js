'use strict';

/**
 * google-api-request.js
 *
 * The "workflow node" side of the pattern:
 *   Credentials Manager -> Google OAuth2 Credential -> [this node] -> Google API
 *
 * This node never stores a token itself. On every input message it
 * asks the shared oauth2-core.ensureValidToken() for a currently-valid
 * access token for whichever credential the user selected in the
 * dropdown (config.credential = the config node's id) — refreshing it
 * first if needed — then makes the HTTP call. Any number of these
 * nodes, across any number of flows, can point at the same credential
 * id; the token/refresh state lives in exactly one place (the config
 * node's encrypted credentials), not duplicated per node.
 */

const oauth2 = require('./lib/oauth2-core');

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

module.exports = function (RED) {
    function GoogleApiRequestNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.credentialNode = RED.nodes.getNode(config.credential);
        node.method = (config.method || 'GET').toUpperCase();
        node.url = config.url || '';

        node.on('input', async function (msg, send, done) {
            send = send || node.send.bind(node);
            done = done || ((err) => err && node.error(err, msg));

            if (!node.credentialNode) {
                return done(new Error('No Google OAuth2 credential selected on this node.'));
            }

            try {
                node.status({ fill: 'blue', shape: 'dot', text: 'requesting…' });

                const token = await oauth2.ensureValidToken(RED, node.credentialNode.id, {
                    tokenUrl: GOOGLE_TOKEN_URL,
                });

                const template = node.url || msg.url || '';
                const resolvedUrl = String(template).replace(/{{\s*([\w.]+)\s*}}/g, (_, propPath) => {
                    const v = RED.util.getMessageProperty(msg, propPath);
                    return v === undefined ? '' : String(v);
                });

                const method = (msg.method || node.method || 'GET').toUpperCase();
                const headers = Object.assign({ Authorization: 'Bearer ' + token }, msg.headers || {});
                const fetchOpts = { method, headers };

                if (method !== 'GET' && method !== 'HEAD' && msg.payload !== undefined) {
                    headers['content-type'] = headers['content-type'] || 'application/json';
                    fetchOpts.body = typeof msg.payload === 'string' ? msg.payload : JSON.stringify(msg.payload);
                }

                const resp = await fetch(resolvedUrl, fetchOpts);
                const text = await resp.text();
                let body;
                try {
                    body = text ? JSON.parse(text) : undefined;
                } catch (e) {
                    body = text;
                }

                msg.statusCode = resp.status;
                msg.payload = body;

                node.status(
                    resp.ok
                        ? { fill: 'green', shape: 'dot', text: String(resp.status) }
                        : { fill: 'red', shape: 'ring', text: String(resp.status) }
                );
                send(msg);
                done();
            } catch (err) {
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                done(err);
            }
        });

        node.on('close', function () {
            node.status({});
        });
    }

    RED.nodes.registerType('google-api-request', GoogleApiRequestNode);
};
