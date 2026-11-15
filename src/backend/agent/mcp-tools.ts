import { z } from "zod";
import type { AgentRouterDependencies } from "./routes.js";
import type { AgentPrincipal, AgentScope } from "./types.js";
import { AgentApiError } from "./errors.js";

export type McpServices = Pick<
  AgentRouterDependencies,
  "servers" | "sessions" | "jobs" | "files"
>;
const id = z.string().trim().min(1).max(128);
const path = z.string().min(1).max(4096);
const write = {
  request_id: id.describe(
    "Unique retry identifier; reuse with exactly the same arguments",
  ),
};
const server = { serverId: id };
const session = { sessionId: id };
const file = { ...server, path };
interface McpOperationObserver {
  onCommitted?: () => void;
}

export function createMcpTools(
  services: McpServices,
  principal: AgentPrincipal,
) {
  const files = () => {
    if (!services.files)
      throw new AgentApiError(
        503,
        "FILE_SERVICE_UNAVAILABLE",
        "File service unavailable",
      );
    return services.files;
  };
  function tool<S extends z.ZodRawShape>(
    name: string,
    description: string,
    scope: AgentScope | null,
    shape: S,
    run: (
      args: z.output<z.ZodObject<S>>,
      observer: McpOperationObserver,
    ) => Promise<unknown>,
    mutating = false,
  ) {
    const schema = z.object(shape).strict();
    return {
      name,
      description,
      scope,
      mutating,
      schema,
      resolveProjectId: async (args: unknown): Promise<string | null> => {
        const target = schema.parse(args) as Record<string, unknown>;
        if (typeof target.sessionId === "string") {
          return (
            await services.sessions.resolveAuthorizedAuditContext(
              principal,
              target.sessionId,
            )
          ).projectId;
        }
        if (typeof target.jobId === "string") {
          return (await services.jobs.status(principal, target.jobId))
            .projectId;
        }
        if (typeof target.serverId === "string") {
          if (
            !principal.serverIds.includes("*") &&
            !principal.serverIds.includes(target.serverId)
          )
            throw new AgentApiError(403, "SERVER_DENIED", "无权访问此服务器");
          const projectId =
            principal.serverProjectIds?.[target.serverId] ??
            principal.projectId;
          if (
            !(principal.projectIds ?? [principal.projectId]).includes(projectId)
          )
            throw new AgentApiError(403, "SERVER_DENIED", "无权访问此服务器");
          return projectId;
        }
        return null;
      },
      execute: async (args: unknown, observer: McpOperationObserver = {}) => {
        if (scope && !principal.scopes.includes(scope))
          throw new AgentApiError(
            403,
            "SCOPE_DENIED",
            `Missing scope: ${scope}`,
          );
        return run(schema.parse(args), observer);
      },
    };
  }
  return [
    tool(
      "cloudssh_context",
      "Call first: current service, authorized projects, scopes and execution rules.",
      null,
      {},
      async () => ({
        service: "CloudSSH",
        projectIds: principal.projectIds ?? [principal.projectId],
        scopes: principal.scopes,
        rules: [
          "Writes require request_id; retry with the same ID and arguments.",
          "Commands are asynchronous: poll cloudssh_jobs_status for exit code and output.",
          "Never request existing SSH credentials. Audit stores metadata only.",
        ],
      }),
    ),
    tool(
      "cloudssh_servers_list",
      "List authorized hosts without credentials.",
      null,
      {},
      async () => ({ servers: await services.servers.list(principal) }),
    ),
    tool(
      "cloudssh_jobs_execute",
      "Execute a remote command asynchronously; poll the returned job ID.",
      "jobs:execute",
      {
        ...server,
        ...write,
        command: z.string().trim().min(1).max(65536),
        timeoutMs: z.number().int().min(1000).max(900000).default(30000),
      },
      async (a) => ({
        job: await services.jobs.create(principal, a, a.request_id),
      }),
      true,
    ),
    tool(
      "cloudssh_jobs_list",
      "List this key's command jobs.",
      "jobs:execute",
      {},
      async () => ({ jobs: await services.jobs.list(principal) }),
    ),
    tool(
      "cloudssh_jobs_status",
      "Get command state, stdout, stderr and exit code.",
      "jobs:execute",
      { jobId: id },
      async (a) => ({ job: await services.jobs.status(principal, a.jobId) }),
    ),
    tool(
      "cloudssh_jobs_cancel",
      "Cancel a command job.",
      "jobs:execute",
      { jobId: id, ...write },
      async (a) => ({ job: await services.jobs.cancel(principal, a.jobId) }),
      true,
    ),
    tool(
      "cloudssh_sessions_create",
      "Create a persistent SSH session.",
      "sessions:create",
      {
        ...server,
        ...write,
        cols: z.number().int().min(20).max(500).default(120),
        rows: z.number().int().min(5).max(300).default(30),
        pinned: z.boolean().default(false),
        runtimeMode: z.enum(["platform", "tmux"]).optional(),
      },
      async (a) => ({
        session: await services.sessions.create(principal, a, a.request_id),
      }),
      true,
    ),
    tool(
      "cloudssh_sessions_list",
      "List accessible persistent sessions.",
      "sessions:read",
      {},
      async () => ({ sessions: await services.sessions.list(principal) }),
    ),
    tool(
      "cloudssh_sessions_status",
      "Get persistent session status.",
      "sessions:read",
      session,
      async (a) => ({
        session: await services.sessions.status(principal, a.sessionId),
      }),
    ),
    tool(
      "cloudssh_sessions_attach",
      "Attach to a session; read-write returns a lease required for input.",
      "sessions:read",
      {
        ...session,
        ...write,
        mode: z.enum(["read-only", "read-write"]).default("read-only"),
        takeover: z.boolean().default(false),
      },
      async (a) =>
        services.sessions.attach(
          principal,
          a.sessionId,
          a.mode,
          a.takeover,
          a.request_id,
        ),
      true,
    ),
    tool(
      "cloudssh_sessions_read",
      "Read terminal output using the returned cursor for subsequent reads.",
      "sessions:read",
      {
        ...session,
        cursor: z.string().max(1024).optional(),
        limitBytes: z.number().int().min(1).max(262144).optional(),
        attachmentId: id.optional(),
      },
      async (a) =>
        services.sessions.read(
          principal,
          a.sessionId,
          a.cursor,
          a.limitBytes,
          a.attachmentId,
        ),
    ),
    tool(
      "cloudssh_sessions_write",
      "Send terminal input using the attachment and write lease.",
      "sessions:write",
      {
        ...session,
        ...write,
        attachmentId: id,
        leaseId: id,
        data: z.string().min(1).max(65536),
      },
      async (a) =>
        services.sessions.write(
          principal,
          a.sessionId,
          a.attachmentId,
          a.leaseId,
          a.data,
          a.request_id,
        ),
      true,
    ),
    tool(
      "cloudssh_sessions_close",
      "Close a persistent session.",
      "sessions:close",
      { ...session, ...write },
      async (a) => ({
        session: await services.sessions.close(principal, a.sessionId),
      }),
      true,
    ),
    tool(
      "cloudssh_files_list",
      "List a remote directory.",
      "files:read",
      { ...server, path: path.default(".") },
      async (a) => files().list(principal, a.serverId, a.path),
    ),
    tool(
      "cloudssh_files_read",
      "Read a bounded UTF-8 remote file; inspect truncated in the result.",
      "files:read",
      file,
      async (a) => files().read(principal, a.serverId, a.path),
    ),
    tool(
      "cloudssh_files_mkdir",
      "Create a remote directory.",
      "files:write",
      { ...file, ...write, recursive: z.boolean().default(false) },
      async (a, observer) =>
        files().mkdir(
          principal,
          a.serverId,
          a.path,
          a.recursive,
          a.request_id,
          undefined,
          observer.onCommitted,
        ),
      true,
    ),
    tool(
      "cloudssh_files_rename",
      "Move or rename a remote file.",
      "files:write",
      { ...server, ...write, sourcePath: path, destinationPath: path },
      async (a, observer) =>
        files().rename(
          principal,
          a.serverId,
          a.sourcePath,
          a.destinationPath,
          a.request_id,
          undefined,
          observer.onCommitted,
        ),
      true,
    ),
    tool(
      "cloudssh_files_delete",
      "Delete a remote file or directory. Destructive operation.",
      "files:write",
      { ...file, ...write, recursive: z.boolean().default(false) },
      async (a, observer) =>
        files().delete(
          principal,
          a.serverId,
          a.path,
          a.recursive,
          a.request_id,
          undefined,
          observer.onCommitted,
        ),
      true,
    ),
  ];
}

export function mcpToolCatalog(
  services: McpServices,
  principal: AgentPrincipal,
) {
  return createMcpTools(services, principal).map(
    ({ name, description, scope, mutating, schema }) => ({
      name,
      description,
      scope,
      mutating,
      inputSchema: z.toJSONSchema(schema, { io: "input" }),
    }),
  );
}
