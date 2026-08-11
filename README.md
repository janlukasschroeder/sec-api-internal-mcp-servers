# SEC-API Internal MCP Servers

- MCP server to fetch URLs with cloakbrowser
- Returns HTML and html-to-text

## Tools

| Tool                  | Returns                                             |
| --------------------- | --------------------------------------------------- |
| `get-website-as-html` | the page HTML, with the HTML of all iframes inlined |
| `get-website-as-text` | the same page as plain text, tables as ASCII tables |

Both tools take:

| Input        | Default | Use                                                 |
| ------------ | ------- | --------------------------------------------------- |
| `websiteUrl` | —       | the page to fetch                                   |
| `timeoutMs`  | 15000   | how long `page.goto` waits for the network to idle  |
| `useProxy`   | `false` | `true` sends the request through the SOCKS5 proxies |

## Run in Docker (recommended)

The container holds everything: node, Xvfb and the Chromium of cloakbrowser.
Nothing opens a window on your desktop.

```bash
docker compose up -d --build
docker compose logs -f
```

The server then listens on `http://127.0.0.1:22001/mcp`.

What the container gets:

- 10 Xvfb displays, `:99` to `:108`, one per proxy, started by
  `docker-entrypoint.sh`
- the MS core fonts, the Liberation fonts and Segoe UI. Chromium draws a box
  glyph for each missing font, and that breaks the canvas fingerprint
- `./modules`, `./config` and `.env` as read-only mounts, thus a code change
  needs a restart but no rebuild
- `~/.secdotenv` as a read-only mount, because secdotenv needs that key to
  decrypt `.env`
- `./output` as a writable mount for the page cache

A code change needs `docker compose restart`. A change of `package.json`, the
`Dockerfile` or `docker-entrypoint.sh` needs `docker compose up -d --build`.

### Proxies

`useProxy: true` sends the request through the SOCKS5 proxies on the Tailscale
host. This works from the container, because Docker Desktop routes the TCP
connection through the host, and the host holds the Tailscale route.

```
useProxy: false → your own line
useProxy: true  → the proxy pool
```

## Run on the host

Three entry points, all with the same tools:

```bash
# http, for Claude Code
node modules/server-browser.js

# stdio, for an app that spawns the server as a local process
node modules/server-browser-stdio.js

# stdio in, http out: a bridge to the server in docker, for Claude Desktop
node worker/mcp-stdio-to-http.js
```

On macOS the browser window comes up on your desktop and takes the focus. macOS
has no X server, and macOS clamps a window position into the area of the
attached displays, thus the window cannot hide. Use Docker instead.

## Connect a client

### Claude Code

Add `.mcp.json` to the project root:

```json
{
  "mcpServers": {
    "browser-mcp": {
      "type": "http",
      "url": "http://127.0.0.1:22001/mcp"
    }
  }
}
```

Or add it from the command line:

```bash
claude mcp add --transport http browser-mcp http://127.0.0.1:22001/mcp
```

Run `/mcp` to confirm the server. Restart the session if it does not show.

### Claude Desktop and Cowork

Do not use a custom connector. Claude dials a connector from the cloud, thus it
needs a public HTTPS URL and cannot reach your machine. The dialog rejects
`http://127.0.0.1`.

Edit the config file instead, with the app closed, because the app writes that
file on exit:

```bash
open -e "$HOME/Library/Application Support/Claude/claude_desktop_config.json"
```

An HTTP entry does not work either. A `type: http` url in this file gives no
server in the app, thus the config takes a local process only.

Use `worker/mcp-stdio-to-http.js`. The app spawns that worker, and the worker
sends each message to the HTTP server of the container:

```json
"mcpServers": {
  "browser-mcp": {
    "command": "/Users/jan/.nvm/versions/node/v24.12.0/bin/node",
    "args": ["/absolute/path/to/worker/mcp-stdio-to-http.js"]
  }
}
```

Use the full path of your node binary, because the app does not load your shell
profile. `MCP_HTTP_URL` points the worker at another endpoint, and the default
is `http://127.0.0.1:22001/mcp`.

The container must run for this:

```bash
docker compose up -d
```

The worker keeps the browser pool of the container warm, because every request
lands in the same server. A code change then needs `docker compose restart`
only, and no restart of the app.

Two other ways, both without the worker:

```json
// the stdio server inside the container. one browser start per tool call.
"command": "/usr/local/bin/docker",
"args": ["exec", "-i", "browser-mcp", "node", "modules/server-browser-stdio.js"]

// the stdio server on the host. a browser window opens on your desktop.
"command": "/Users/jan/.nvm/versions/node/v24.12.0/bin/node",
"args": ["/absolute/path/to/modules/server-browser-stdio.js"]
```

Restart the app after a config change. The app spawns the process at start and
never reloads it.

## Notes

- The page cache goes to `output/cache/<date>/`, as `.html` and as `.txt`.
- `cloakbrowser info` reports the state of the browser and of the fonts:
  ```bash
  docker compose exec browser-mcp node node_modules/cloakbrowser/dist/cli.js info
  ```
  `Win fonts` reads 3/8. Calibri, Consolas, Marlett, MS UI Gothic and Franklin
  Gothic are licensed Microsoft fonts, and no package ships them. Copy them from
  a Windows machine to get the full set.
- The free cloakbrowser license covers one session at a time. The factory opens
  one browser per proxy, thus `useProxy: true` with many proxies needs a key.
