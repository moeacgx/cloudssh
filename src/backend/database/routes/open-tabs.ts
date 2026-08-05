import type { AuthenticatedRequest } from "../../../types/index.js";
import express from "express";
import type { Request, Response } from "express";
import { databaseLogger } from "../../utils/logger.js";
import { AuthManager } from "../../utils/auth-manager.js";
import {
  sessionManager,
  TerminalSessionTransitionError,
} from "../../hosts/terminal/session-manager.js";
import { getRequestMeta, logAudit } from "../../utils/audit-logger.js";
import { PermissionManager } from "../../utils/permission-manager.js";
import {
  getCurrentSettingValue,
  createCurrentOpenTabRepository,
  createCurrentSessionShareRepository,
  createCurrentWebTerminalSessionRepository,
  getCurrentRepositorySqlite,
} from "../repositories/factory.js";

const router = express.Router();
const authManager = AuthManager.getInstance();
const authenticateJWT = authManager.createAuthMiddleware();

type VisibleAgentSessionRow = {
  id: string;
  projectId: string;
  projectHostId: number;
  hostId: number;
  hostName: string;
  alias: string | null;
  state: string;
  title: string | null;
  pinned: number;
  runtimeMode: string;
  serviceAccountId: string | null;
  agentActorName: string | null;
  createdAt: string;
  updatedAt: string;
  /** Agent 状态存储把该数据库列作为无人附着时间使用。 */
  lastDetachedAt: string | null;
  retainUntil: string | null;
};

/**
 * 返回当前用户有权连接的 Agent 持续会话。
 *
 * Agent 会话不属于 open_tabs，也不能伪装成普通网页会话；这里使用
 * 独立的来源标记，前端只有从“最近/连接”入口发起附着时才会带上它。
 */
async function listVisibleAgentSessions(
  userId: string,
  permissionManager: PermissionManager,
): Promise<VisibleAgentSessionRow[]> {
  try {
    const rows = getCurrentRepositorySqlite()
      .prepare(
        `SELECT
           session.id,
           session.project_id AS projectId,
           session.project_host_id AS projectHostId,
           project_host.host_id AS hostId,
           COALESCE(host.name, host.ip, '未命名主机') AS hostName,
           project_host.alias AS alias,
           session.state,
           session.title,
           session.pinned,
           session.runtime_mode AS runtimeMode,
           session.service_account_id AS serviceAccountId,
           COALESCE(
             agent_device.name,
             legacy_token.name,
             service_account.name
           ) AS agentActorName,
           session.created_at AS createdAt,
           session.updated_at AS updatedAt,
           -- Agent 状态同步时复用 last_attached_at 记录最近脱离时间，
           -- 对外保持网页连接列表原有字段名。
           session.last_attached_at AS lastDetachedAt,
           session.retain_until AS retainUntil
         FROM persistent_sessions session
         INNER JOIN project_hosts project_host
           ON project_host.project_id = session.project_id
          AND project_host.id = session.project_host_id
         INNER JOIN ssh_data host ON host.id = project_host.host_id
         INNER JOIN service_accounts service_account
           ON service_account.project_id = session.project_id
          AND service_account.id = session.service_account_id
          AND service_account.is_active = 1
         LEFT JOIN agent_device_projects device_grant
           ON device_grant.project_id = session.project_id
          AND device_grant.service_account_id = session.service_account_id
         LEFT JOIN agent_devices agent_device
           ON agent_device.id = device_grant.device_id
          AND agent_device.status = 'active'
         LEFT JOIN agent_token_projects token_grant
           ON token_grant.project_id = session.project_id
          AND token_grant.service_account_id = session.service_account_id
         LEFT JOIN agent_access_tokens legacy_token
           ON legacy_token.id = token_grant.token_id
         WHERE session.service_account_id IS NOT NULL
           AND session.state IN ('CREATING', 'RUNNING', 'RECOVERING', 'CLOSING')
         ORDER BY session.updated_at DESC`,
      )
      .all() as VisibleAgentSessionRow[];

    // SQL 已经按 service_account_id 过滤；再次在边界处确认，避免旧迁移
    // 或测试替身返回普通网页持续会话后被误标成 Agent。
    // 先取全部活动行再做权限过滤，避免别的项目的新会话占满 SQL LIMIT，
    // 让当前用户实际有权访问的旧会话从“连接”面板消失。
    const checked = await Promise.all(
      rows.map(async (row) => {
        if (!row.serviceAccountId) return null;
        const access = await permissionManager.canAccessHost(
          userId,
          row.hostId,
          "connect",
          row.projectHostId,
        );
        return access.hasAccess ? row : null;
      }),
    );
    const uniqueRows = new Map<string, VisibleAgentSessionRow>();
    for (const row of checked) {
      if (row && !uniqueRows.has(row.id)) uniqueRows.set(row.id, row);
    }
    // 设备/旧 Token 授权表理论上各自唯一，但历史迁移或人工数据可能让
    // LEFT JOIN 产生重复行；按会话 ID 去重，避免连接面板出现重复 key/入口。
    return [...uniqueRows.values()].slice(0, 100);
  } catch (error) {
    // 旧数据库尚未完成 Agent 表迁移时，不影响普通网页连接列表。
    databaseLogger.warn("Failed to list Agent sessions for connections", {
      operation: "list_agent_sessions_for_connections",
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * @openapi
 * /open-tabs:
 *   get:
 *     summary: Get all open tabs for the current user
 *     tags:
 *       - Open Tabs
 *     responses:
 *       200:
 *         description: List of open tabs ordered by tab_order.
 */
const DEFAULT_TAB_TTL_MINUTES = 1440;

function getTabTtlMs(): number {
  try {
    const value = getCurrentSettingValue("ssh_disconnect_retention_minutes");
    if (value) {
      const minutes = parseInt(value, 10);
      if (Number.isSafeInteger(minutes) && minutes >= 1 && minutes <= 10080) {
        return minutes * 60_000;
      }
    }
  } catch {
    // DB not available, use default
  }
  return DEFAULT_TAB_TTL_MINUTES * 60_000;
}

// Legacy tab types that were renamed. Normalize on read so previously saved
// tabs still restore to the correct (renamed) tab type.
const LEGACY_TAB_TYPE_MAP: Record<string, string> = {
  stats: "host-metrics",
};

function normalizeTabType(tabType: string): string {
  return LEGACY_TAB_TYPE_MAP[tabType] ?? tabType;
}

router.get("/", authenticateJWT, async (req: Request, res: Response) => {
  const userId = (req as AuthenticatedRequest).userId;
  try {
    const ttlMs = getTabTtlMs();
    const cutoff = new Date(Date.now() - ttlMs).toISOString();
    const openTabRepository = createCurrentOpenTabRepository();
    const permissionManager = PermissionManager.getInstance();
    const accessChecks = new Map<string, Promise<boolean>>();
    const hasHostAccess = (
      hostId: number | null,
      projectHostId?: number | null,
    ): Promise<boolean> => {
      if (!Number.isSafeInteger(hostId) || !hostId || hostId <= 0) {
        return Promise.resolve(true);
      }
      const key = `${hostId}:${projectHostId ?? "any"}`;
      const existing = accessChecks.get(key);
      if (existing) return existing;
      const check = permissionManager
        .canAccessHost(userId, hostId, "connect", projectHostId ?? undefined)
        .then((access) => access.hasAccess)
        .catch((error) => {
          databaseLogger.error(
            "Failed to filter open tab by host access",
            error,
            {
              operation: "open_tabs_access_filter",
              userId,
              hostId,
              projectHostId: projectHostId ?? null,
            },
          );
          return false;
        });
      accessChecks.set(key, check);
      return check;
    };

    const allLiveSessions = sessionManager.getUserSessions(userId);
    const allFixedSessions =
      await createCurrentWebTerminalSessionRepository().listOwned(userId);
    const [liveSessions, fixedSessions] = await Promise.all([
      Promise.all(
        allLiveSessions.map(async (session) =>
          (await hasHostAccess(session.hostId, session.projectHostId))
            ? session
            : null,
        ),
      ).then((sessions) => sessions.filter((session) => session !== null)),
      Promise.all(
        allFixedSessions.map(async (session) =>
          (await hasHostAccess(session.hostId, session.projectHostId))
            ? session
            : null,
        ),
      ).then((sessions) => sessions.filter((session) => session !== null)),
    ]);
    const sessionContextByTab = new Map<
      string,
      { hostId: number; projectHostId?: number | null }
    >();
    for (const session of allLiveSessions) {
      if (session.tabInstanceId) {
        sessionContextByTab.set(session.tabInstanceId, session);
      }
    }
    for (const session of allFixedSessions) {
      sessionContextByTab.set(session.tabInstanceId, session);
    }
    const recentTabs = await openTabRepository.listRecentForUser(
      userId,
      cutoff,
    );
    const tabs = (
      await Promise.all(
        recentTabs.map(async (tab) => {
          const context = sessionContextByTab.get(tab.id);
          return (await hasHostAccess(
            context?.hostId ?? tab.hostId,
            context?.projectHostId,
          ))
            ? tab
            : null;
        }),
      )
    ).filter((tab) => tab !== null);
    const tabIds = new Set(tabs.map((tab) => tab.id));
    for (const session of liveSessions) {
      if (!session.tabInstanceId || tabIds.has(session.tabInstanceId)) continue;
      const activeTab = await openTabRepository.findByIdForUser(
        userId,
        session.tabInstanceId,
      );
      if (activeTab) {
        tabs.push(activeTab);
        tabIds.add(activeTab.id);
      }
    }

    for (const fixed of fixedSessions) {
      if (tabIds.has(fixed.tabInstanceId)) continue;
      const fixedTab = await openTabRepository.findByIdForUser(
        userId,
        fixed.tabInstanceId,
      );
      if (fixedTab) {
        tabs.push(fixedTab);
        tabIds.add(fixedTab.id);
      }
    }
    const fixedByTab = new Map(
      fixedSessions.map((session) => [session.tabInstanceId, session]),
    );
    const liveByTab = new Map(
      liveSessions
        .filter((session) => session.tabInstanceId)
        .map((session) => [session.tabInstanceId!, session]),
    );

    return res.json(
      tabs
        .sort((left, right) => left.tabOrder - right.tabOrder)
        .map((tab) => {
          const fixed = fixedByTab.get(tab.id);
          const live = liveByTab.get(tab.id);
          return {
            ...tab,
            tabType: normalizeTabType(tab.tabType),
            backendSessionId: live?.id ?? fixed?.id ?? tab.backendSessionId,
            sessionPinned: Boolean(fixed),
            tmuxSessionName: fixed?.tmuxName ?? null,
            lastDetachedAt: live?.lastDetachedAt ?? null,
            retentionExpiresAt: fixed
              ? null
              : (live?.retentionExpiresAt ?? null),
          };
        }),
    );
  } catch (e) {
    databaseLogger.error("Failed to get open tabs", e, {
      operation: "get_open_tabs",
      userId,
    });
    return res.status(500).json({ error: "Failed to get open tabs" });
  }
});

/**
 * @openapi
 * /open-tabs:
 *   post:
 *     summary: Upsert a single open tab for the current user
 *     tags:
 *       - Open Tabs
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [id, tabType, label, tabOrder]
 *             properties:
 *               id:
 *                 type: string
 *               tabType:
 *                 type: string
 *               hostId:
 *                 type: integer
 *                 nullable: true
 *               label:
 *                 type: string
 *               tabOrder:
 *                 type: integer
 *               backendSessionId:
 *                 type: string
 *                 nullable: true
 *     responses:
 *       200:
 *         description: Tab upserted successfully.
 */
router.post("/", authenticateJWT, async (req: Request, res: Response) => {
  const userId = (req as AuthenticatedRequest).userId;
  const { id, tabType, hostId, label, tabOrder, backendSessionId } =
    req.body as {
      id: string;
      tabType: string;
      hostId?: number | null;
      label: string;
      tabOrder: number;
      backendSessionId?: string | null;
    };

  if (!id || !tabType || !label) {
    return res
      .status(400)
      .json({ error: "id, tabType, and label are required" });
  }

  try {
    await createCurrentOpenTabRepository().upsertForUser(userId, {
      id,
      tabType,
      hostId,
      label,
      tabOrder,
      backendSessionId,
    });
    return res.json({ success: true });
  } catch (e) {
    databaseLogger.error("Failed to upsert open tab", e, {
      operation: "upsert_open_tab",
      userId,
      id,
    });
    return res.status(500).json({ error: "Failed to upsert open tab" });
  }
});

/**
 * @openapi
 * /open-tabs:
 *   put:
 *     summary: Bulk replace all open tabs for the current user
 *     tags:
 *       - Open Tabs
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               tabs:
 *                 type: array
 *     responses:
 *       200:
 *         description: Tabs updated successfully.
 */
router.put("/", authenticateJWT, async (req: Request, res: Response) => {
  const userId = (req as AuthenticatedRequest).userId;
  const { tabs } = req.body as {
    tabs: Array<{
      id: string;
      tabType: string;
      hostId?: number | null;
      label: string;
      tabOrder: number;
      backendSessionId?: string | null;
    }>;
  };

  if (!Array.isArray(tabs)) {
    return res.status(400).json({ error: "tabs must be an array" });
  }

  try {
    await createCurrentOpenTabRepository().replaceForUser(userId, tabs);
    return res.json({ success: true });
  } catch (e) {
    databaseLogger.error("Failed to sync open tabs", e, {
      operation: "sync_open_tabs",
      userId,
    });
    return res.status(500).json({ error: "Failed to sync open tabs" });
  }
});

/**
 * @openapi
 * /open-tabs/{id}:
 *   patch:
 *     summary: Update a single open tab
 *     tags:
 *       - Open Tabs
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Tab updated successfully.
 *       404:
 *         description: Tab not found.
 */
router.patch("/:id", authenticateJWT, async (req: Request, res: Response) => {
  const userId = (req as AuthenticatedRequest).userId;
  const id = String(req.params.id);
  const updates = req.body as Partial<{
    label: string;
    tabOrder: number;
    backendSessionId: string | null;
  }>;

  try {
    const updated = await createCurrentOpenTabRepository().updateForUser(
      userId,
      id,
      updates,
    );

    if (!updated) {
      return res.status(404).json({ error: "Tab not found" });
    }
    return res.json({ success: true });
  } catch (e) {
    databaseLogger.error("Failed to update open tab", e, {
      operation: "update_open_tab",
      userId,
      id,
    });
    return res.status(500).json({ error: "Failed to update open tab" });
  }
});

/** 分离浏览器附件，同时保留可恢复的固定会话及标签记录。 */
router.post(
  "/:id/detach",
  authenticateJWT,
  async (req: Request, res: Response) => {
    const authenticatedRequest = req as AuthenticatedRequest;
    const userId = authenticatedRequest.userId;
    const id = String(req.params.id);

    try {
      const openTabRepository = createCurrentOpenTabRepository();
      const tab = await openTabRepository.findByIdForUser(userId, id);
      if (!tab) {
        return res.status(404).json({
          error: "Open tab not found",
          code: "OPEN_TAB_NOT_FOUND",
        });
      }

      const fixedSessions =
        await createCurrentWebTerminalSessionRepository().listOwned(userId);
      const fixed = fixedSessions.find(
        (session) => session.tabInstanceId === id,
      );
      const live = sessionManager
        .getUserSessions(userId)
        .find(
          (session) =>
            session.pinned &&
            (session.attachedTabInstanceId ?? session.tabInstanceId) === id,
        );
      const detachedSession = live ?? fixed;
      if (!detachedSession) {
        return res.status(409).json({
          error: "Pinned terminal is no longer available",
          code: "PINNED_SESSION_NOT_FOUND",
        });
      }

      // 标签记录必须保留，以便浏览器分离后仍能从连接面板恢复。
      // WebSocket 随组件卸载自然关闭，SessionManager 只移除附件。
      const { ipAddress, userAgent } = getRequestMeta(req);
      await logAudit({
        userId,
        username: authenticatedRequest.user?.username ?? userId,
        action: "web_terminal_detach",
        resourceType: "terminal_session",
        resourceId: detachedSession.id,
        details: JSON.stringify({
          hostId: detachedSession.hostId,
          projectHostId: detachedSession.projectHostId ?? null,
        }),
        ipAddress,
        userAgent,
        success: true,
      });
      return res.json({
        success: true,
        sessionId: detachedSession.id,
        tab: {
          ...tab,
          tabType: normalizeTabType(tab.tabType),
          backendSessionId: detachedSession.id,
          sessionPinned: true,
          tmuxSessionName:
            live !== undefined
              ? live.managedTmux
                ? (live.tmuxSessionName ?? null)
                : null
              : (fixed?.tmuxName ?? null),
          lastDetachedAt: live?.lastDetachedAt ?? null,
          retentionExpiresAt: null,
        },
      });
    } catch (error) {
      databaseLogger.error("Failed to detach pinned terminal tab", error, {
        operation: "detach_pinned_terminal_tab",
        userId,
        id,
      });
      return res
        .status(500)
        .json({ error: "Failed to detach pinned terminal tab" });
    }
  },
);

/**
 * @openapi
 * /open-tabs/{id}:
 *   delete:
 *     summary: Delete a single open tab
 *     tags:
 *       - Open Tabs
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Tab deleted successfully.
 */
router.delete("/:id", authenticateJWT, async (req: Request, res: Response) => {
  const authenticatedRequest = req as AuthenticatedRequest;
  const userId = authenticatedRequest.userId;
  const id = String(req.params.id);

  try {
    const fixedSessions =
      await createCurrentWebTerminalSessionRepository().listOwned(userId);
    const fixed = fixedSessions.find((session) => session.tabInstanceId === id);
    let closedSession:
      | {
          id: string;
          hostId: number;
          projectHostId?: number | null;
        }
      | undefined;
    if (fixed) {
      const live = sessionManager.getSession(fixed.id);
      if (!live) {
        return res.status(409).json({
          error: "Restore the pinned terminal before closing it",
          code: "PINNED_SESSION_RESTORE_REQUIRED",
          sessionId: fixed.id,
        });
      }
      const terminated = await sessionManager.terminatePinnedSession(
        fixed.id,
        userId,
      );
      if (!terminated) {
        return res.status(409).json({
          error: "Pinned terminal state changed; restore it before closing",
          code: "PINNED_SESSION_RESTORE_REQUIRED",
          sessionId: fixed.id,
        });
      }
      closedSession = fixed;
    } else {
      const live = sessionManager
        .getUserSessions(userId)
        .find(
          (session) =>
            (session.attachedTabInstanceId ?? session.tabInstanceId) === id,
        );
      if (live) {
        await sessionManager.terminateSession(live.id, userId);
        closedSession = live;
      }
    }
    if (closedSession) {
      const { ipAddress, userAgent } = getRequestMeta(req);
      await logAudit({
        userId,
        username: authenticatedRequest.user?.username ?? userId,
        action: "web_terminal_close",
        resourceType: "terminal_session",
        resourceId: closedSession.id,
        details: JSON.stringify({
          hostId: closedSession.hostId,
          projectHostId: closedSession.projectHostId ?? null,
        }),
        ipAddress,
        userAgent,
        success: true,
      });
    }
    await createCurrentOpenTabRepository().deleteForUser(userId, id);
    return res.json({ success: true });
  } catch (e) {
    if (e instanceof TerminalSessionTransitionError) {
      return res.status(409).json({
        error: e.message,
        code: e.code,
      });
    }
    databaseLogger.error("Failed to delete open tab", e, {
      operation: "delete_open_tab",
      userId,
      id,
    });
    return res.status(500).json({ error: "Failed to delete open tab" });
  }
});

/**
 * @openapi
 * /open-tabs/active-sessions:
 *   get:
 *     summary: Get all active backend sessions for the current user
 *     description: >
 *       Returns live terminal sessions from the session manager, both sessions the
 *       caller owns and SSH sessions shared to the caller by another user (via
 *       an in-app session share). Used by the Active Connections panel and tab restore logic.
 *     tags:
 *       - Open Tabs
 *     responses:
 *       200:
 *         description: List of active sessions (own and shared-with-me).
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   sessionId:
 *                     type: string
 *                   hostId:
 *                     type: integer
 *                   hostName:
 *                     type: string
 *                   projectId:
 *                     type: string
 *                     nullable: true
 *                   projectHostId:
 *                     type: integer
 *                     nullable: true
 *                   tabInstanceId:
 *                     type: string
 *                   isConnected:
 *                     type: boolean
 *                   createdAt:
 *                     type: number
 *                   isOwnSession:
 *                     type: boolean
 *                   sharedByUsername:
 *                     type: string
 *                     nullable: true
 *                   permissionLevel:
 *                     type: string
 *                     nullable: true
 *                   shareId:
 *                     type: string
 *                     nullable: true
 *                   sessionSource:
 *                     type: string
 *                     enum: [web, agent]
 *                   agentSessionId:
 *                     type: string
 *                     nullable: true
 *                   agentActorName:
 *                     type: string
 *                     nullable: true
 *                   runtimeMode:
 *                     type: string
 *                     enum: [platform, tmux]
 *                     nullable: true
 */
router.get(
  "/active-sessions",
  authenticateJWT,
  async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    try {
      const allOwnSessions = sessionManager.getUserSessions(userId);
      const permissionManager = PermissionManager.getInstance();
      const ownSessions = (
        await Promise.all(
          allOwnSessions.map(async (session) => {
            if (!Number.isSafeInteger(session.hostId) || session.hostId <= 0) {
              return session;
            }
            const access = await permissionManager.canAccessHost(
              userId,
              session.hostId,
              "connect",
              session.projectHostId,
            );
            return access.hasAccess ? session : null;
          }),
        )
      ).filter((session): session is NonNullable<typeof session> => !!session);
      const result = ownSessions.map((s) => ({
        sessionId: s.id,
        hostId: s.hostId,
        hostName: s.hostName,
        projectId: null as string | null,
        projectHostId: s.projectHostId ?? null,
        tabInstanceId: s.attachedTabInstanceId ?? s.tabInstanceId ?? null,
        isConnected: s.isConnected,
        createdAt: s.createdAt,
        lastDetachedAt: s.lastDetachedAt,
        retentionExpiresAt: s.retentionExpiresAt,
        sessionPinned: s.pinned,
        sessionManagedTmux: s.managedTmux,
        // Agent 的 tmux 标识由服务端根据 agentSessionId 解析，不能放进
        // 浏览器的活动连接响应。
        tmuxSessionName: s.agentSessionId ? null : s.tmuxSessionName,
        recoverable: s.managedTmux,
        isOwnSession: true,
        sharedByUsername: null as string | null,
        permissionLevel: null as string | null,
        shareId: null as string | null,
        sessionSource: s.agentSessionId ? ("agent" as const) : ("web" as const),
        agentSessionId: s.agentSessionId ?? null,
        agentActorName: s.agentSessionId ? "Agent" : null,
        runtimeMode: null as "platform" | "tmux" | null,
      }));

      const liveIds = new Set(allOwnSessions.map((session) => session.id));
      const fixedSessions =
        await createCurrentWebTerminalSessionRepository().listOwned(userId);
      const openTabs = await createCurrentOpenTabRepository().listRecentForUser(
        userId,
        new Date(0).toISOString(),
      );
      const tabsById = new Map(openTabs.map((tab) => [tab.id, tab]));
      for (const fixed of fixedSessions) {
        if (liveIds.has(fixed.id)) {
          continue;
        }
        const access = await permissionManager.canAccessHost(
          userId,
          fixed.hostId,
          "connect",
          fixed.projectHostId ?? undefined,
        );
        if (!access.hasAccess) continue;
        const tab = tabsById.get(fixed.tabInstanceId);
        result.push({
          sessionId: fixed.id,
          hostId: fixed.hostId,
          hostName: tab?.label ?? `Host ${fixed.hostId}`,
          projectId: null,
          projectHostId: fixed.projectHostId ?? null,
          tabInstanceId: fixed.tabInstanceId,
          isConnected: false,
          createdAt: Date.parse(fixed.createdAt),
          lastDetachedAt: fixed.lastDetachedAt
            ? Date.parse(fixed.lastDetachedAt)
            : null,
          retentionExpiresAt: null,
          sessionPinned: true,
          sessionManagedTmux: true,
          tmuxSessionName: fixed.tmuxName,
          recoverable: true,
          isOwnSession: true,
          sharedByUsername: null,
          permissionLevel: null,
          shareId: null,
          sessionSource: "web" as const,
          agentSessionId: null,
          agentActorName: null,
          runtimeMode: null,
        });
      }

      const sharedWithMe =
        await createCurrentSessionShareRepository().findSharesTargetingUser(
          userId,
        );
      for (const share of sharedWithMe) {
        if (share.protocol !== "ssh") continue;
        const sharedSession = sessionManager.getSession(share.sessionId);
        if (!sharedSession || !sharedSession.isConnected) continue;
        const access = await permissionManager.canAccessHost(
          userId,
          sharedSession.hostId,
          "connect",
          sharedSession.projectHostId,
        );
        if (!access.hasAccess) continue;
        result.push({
          sessionId: sharedSession.id,
          hostId: sharedSession.hostId,
          hostName: sharedSession.hostName,
          projectId: null,
          projectHostId: sharedSession.projectHostId ?? null,
          tabInstanceId:
            sharedSession.attachedTabInstanceId ??
            sharedSession.tabInstanceId ??
            null,
          isConnected: sharedSession.isConnected,
          createdAt: sharedSession.createdAt,
          lastDetachedAt: sharedSession.lastDetachedAt,
          retentionExpiresAt: sharedSession.retentionExpiresAt,
          sessionPinned: sharedSession.pinned,
          sessionManagedTmux: sharedSession.managedTmux,
          tmuxSessionName: null,
          recoverable: false,
          isOwnSession: false,
          sharedByUsername: share.ownerUsername,
          permissionLevel: share.permissionLevel,
          shareId: share.id,
          sessionSource: "web" as const,
          agentSessionId: null,
          agentActorName: null,
          runtimeMode: null,
        });
      }

      const agentSessions = await listVisibleAgentSessions(
        userId,
        permissionManager,
      );
      for (const agent of agentSessions) {
        const isRunning = ["RUNNING", "RECOVERING"].includes(agent.state);
        const runtimeMode =
          agent.runtimeMode === "platform" ? "platform" : "tmux";
        result.push({
          sessionId: agent.id,
          hostId: agent.hostId,
          hostName: agent.alias || agent.hostName,
          projectId: agent.projectId,
          projectHostId: agent.projectHostId,
          tabInstanceId: null,
          isConnected: isRunning,
          createdAt: Date.parse(agent.createdAt) || Date.now(),
          lastDetachedAt: agent.lastDetachedAt
            ? Date.parse(agent.lastDetachedAt) || null
            : null,
          retentionExpiresAt: agent.retainUntil
            ? Date.parse(agent.retainUntil) || null
            : null,
          sessionPinned: Boolean(agent.pinned),
          sessionManagedTmux: runtimeMode === "tmux",
          // tmux 名称只在服务端按 agentSessionId 解析，不通过列表暴露。
          tmuxSessionName: null,
          recoverable: runtimeMode === "tmux",
          isOwnSession: true,
          sharedByUsername: null,
          permissionLevel: null,
          shareId: null,
          sessionSource: "agent" as const,
          agentSessionId: agent.id,
          agentActorName: agent.agentActorName || "Agent",
          runtimeMode,
        });
      }

      return res.json(result);
    } catch (e) {
      databaseLogger.error("Failed to get active sessions", e, {
        operation: "get_active_sessions",
        userId,
      });
      return res.status(500).json({ error: "Failed to get active sessions" });
    }
  },
);

export default router;
