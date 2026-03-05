# Contributing to Heiwa DJ

Thanks for contributing to `heiwa-dj`.

## Development Setup

```bash
git clone https://github.com/<YOUR_ORG_OR_USER>/heiwa-dj.git
cd heiwa-dj
pnpm install
pnpm setup
```

## Verify Before PR

```bash
pnpm typecheck
pnpm build
```

## Pull Requests

- Keep changes focused and minimal.
- Include a clear summary and testing notes.
- Do not commit generated artifacts (for example `dist`, `release`, `node_modules`, logs).
