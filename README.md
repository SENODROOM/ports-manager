# 🚦 Ports Manager

<p align="center">
  <strong>Launch your frontend and backend together — on free ports, without CORS headaches.</strong>
</p>

<p align="center">
  <img alt="Node.js 18+" src="https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white">
  <img alt="License MIT" src="https://img.shields.io/badge/license-MIT-blue">
  <img alt="VS Code" src="https://img.shields.io/badge/VS%20Code-supported-007ACC?logo=visualstudiocode">
  <img alt="Cursor" src="https://img.shields.io/badge/Cursor-supported-black">
</p>

---

## Why Ports Manager?

Local frontend/backend development should not require manually checking ports, editing `.env`
files, fixing CORS, and juggling multiple terminals.

Run one command from your project root:

```bash
npx ports-manager
```

Ports Manager will:

- 🔎 Detect your `frontend` + `backend` or `client` + `server`
- 🛬 Find separate free ports while always avoiding `3000` and `5000`
- ⚛️ Configure CRA, Vite, or Next.js automatically
- 🟢 Start Express, Koa, Fastify, NestJS, or generic Node backends
- 🔗 Provide the backend URL to the frontend at runtime
- 🛡️ Handle development CORS without changing application source
- 🧹 Stop both process trees cleanly when you press `Ctrl+C`
- 🖥️ Optionally open each app in its own VS Code/Cursor terminal

No application source files are rewritten.

## Install once, run anywhere

Install Ports Manager globally:

```bash
npm install --global ports-manager
```

Then open any supported project folder and run:

```bash
cd my-project
ports-manager
```

💥 **Boom — both apps launch on free ports.**

Prefer not to install globally? Use it directly with:

```bash
npx ports-manager
```

## Quick start

Your project should look like one of these:

```text
my-project/
├── frontend/        # or client/
│   └── package.json
└── backend/         # or server/
    └── package.json
```

Run Ports Manager from `my-project`, not from inside either child:

```bash
cd my-project
ports-manager
```

Example output:

```text
Backend:  express / npm run dev / 4000
Frontend: vite / npm run dev / 4001
CORS shim: enabled
```

Ports Manager prefers `npm run dev`, then falls back to `npm start`.

## Common recipes

### Preview without starting anything

```bash
npx ports-manager --dry-run
```

### Use custom folder names

```bash
npx ports-manager \
  --frontend-dir apps/web \
  --backend-dir apps/api
```

### Choose a port range and ban extra ports

```bash
npx ports-manager --range 4100-4900 --ban 4200,4300
```

### Wait for the backend before starting the frontend

```bash
npx ports-manager --wait-for-backend
```

### Use a same-origin development proxy

```bash
npx ports-manager --proxy --api-prefix /api
```

### Open separate VS Code/Cursor terminals

From an integrated terminal:

```bash
npx ports-manager --ide-terminals
```

`auto` mode uses the Ports Manager extension bridge when available. Otherwise, it
creates dedicated VS Code tasks. Launch generated tasks through:

```text
Ctrl/Cmd+Shift+P → Tasks: Run Task → Ports Manager: Run All
```

To generate a shortcut reference:

```bash
npx ports-manager --ide-terminals=tasks --with-keybinding
```

VS Code does not apply workspace keybindings automatically. Copy the generated
entry from `.vscode/ports-manager-keybindings.json` into **Keyboard Shortcuts
(JSON)**.

## Supported stacks

| Role | Supported detection | Port strategy |
|---|---|---|
| Frontend | Create React App | `PORT` environment variable |
| Frontend | Vite | `--port` + `--strictPort` |
| Frontend | Next.js | `-p` argument |
| Backend | Express, Koa, Fastify | `PORT` environment variable |
| Backend | NestJS | `PORT` environment variable, best effort |
| Either | Generic Node project | `PORT`, with a compatibility warning |

The backend must read `process.env.PORT`. Ports Manager warns when its static scan
cannot find that behavior or detects a possible literal `.listen(5000)`.

## CORS and API URLs

The development CORS shim is enabled by default. It is injected into the
backend through `NODE_OPTIONS` and:

- reflects the browser's `Origin`
- supports credentials
- handles `OPTIONS` preflight with `204`
- preserves the existing `Vary` header

If Ports Manager detects existing CORS middleware, it skips the shim. Override or
disable that behavior with:

```bash
npx ports-manager --force-cors
npx ports-manager --no-cors-shim
```

Framework-specific API variables are supplied automatically:

- CRA: `REACT_APP_API_URL`
- Vite: `VITE_API_URL`
- Next.js: `NEXT_PUBLIC_API_URL`

> [!WARNING]
> The CORS shim is intentionally permissive and intended only for local
> development. It is not a production security policy.

## Configuration

Create `ports-manager.config.json` in the project root:

```json
{
  "pairs": [
    ["frontend", "backend"],
    ["client", "server"]
  ],
  "portRange": [4000, 4999],
  "bannedPorts": [3000, 5000],
  "apiPrefix": "/api",
  "cors": {
    "mode": "shim",
    "credentials": true
  },
  "proxy": {
    "enabled": false
  },
  "ideTerminals": {
    "mode": "off",
    "withKeybinding": false
  },
  "env": {
    "frontend": {
      "CUSTOM_API_URL": "http://127.0.0.1:{backendPort}"
    }
  }
}
```

Environment values can use `{frontendPort}`, `{backendPort}`, `{proxyPort}`,
and `{apiPrefix}` placeholders. CLI flags override configuration values.

## CLI reference

```text
--frontend-dir PATH       Override frontend directory
--backend-dir PATH        Override backend directory
--frontend-port PORT      Request a specific frontend port
--backend-port PORT       Request a specific backend port
--proxy-port PORT         Request a specific proxy port
--range MIN-MAX           Port search range
--ban PORTS               Comma-separated banned ports
--no-cors-shim            Disable the development CORS shim
--force-cors              Override detected CORS middleware
--proxy                   Enable the same-origin proxy
--api-prefix PATH         Backend proxy prefix
--wait-for-backend[=MS]   Wait for the backend to listen
--ide-terminals[=MODE]    auto, off, tasks, or extension
--with-keybinding         Generate a shortcut reference
--config PATH             Use an explicit configuration file
--dry-run                 Print the plan without writing or starting
--stop                    Stop bridge-managed workspace terminals
--version, -v             Show version and author
--help, -h                Show all options
```

Run `npx ports-manager --help` for the canonical list.

## VS Code/Cursor extension

This repository is one package that produces both the npm CLI and an optional
VSIX:

```bash
npm install
npm run package:vsix
```

Install `ports-manager-1.0.0.vsix` in VS Code or Cursor. The bridge listens
only on `127.0.0.1`, requires a random bearer token, validates request data,
and tracks terminals by workspace.

Stop managed terminals with:

```bash
npx ports-manager --stop
```

or run **Ports Manager: Stop All Managed Terminals** from the command palette.

## Limitations

- Port checks cannot reserve a port until the framework binds to it.
- Framework, CORS, and hardcoded-port scans are heuristic.
- Backends that ignore `process.env.PORT` cannot be redirected without code changes.
- IDE task mode needs one manual task launch unless the extension bridge is installed.
- Workspaces/monorepos and non-VS-Code-family IDEs are not currently supported.

## Development

```bash
npm install
npm test
npm run test:cli
npm run test:bridge
npm run package:vsix
```

---

<p align="center">
  Built by <strong>Muhammad Saad Amin</strong> — <strong>SENODROOM</strong><br>
  Released under the MIT License.
</p>
