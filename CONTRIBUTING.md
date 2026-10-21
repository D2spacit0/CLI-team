# Contributing

## Requirements

- Node.js 24 or newer
- Windows for desktop packaging and Electron smoke tests
- Official CLI clients must be installed and authenticated separately

## Local checks

Run these before opening a pull request:

```powershell
npm ci
npm test
npm run check
npm run build
```

Use `npm run smoke:desktop -- --usability-smoke` for a focused desktop workflow
check. Each desktop scenario runs in a fresh `work/desktop-smoke/run-*`
workspace and does not require paid model calls.

## Repository boundaries

- Keep runtime state in `.team/`, task files in `workspaces/`, and temporary
  evidence in `work/`. These paths must not be committed.
- Do not commit credentials, client authentication files, databases, logs, or
  packaged desktop output.
- Keep the service bound to loopback.
- Do not enable permission-bypass flags or execute arbitrary shell strings.
- Treat agent output as untrusted. Machine evidence and agent claims remain
  separate, and a successful CLI exit code is not acceptance.

## Change scope

Keep changes focused, preserve existing user work, and update tests or
documentation when behavior changes. The UI is a Chinese-language operational
workbench; preserve that language and its established visual system.
