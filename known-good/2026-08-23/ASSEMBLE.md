# Assemble / restore full frozen index.html

The live HTML at freeze time is **170953 bytes** (sha256 `5b52fad084ae5ae4509f40431caf3cafd85f0fa5309479b7e601b1096ae02124`).

`index.html` on this branch is a **pointer** (MCP single-call payload limit prevented inlining the full document from the executor agent).

## Restore to Cloudflare
1. Obtain the freeze snapshot file with that sha256 (agent workspace: `/workspace/jaerichent-known-good-2026-08-23/index.html`, or re-download `https://jaerichent.com/` only if still unchanged).
2. Verify: `sha256sum index.html` → must match above.
3. Redeploy that file to Cloudflare Pages/Workers static. **Do not** deploy from GitHub `main`.

## Also on this branch
- `MANIFEST.md`, `headers.txt`, `favicon.svg`
- tip-qr.jpg intentionally omitted (binary)
