import type Database from "better-sqlite3";
import { AgentApiError } from "./errors.js";
import type { AgentPrincipal, AgentScope } from "./types.js";

const SERVER_DISCOVERY_SCOPES = new Set<AgentScope>([
  "sessions:create",
  "sessions:read",
  "sessions:write",
  "jobs:execute",
  "servers:create",
  "quick-connections:create",
  "files:read",
  "files:write",
]);

function requireServerDiscoveryScope(principal: AgentPrincipal): void {
  if (principal.scopes.some((scope) => SERVER_DISCOVERY_SCOPES.has(scope))) {
    return;
  }
  throw new AgentApiError(
    403,
    "SCOPE_DENIED",
    "当前设备没有读取服务器列表所需的权限",
  );
}

export interface AgentServerSummary {
  /** 跨项目稳定的主机资产 ID；同一主机的不同项目入口共享此值。 */
  hostId: number;
  /** 项目级访问入口 ID；执行命令、会话和文件操作时使用此值。 */
  serverId: string;
  name: string;
  connectionType: string;
  projectId?: string;
  projectName?: string;
  /** 仅返回连接定位信息，不返回用户名或任何认证材料。 */
  address?: string;
  port?: number;
  folder?: string | null;
  tags?: string[];
}

export interface AgentServerDirectory {
  list(principal: AgentPrincipal): Promise<AgentServerSummary[]>;
}

export class MemoryAgentServerDirectory implements AgentServerDirectory {
  constructor(private readonly servers: AgentServerSummary[] = []) {}

  async list(principal: AgentPrincipal): Promise<AgentServerSummary[]> {
    requireServerDiscoveryScope(principal);
    const allowed = new Set(principal.serverIds);
    return this.servers.filter((server) => allowed.has(server.serverId));
  }
}

export class SqliteAgentServerDirectory implements AgentServerDirectory {
  constructor(private readonly sqlite: Database.Database) {}

  async list(principal: AgentPrincipal): Promise<AgentServerSummary[]> {
    requireServerDiscoveryScope(principal);
    if (principal.serverIds.length === 0) return [];
    const placeholders = principal.serverIds.map(() => "?").join(", ");
    // 老版本迁移数据库和单元测试夹具可能没有新增的 port/folder/tags
    // 列。动态选择列可保持升级过程平滑，同时在完整 schema 中返回 Agent
    // 需要的连接定位信息。
    const tableColumns = (table: string): Set<string> =>
      new Set(
        (
          this.sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{
            name?: string;
          }>
        ).map((row) => row.name ?? ""),
      );
    const hostColumns = tableColumns("ssh_data");
    const projectHostColumns = tableColumns("project_hosts");
    const addressExpression = hostColumns.has("ip") ? "host.ip" : "NULL";
    const portExpression = hostColumns.has("port") ? "host.port" : "NULL";
    const folderExpression = projectHostColumns.has("folder")
      ? "project_host.folder"
      : "NULL";
    const tagsExpression = hostColumns.has("tags") ? "host.tags" : "NULL";
    const rows = this.sqlite
      .prepare(
        `SELECT CAST(project_host.id AS TEXT) AS serverId,
                project_host.host_id AS hostId,
                COALESCE(NULLIF(TRIM(project_host.alias), ''),
                         NULLIF(TRIM(host.name), ''),
                         'Server ' || project_host.id) AS name,
                host.connection_type AS connectionType,
                project_host.project_id AS projectId,
                project.name AS projectName,
                ${addressExpression} AS address,
                ${portExpression} AS port,
                ${folderExpression} AS folder,
                ${tagsExpression} AS rawTags
           FROM project_hosts project_host
           JOIN ssh_data host ON host.id = project_host.host_id
           JOIN projects project ON project.id = project_host.project_id
          WHERE CAST(project_host.id AS TEXT) IN (${placeholders})
          ORDER BY project.name, name, project_host.id`,
      )
      .all(...principal.serverIds) as Array<
      AgentServerSummary & { rawTags?: string | null }
    >;
    return rows.map((row) => {
      const result: AgentServerSummary = {
        hostId: Number(row.hostId),
        serverId: row.serverId,
        name: row.name,
        connectionType: row.connectionType,
        projectId: row.projectId,
        projectName: row.projectName,
      };
      // 仅在完整连接定位字段可用时暴露 address；旧迁移夹具没有 port，
      // 此时继续返回兼容的元数据集合，避免把半截连接信息误当可用主机。
      if (
        hostColumns.has("port") &&
        row.address !== null &&
        row.address !== undefined
      )
        result.address = row.address;
      if (row.port !== null && row.port !== undefined)
        result.port = Number(row.port);
      if (row.folder !== null && row.folder !== undefined)
        result.folder = row.folder;
      else if (projectHostColumns.has("folder")) result.folder = null;
      if (row.rawTags !== null && row.rawTags !== undefined) {
        result.tags = String(row.rawTags)
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean);
      } else if (hostColumns.has("tags")) {
        result.tags = [];
      }
      return result;
    });
  }
}
