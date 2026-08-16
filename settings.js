/**
 * Node-RED settings.js — tuned for Render Free (512 MB RAM / 0.1 CPU)
 *
 * Design goals:
 *  - Read PORT from the environment (Render injects this at runtime).
 *  - Keep the editor UI off the same path as your webhooks/APIs.
 *  - Turn off features that cost RAM/disk churn but aren't needed here
 *    (diagnostics endpoint, runtime state polling, the Projects git
 *    feature, verbose metrics/audit logging).
 *  - Optional HTTP Basic-style admin auth via env vars, since a Render
 *    Free service gets a public onrender.com URL by default.
 *
 * No secrets are hardcoded here — everything sensitive comes from
 * Render environment variables set in the dashboard (or render.yaml).
 */

const adminAuth =
    process.env.NODE_RED_USERNAME && process.env.NODE_RED_PASSWORD_HASH
        ? {
              type: "credentials",
              users: [
                  {
                      username: process.env.NODE_RED_USERNAME,
                      password: process.env.NODE_RED_PASSWORD_HASH, // bcrypt hash, NOT plaintext
                      permissions: "*",
                  },
              ],
          }
        : undefined;

if (!adminAuth) {
    console.log(
        "[settings.js] WARNING: NODE_RED_USERNAME / NODE_RED_PASSWORD_HASH not set — " +
            "the editor and admin API are UNAUTHENTICATED. Set both env vars in Render " +
            "to secure /admin before exposing this service publicly."
    );
}

module.exports = {
    // --- Networking -----------------------------------------------------
    uiPort: process.env.PORT || 10000,
    uiHost: "0.0.0.0",

    // Keep the editor off the root path so httpNodeRoot ('/') is free for
    // your own webhooks/APIs built with http-in nodes.
    httpAdminRoot: "/admin",
    httpNodeRoot: "/",
    disableEditor: process.env.NODE_RED_DISABLE_EDITOR === "true",

    adminAuth: adminAuth,

    requireHttps: false, // Render terminates TLS at its edge/proxy

    // --- Storage ----------------------------------------------------------
    // /data is the only writable path in the container. On Render Free
    // this is EPHEMERAL (no persistent disk) — it survives while the
    // instance is up, but is wiped on every redeploy and on cold start
    // after spin-down. See entrypoint.sh for how the baseline flow is
    // reseeded, and README section "Persisting your flows" for options.
    userDir: "/data",
    flowFile: "flows.json",
    flowFilePretty: false,

    // credentialSecret also protects the Credential Manager's Google
    // OAuth2 credential fields (Client ID/Secret/Access/Refresh
    // tokens) — see nodes/credential-manager/. No separate encryption
    // key is introduced for that feature; it reuses this one.
    credentialSecret: process.env.NODE_RED_CREDENTIAL_SECRET || undefined,

    contextStorage: {
        default: { module: "localfilesystem" },
    },

    // --- Memory / RAM optimizations ---------------------------------------
    diagnostics: {
        enabled: false,
        ui: false,
    },
    runtimeState: {
        enabled: false,
        ui: false,
    },
    logging: {
        console: {
            level: process.env.NODE_RED_LOG_LEVEL || "info",
            metrics: false,
            audit: false,
        },
    },
    debugMaxLength: 500,
    exportGlobalContextKeys: false,
    functionGlobalContext: {},
    functionExternalModules: false,

    editorTheme: {
        projects: { enabled: false }, // avoid git/project overhead
        tours: false,
    },

    // Palette install-from-editor is left on (the current, non-deprecated
    // way to control it) — convenient for adding nodes without a rebuild,
    // though on Render Free this only affects the running ephemeral
    // container until the next redeploy re-installs from package.json.
    externalModules: {
        palette: { allowInstall: true },
    },

    // --- HTTP tuning --------------------------------------------------------
    httpRequestTimeout: 30000,
    mqttReconnectTime: 15000,
    serialReconnectTime: 15000,
};
