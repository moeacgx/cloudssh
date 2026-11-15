# MCP Binary File Transfers Implementation Plan

**Goal:** Resolve Issue #57 with binary-safe MCP upload/download tools, capped at 64 MiB per file.

**Architecture:** Transfer at most 256 KiB per Base64 chunk, below the existing 1 MiB JSON limit. A bounded, expiring server-side temporary-file manager stages uploads and snapshots downloads; existing AgentFileService performs SFTP and upload idempotency. HTTP MCP never reads or writes client-local paths. Download consumers assemble chunks and use exclusive local creation by default.

**Tech Stack:** TypeScript, Node filesystem/streams/crypto, existing MCP SDK/Zod/Vitest.

## Approved design and contract

- `cloudssh_files_upload`: serverId, path, request_id, size, sha256, offset, dataBase64, finalize. Contiguous chunks; identical retries accepted, conflicting bytes/metadata rejected. Only finalize after complete SHA-256 verification calls SFTP upload with the original request_id.
- `cloudssh_files_download`: serverId, path, optional transferId, offset and length. First call snapshots the bounded SFTP stream; subsequent calls read the immutable snapshot and return Base64, total size, SHA-256, nextOffset and eof. No silent truncation.
- Transfers bind to key, project, host and path, expire after ten idle minutes, and have per-key/global capacity limits. Staging files use private temporary directories and are removed on expiry or shutdown. No bodies, paths or hashes are added to invocation history.

## Execution

1. Add failing real-SDK discovery/binary roundtrip tests in `src/backend/agent/mcp.test.ts` and transfer edge-case tests in `src/backend/agent/mcp-files.test.ts`.
2. Implement `src/backend/agent/mcp-files.ts`: bounded disk staging, canonical Base64 validation, serialized per-transfer mutation, checksums, retry/conflict handling, ownership, expiry and cleanup.
3. Wire two tools in `src/backend/agent/mcp-tools.ts`, persistent manager in `src/backend/agent/index.ts`, and router fallback for embedded consumers. Preserve metadata-only fail-closed audit.
4. Run Node 24 Vitest for MCP/files/admin, backend TypeScript, focused ESLint/Prettier, and build. Document client assembly/exclusive-save and process-restart retry behavior.

Existing unrelated owner-attribution edits in the worktree are preserved. No commit, PR, merge or deployment is part of this implementation authorization.
