# Heiwa DJ

Heiwa DJ is a local macOS AI DJ application with:
- autonomous Strudel code generation
- embedded Strudel playback engine
- live chat + transport controls
- local Ollama model execution (`qwen2.5-coder:7b`)

## Repository

- Repo name: `heiwa-dj`
- License: Apache-2.0

## Runtime Contract

Heiwa DJ is currently pinned to one model only:
- `qwen2.5-coder:7b`

If this model is not installed, the desktop wizard blocks launch and offers one-click install.

## Install

```bash
git clone https://github.com/Strategizing/heiwa-dj.git
cd heiwa-dj
pnpm install
pnpm setup
```

`pnpm setup` pulls `qwen2.5-coder:7b`.

## Desktop App (Wizard + Full Stack)

```bash
pnpm desktop:dev
```

This opens the **Heiwa DJ Setup Wizard**, which verifies:
- macOS runtime
- embedded Node version
- built server/UI assets
- Ollama installation + daemon availability
- `qwen2.5-coder:7b` presence
- DJ ports availability

From the wizard you can:
- run auto setup
- start Ollama
- install `qwen2.5-coder:7b`
- clear occupied ports
- launch Heiwa DJ

Launching starts:
- Heiwa API/UI at `http://localhost:3001`
- embedded engine at `http://localhost:4321/engine`

## Terminal Launcher (Optional)

```bash
pnpm heiwa:start:prod:embedded
```

Stop all ports/processes:

```bash
pnpm heiwa:stop
```

## Build a Distributable macOS Package

```bash
pnpm desktop:build
pnpm heiwa:app:build
```

Artifacts are created under:
- `packages/desktop/release`

`pnpm heiwa:app:build` copies the packaged `.app` into:
- `$HOME/Applications/Heiwa DJ.app` (local machine target)

## Development Validation

```bash
pnpm typecheck
pnpm build
```
