# Node-RED automation server — Render Free (512MB / 0.1 CPU)

Docker-based Node-RED 4.x automation server, built to fit inside Render's
Free web service tier. `entrypoint.sh` borrows only a *pattern* from the
original n8n reference file (bridge a Render-friendly env var into what the
tool actually needs) — no n8n code or config is reused anywhere. A custom
**Credential Manager** (`custom-nodes/credential-manager/`) provides
n8n-style, centralized OAuth2 credentials, starting with Google — see the
dedicated section below.

## Project structure

```
.
├── Dockerfile
├── entrypoint.sh
├── settings.js
├── package.json
├── package-lock.json
├── requirements.txt
├── flows-seed.json
├── render.yaml
├── docker-compose.yml
├── .dockerignore
├── .gitignore
├── .env.example
├── custom-nodes/
│   └── credential-manager/                 # Credential Manager (see below)
│       ├── package.json                    # makes it a local Node-RED node package
│       ├── google-oauth2-credentials.js    # config node ("the credential") + HTTP routes
│       ├── google-oauth2-credentials.html  # editor UI for the credential
│       ├── google-api-request.js           # worker node that USES a credential
│       ├── google-api-request.html         # editor UI for the worker node
│       └── lib/
│           └── oauth2-core.js              # provider-agnostic OAuth2 logic (extension point)
└── scripts/
    ├── ffmpeg_lock.sh
    ├── tts_edge.py
    ├── yt_download.py
    ├── google_token.py                     # Python-side: fetch a live token from the Credential Manager
    └── gsheet_append.py                    # example: append a row using that token
```

**Supporting files beyond the original 6** (not strictly required by
Render, but worth having in a real repo):

- **`package-lock.json`** — lets the Dockerfile use `npm ci` instead of
  `npm install`, locking every transitive dependency — including the local
  Credential Manager package — to an exact version. Regenerate with
  `npm install --package-lock-only` after touching `package.json` or
  anything under `custom-nodes/`.
- **`.gitignore`** — separate from `.dockerignore`. `.dockerignore` only
  controls the Docker build context; `.gitignore` controls what git tracks
  at all (local `.env`, an accidental `data/` folder, stray key files).
- **`.env.example`** — template for local testing with `docker-compose`.
  Render itself doesn't read this file.
- **`docker-compose.yml`** — build and run the whole thing locally
  (`docker compose up --build`) and hit `/healthz` before pushing to
  Render, so typos cost a local rebuild instead of a Render build-minute.

## 1–6. The core files

- **Dockerfile** — 3-stage build. Stage 1 runs `npm ci --install-links`,
  which installs the local Credential Manager package as a real copy
  inside `node_modules` (not a symlink — the final stage only copies
  `node_modules` across, so a symlink back to `custom-nodes/` would dangle).
  Stage 2 builds the Python venv. Stage 3 is the runtime image: only
  `python3`, `ffmpeg`, `curl`, `ca-certificates`, `tini`, `util-linux` (for
  `flock`) — no compilers. Runs as non-root user `nodered`.
- **entrypoint.sh** — generates `NODE_RED_LOCAL_API_SECRET` (used by the
  Credential Manager's internal token endpoint), seeds `/data/flows.json`
  from the baked-in seed on first boot, clears `/tmp/nr-work`, then execs
  Node-RED **with an explicit `--settings` flag** — see the note below,
  this matters — under `tini`.
- **settings.js** — reads `PORT` from env, puts the editor at `/admin`
  (keeping `/` free for webhooks), optional admin-auth, disables
  diagnostics/runtimeState/metrics/Projects to save RAM.
  `NODE_RED_CREDENTIAL_SECRET` here is the same key that encrypts the
  Credential Manager's OAuth2 tokens — nothing extra to configure for that.
- **package.json** — Node-RED core + `node-red-node-email` (Gmail via
  SMTP/IMAP app password) + `node-red-contrib-cron-plus` (cron
  expressions) + the local `node-red-contrib-credential-manager` package
  (`file:custom-nodes/credential-manager`).
- **.dockerignore** — keeps `node_modules`, any local `/data`, and Python
  caches out of the build context.
- **render.yaml** — Blueprint for one-click Render deploy on the Free
  plan. No Google Client ID/Secret env var — those go through the
  Credential Manager's web UI, never through Render.

> **A bug worth knowing about, since it's easy to reintroduce:** Node-RED's
> default behavior, when started without `--settings`, is to look for
> `settings.js` *inside `--userDir`* (i.e. `/data`), not next to
> `red.js`. Without the explicit `--settings "$NODE_RED_HOME/settings.js"`
> flag, Node-RED silently falls back to its own built-in defaults — your
> `credentialSecret`, `adminAuth`, RAM tuning, everything in this
> `settings.js` gets ignored with no error. `entrypoint.sh` passes the flag
> explicitly; this was verified by actually booting the container.

## 7. Node-RED nodes/packages included

| Package | Why |
|---|---|
| `node-red` | core runtime + built-ins: `http in`/`http response` (webhooks/API), `inject`, `exec` (run Python scripts), `function`, `catch`/`status` (error handling), `delay` (retry backoff) |
| `node-red-node-email` | Gmail via SMTP/IMAP app password — no OAuth needed for this one |
| `node-red-contrib-cron-plus` | full cron-expression scheduling |
| `node-red-contrib-credential-manager` (local) | the Credential Manager — see below |

Google Sheets / Drive / YouTube API / Gmail API calls go through either the
**Google API Request** node (pure Node-RED, see below) or Python
(`scripts/*.py`) using `requests` with a Bearer token fetched from the
Credential Manager — no heavy Google SDK loaded into Node-RED's own
process, and no service account anywhere.

---

## Credential Manager (n8n-style, Google OAuth2 first)

### Where it's built / what changed

| File | Role |
|---|---|
| `custom-nodes/credential-manager/google-oauth2-credentials.js` | **The credential type itself** — a Node-RED *config node*. Registers `google-oauth2-credentials` and all its HTTP routes: `/authorize`, the OAuth `/callback`, `/test`, `/disconnect`, and the internal `/token` endpoint. |
| `custom-nodes/credential-manager/google-oauth2-credentials.html` | Editor UI: Client ID / Client Secret / Scopes form, the Redirect URL to register with Google, and Connect / Test / Disconnect buttons with a live status line. |
| `custom-nodes/credential-manager/google-api-request.js` | **The workflow node** — references a credential by id, fetches (and auto-refreshes) a valid token, makes the HTTP call. |
| `custom-nodes/credential-manager/google-api-request.html` | Editor UI for the worker node — pick a credential from a dropdown, set method/URL. |
| `custom-nodes/credential-manager/lib/oauth2-core.js` | Provider-agnostic OAuth2 logic: build authorize URL, exchange code, refresh token, expiry check. Nothing Google-specific — the extension point for future providers. |
| `custom-nodes/credential-manager/package.json` | Declares this folder as a Node-RED node package (`"node-red": { "nodes": {...} }`), so npm/Node-RED load it like any other node package. |
| `package.json` (root) | Added `node-red-contrib-credential-manager` as a local `file:` dependency. |
| `Dockerfile` | `npm ci --install-links` in the build stage now installs it as a real copy in `node_modules`. |
| `entrypoint.sh` | Removed all `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64` / service-account bridging; added `NODE_RED_LOCAL_API_SECRET` generation; added the `--settings` fix described above. |
| `render.yaml`, `.env.example` | Removed `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64`; added `NODE_RED_LOCAL_API_SECRET`. No Google-related secret is read from Render env vars anymore. |
| `requirements.txt` | Removed `google-api-python-client` / `google-auth` / `gspread` — Python scripts now call Google's REST APIs directly with `requests` + a Bearer token. |
| `scripts/google_token.py` (new) | Fetches a live access token from the Credential Manager's internal endpoint. |
| `scripts/gsheet_append.py` | Rewritten to use `google_token.py` + a plain REST call instead of a service-account key. |

Nothing about the base Node-RED/Render/RAM architecture changed — the
Credential Manager is purely additive, installed as an extra node package
exactly like `node-red-node-email` already was.

### Why a config node instead of a new database

Node-RED already has the exact primitive n8n's Credential Manager is built
on: a **config node** — created once in the editor, reusable by id from any
number of other nodes, and (for fields marked `type: "password"`)
automatically **encrypted at rest** and **redacted from the editor UI** by
Node-RED's own runtime, keyed off `NODE_RED_CREDENTIAL_SECRET`. Building a
second, parallel encrypted store next to that would duplicate what's
already there and add a second place secrets could leak from. So the
Google OAuth2 credential *is* a config node, with its access/refresh
tokens stored as additional `password`-typed fields on that same node —
this is also how Node-RED's own official OAuth-capable community nodes
(Twitter, Trello, etc.) are built.

### Google OAuth2 credential — data structure

```js
RED.nodes.registerType('google-oauth2-credentials', GoogleOAuth2CredentialsNode, {
    credentials: {
        clientId:     { type: 'text' },     // visible in editor (not secret)
        clientSecret: { type: 'password' }, // encrypted; editor only ever sees "is set?"
        accessToken:  { type: 'password' }, // encrypted; never shown, never logged
        refreshToken: { type: 'password' }, // encrypted; never shown, never logged
        tokenExpiry:  { type: 'text' },     // epoch ms; not secret on its own
    },
});
```

Non-secret config (`name`, `scopes`) lives in the node's normal config
object, saved in `flows.json`. Everything above lives in Node-RED's
separate, encrypted credentials store (physically `/data/flows_cred.json`
inside the container), AES-256-encrypted with `NODE_RED_CREDENTIAL_SECRET`.
`clientSecret`/`accessToken`/`refreshToken` are typed `password`, which is
what makes Node-RED (a) encrypt them and (b) never send the real value back
to the browser once saved — the edit dialog only shows a masked
placeholder. Nothing custom was built for either of those two guarantees.

### OAuth callback route

`GET <httpAdminRoot>/credential-manager/google/oauth/callback` →
resolves, with `settings.js`'s `httpAdminRoot: "/admin"`, to:

```
https://<your-render-domain>/admin/credential-manager/google/oauth/callback
```

This is the exact URL to register as an **Authorized redirect URI** in
Google Cloud Console. The route:

1. Reads `code` and `state` (the credential's own Node-RED id) from the
   query string.
2. Looks up that credential's stored `clientId`/`clientSecret` via
   `RED.nodes.getCredentials(id)`.
3. Exchanges the code for tokens via `oauth2-core.js`'s `exchangeCode()`.
4. Saves `accessToken`/`refreshToken`/`tokenExpiry` back onto the same
   credential id with `RED.nodes.addCredentials(id, ...)` — the same
   runtime API Node-RED's own official OAuth-capable nodes use.
5. Renders a small "Connected ✔ — you can close this tab" page.

It does **not** require an editor login, because Google's redirect lands
directly in the user's browser tab (opened from inside the editor), not as
an XHR call carrying Node-RED's session. The `/authorize`, `/test`, and
`/disconnect` routes, by contrast, **do** require an editor session
(`RED.auth.needsPermission(...)`) since those are only ever triggered by
clicks inside the editor.

### Token refresh mechanism

Every consumer of a token — the `google-api-request` worker node and the
internal `/token` endpoint Python scripts call — goes through one shared
function, `ensureValidToken(RED, id, { tokenUrl })` in `lib/oauth2-core.js`:

1. Read the credential's current `accessToken`/`refreshToken`/`tokenExpiry`
   via `RED.nodes.getCredentials(id)`.
2. If `tokenExpiry` is more than 60 seconds away, return the existing
   `accessToken` as-is — no network call.
3. Otherwise, if a `refreshToken` is present, POST it to Google's token
   endpoint (`grant_type=refresh_token`), get back a new `access_token`
   (and sometimes a new `refresh_token` — Google doesn't always return
   one, so the old one is kept when it's absent), and persist the updated
   set with `RED.nodes.addCredentials(id, updated)`.
4. If there's no refresh token (e.g. the user never granted
   `access_type=offline`, or disconnected), throw a clear error asking the
   user to reconnect — nothing silently fails.

This is the single place refresh logic lives; nothing else re-implements
expiry checking or persistence.

### Workflow/node reference pattern

**From a Node-RED flow (native, no Python):** drop a **Google API Request**
node, pick a **Google OAuth2** credential from its dropdown (the same
dropdown Node-RED uses for every other config-node type — MQTT brokers,
TLS configs, etc.), set method + URL (supports `{{msg.property}}`
substitution), wire it up. The node calls `ensureValidToken()` for the
selected credential's id on every input message — the token is never
visible in the flow or in any message.

**From a Python `exec`-node script:** pass the credential's **Node-RED id**
(shown via "Copy Credential ID" in the credential's edit dialog) as a
command-line argument, and call `google_token.get_access_token(id)`, which
hits the same `ensureValidToken()` logic through a loopback-only HTTP
endpoint (see below) — see `scripts/gsheet_append.py` for a complete
example.

**One credential, many consumers:** because it's a normal Node-RED config
node, any number of `google-api-request` nodes across any number of flows
— and any number of Python scripts, by passing the same credential id —
can reference the exact same stored credential. There is exactly one copy
of the tokens; refreshing it in one place is visible everywhere.

### How Python scripts get a token without a service-account file

`custom-nodes/credential-manager/google-oauth2-credentials.js` also
registers:

```
GET /admin/credential-manager/google/:id/token
```

This is the one route **not** gated by editor login (a Python subprocess
has no browser session) — instead it's gated by two independent checks:

1. **The request must come from loopback** (`127.0.0.1`/`::1`) — checked
   via `req.ip`.
2. **A shared secret must match** — `NODE_RED_LOCAL_API_SECRET`, generated
   by `entrypoint.sh` at boot and exported into Node-RED's own
   environment. Every process Node-RED spawns (every `exec` node) inherits
   that environment automatically, so `scripts/google_token.py` can read
   it with zero extra wiring, but nothing outside the container ever sees
   it — it's never sent over the public internet, never in a URL, never in
   `ps aux` output (env vars, unlike argv, aren't visible there either).

`google_token.py` calls this endpoint, gets back a short-lived
`access_token`, and uses it immediately — the token itself is what's
short-lived and scoped, so even if it somehow leaked it stops mattering
within the hour, unlike a service-account key or a refresh token.

### Extending to a new OAuth2 provider later

1. Copy `google-oauth2-credentials.js`/`.html` to
   `<provider>-oauth2-credentials.js`/`.html`, change the registered type
   name, and swap in that provider's `authorizeUrl`/`tokenUrl`/scopes.
2. Reuse `lib/oauth2-core.js` unchanged — `exchangeCode`,
   `refreshAccessToken`, `buildAuthorizeUrl`, and `ensureValidToken` all
   take the provider's URLs as parameters; none of it is Google-specific.
3. Add the new node type to `custom-nodes/credential-manager/package.json`'s
   `"node-red": { "nodes": {...} }` map.
4. Optionally copy `google-api-request.js`/`.html` as a starting point for
   a provider-specific worker node (or write flows against the provider's
   REST API directly, the same way `google-api-request` does for Google).

### Setup checklist

1. Google Cloud Console → **APIs & Services → Credentials** → **Create
   OAuth client ID** → Application type **Web application**. Enable
   whichever Google APIs you need (Sheets/Drive/Gmail/YouTube Data).
2. In the Node-RED editor: hamburger menu → **Configuration nodes** → **+**
   → **google-oauth2-credentials** (or add one from any node's credential
   dropdown → *add new*).
3. Copy the **Redirect URL** shown in the dialog into the Google Cloud
   client's **Authorized redirect URIs** (use your real onrender.com or
   custom domain).
4. Paste in the Client ID/Secret, adjust **Scopes** if needed, click
   **Done**, then click the main **Deploy** button — the credential isn't
   saved server-side until Deploy, so **Connect** won't work until after
   this step.
5. Reopen the credential, click **Connect / Authorize with Google**, sign
   in and consent in the popup tab it opens. Back in the editor, click
   **Test Connection** — the status line should flip to "Connected ✔".
6. Click **Copy Credential ID** and use it either as the `credential`
   dropdown selection on a **Google API Request** node, or as the first
   argument to a Python `exec` node script like `gsheet_append.py`.

## 8. Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | auto (Render sets it) | HTTP port Node-RED binds to |
| `NODE_RED_CREDENTIAL_SECRET` | recommended | Fixed key encrypting all node credentials — including the Credential Manager's Google tokens. Without it, Node-RED generates one at boot, invalidated every redeploy on ephemeral storage. `render.yaml` sets `generateValue: true`. |
| `NODE_RED_USERNAME` / `NODE_RED_PASSWORD_HASH` | strongly recommended | Locks the editor (`/admin`) and admin API behind login. Generate the hash with `node -e "console.log(require('bcryptjs').hashSync('yourpassword', 8))"`. |
| `NODE_RED_LOCAL_API_SECRET` | auto (entrypoint.sh) | Loopback-only shared secret gating the internal `/credential-manager/google/:id/token` endpoint. `render.yaml` pins one with `generateValue: true`; otherwise a fresh one is generated every boot (harmless, since it's regenerated in both Node-RED's and its exec-node children's environment together). |
| `NODE_OPTIONS` | set in Dockerfile/render.yaml | `--max-old-space-size=256` caps V8's heap. |
| `TZ` | optional | Timezone for cron/inject scheduling, e.g. `Asia/Dhaka`. |
| `NODE_RED_LOG_LEVEL` | optional | `info` (default), `debug`, `warn`, etc. |
| `NODE_RED_DISABLE_EDITOR` | optional | Set to `true` once flows are finalized. |

**There is no Google Client ID/Secret env var at all** — those go through
the Credential Manager UI, by design.

## 9. Health check

`flows-seed.json` bakes in a `GET /healthz` route that always returns
`200 OK`, independent of anything else in your flows. `render.yaml` sets
`healthCheckPath: /healthz`. The Dockerfile also adds a local
`HEALTHCHECK` using the same endpoint via `curl`.

## 10. RAM optimization — approximate budget

| Component | Approx. RAM |
|---|---|
| OS + Node.js baseline | ~40–60 MB |
| Node-RED runtime + editor + Credential Manager (bundled + our nodes) | ~90–140 MB |
| `NODE_OPTIONS=--max-old-space-size=256` | hard ceiling on V8 heap |
| Python interpreter (idle) | ~10–15 MB per invocation, short-lived |
| ffmpeg/yt-dlp/edge-tts | only while a job runs, then exits |

Concrete steps taken to stay under 512 MB:

1. **`--max-old-space-size=256`** caps Node's heap, leaving headroom for
   the OS, Python subprocesses, and ffmpeg.
2. **Heavy work lives in short-lived Python subprocesses**, not
   long-running npm packages — a `python3 scripts/xyz.py` call exits and
   frees its memory immediately.
3. **The Credential Manager adds no new runtime dependencies** — it uses
   Node 22's built-in `fetch`, nothing extra installed.
4. **ffmpeg concurrency is hard-capped at 1** via `scripts/ffmpeg_lock.sh`
   (`flock` + `-threads 1`).
5. **Nothing is buffered fully into memory.** yt-dlp/edge-tts write
   straight to `/tmp` (`TMPDIR=/tmp/nr-work`), wiped on every boot.
6. **Diagnostics, runtimeState, metrics, audit logging, and Projects
   (git) are disabled** in `settings.js`.
7. **No `node-red-dashboard`** — common RAM hog, not in requirements.

## 11. Deploying to Render

1. Push this folder to a GitHub/GitLab repo.
2. Render dashboard → **New +** → **Blueprint** → select the repo.
3. Fill in the `sync: false` env vars: `NODE_RED_USERNAME`,
   `NODE_RED_PASSWORD_HASH`. (Google Client ID/Secret are entered later,
   through the Credential Manager in the editor — never here.)
4. Click **Apply**/**Create**. First build takes a few minutes (compiling
   Pillow/lxml wheels). Watch **Logs** — `entrypoint.sh`'s diagnostic
   lines confirm Node/Python/ffmpeg versions once it's up.
5. Visit `https://<your-service>.onrender.com/healthz` → `OK`. Visit
   `/admin` → editor (behind login if you set the auth vars).
6. **Expect spin-down.** Render Free sleeps after ~15 minutes idle; the
   next request cold-starts in ~30–60s. Scheduled/cron flows only fire
   while the instance is awake — treat timing as best-effort on Free, or
   upgrade to Starter ($7/mo, always-on) for reliability.

### Persisting your flows and credentials

Render Free has **no persistent disk**. Anything built in the live editor
lives only in `/data` and is lost on the next redeploy or cold start after
spin-down — **this includes a connected Google credential's tokens**;
you'll need to click Connect again after a redeploy unless you're on a
paid persistent disk. To keep flow changes (not credentials — those can't
be safely committed to git):

```
Node-RED menu (☰) → Export → All flows → Copy to clipboard
→ paste over flows-seed.json in your repo → commit → git push
```

Render auto-deploys on push (`autoDeploy: true`).

## 12. Final validation checklist

- [ ] Repo pushed; `render.yaml` at the path Render expects
- [ ] `NODE_RED_USERNAME` / `NODE_RED_PASSWORD_HASH` set
- [ ] `NODE_RED_CREDENTIAL_SECRET` generated/set — also encrypts Google
      OAuth2 tokens
- [ ] First deploy succeeds; `/healthz` returns `200 OK`
- [ ] `/admin` loads the editor and prompts for login
- [ ] Created a `google-oauth2-credentials` config node, added its
      Redirect URL to Google Cloud Console, pasted in Client ID/Secret,
      clicked Deploy
- [ ] Clicked **Connect / Authorize with Google**, completed consent,
      **Test Connection** shows "Connected ✔"
- [ ] Ran `scripts/gsheet_append.py <credential-id> ...` via an exec node
      and confirmed the row landed in the sheet — or wired up a
      **Google API Request** node instead
- [ ] Tested an `exec` node running `python3 --version` — confirms venv
      PATH is wired correctly
- [ ] Tested one ffmpeg job via `scripts/ffmpeg_lock.sh`
- [ ] Exported the flow and updated `flows-seed.json` in git
- [ ] Comfortable with Free-tier spin-down for time-sensitive cron flows,
      and with reconnecting Google after a redeploy

---

## Example flow snippets

**Google Sheets append (Python path)** — `function` node building the
comma-separated row into `msg.payload` → `exec` node running:
```
python3 scripts/gsheet_append.py <credential-id> <spreadsheet-id> Sheet1 {{payload}}
```

**Google Sheets append (native Node-RED path)** — `function` node setting
`msg.payload = { values: [[...]] }` → **Google API Request** node with
Credential = your Google OAuth2 credential, Method = `POST`, URL =
`https://sheets.googleapis.com/v4/spreadsheets/<id>/values/Sheet1:append?valueInputOption=USER_ENTERED`.

**Edge-TTS → FFmpeg pipeline** — `exec` node running
`python3 scripts/tts_edge.py "{{payload}}"` → `function` node extracts the
printed path from stdout → `exec` node running
`scripts/ffmpeg_lock.sh -y -i <path> -codec:a libmp3lame -qscale:a 4 <out>`
→ read the result with a `file in` node or stream it back via
`http response` → **always** follow with a `function`/`exec` node that
deletes both temp files so `/tmp` doesn't grow.

**Retry with backoff** — `catch` node (scoped to the flow or specific
nodes) → `function` node incrementing `msg.retryCount` and checking a max
(e.g. 3) → `delay` node (fixed or exponential backoff) → wire back into
the retried flow's start → on exceeding max retries, route to
`node-red-node-email` to alert yourself instead of retrying forever.
