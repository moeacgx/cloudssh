# CloudSSH HTTP MCP

## Approved design

Expose authenticated Streamable HTTP MCP at `/agent/mcp`, alongside the existing device-signed Agent API. Reuse the job manager, session broker, server directory and file service; do not introduce another SSH execution engine. Bearer keys use the existing hashed token store and current project authorization.

Provide an MCP management view with four tabs: connection instructions (Cursor/Codex, environment-variable configuration, copy address/instructions), tool reference (schemas, permissions and examples), keys (project selection, scopes, expiry, concurrency, one-time secret display and revoke), and paginated invocation history (tool, key, project, status, duration). Keep device integration available.

Tools cover context, host discovery, asynchronous command jobs, persistent sessions and remote file listing/reading/mkdir/rename/delete. Each mutating invocation requires request_id; operations with existing idempotency support reuse it. Audit only bounded metadata, never arguments, output, credentials or raw keys. Validate arguments before invoking services. Reauthorize every HTTP request. Public production access requires HTTPS; reject cross-origin browser requests.

Use the official MCP SDK for protocol negotiation and transport. Add meaningful protocol/client integration tests, permission tests, invocation-history isolation tests, and management UI tests. Preserve existing uncommitted work. Node >=22.12.0. No commit or deployment is requested.
