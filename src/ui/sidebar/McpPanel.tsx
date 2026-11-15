import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, RefreshCw, KeyRound, Plug } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/button";
import { Input } from "@/components/input";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/dialog";
import { copyToClipboard } from "@/lib/clipboard";
import {
  MfaStepUpDialog,
  type MfaStepUpMethod,
} from "@/components/MfaStepUpDialog";
import { getMfaStepUpMethods } from "@/api/mfa-api";
import type { AgentScope } from "@/api/agent-admin-api";
import {
  createMcpKey,
  loadMcpAccess,
  loadMcpHistory,
  loadMcpTools,
  mcpConfiguration,
  mcpEndpoint,
  revokeMcpKey,
  type McpTool,
  type McpRecord,
} from "@/api/mcp-api";

const scopes: AgentScope[] = [
  "sessions:create",
  "sessions:read",
  "sessions:write",
  "sessions:close",
  "jobs:execute",
  "files:read",
  "files:write",
];

type PendingStepUp = {
  id: number;
  methods: MfaStepUpMethod[];
  retry: () => Promise<void>;
  target: "create" | "revoke";
  verifying: boolean;
};

export function McpPanel() {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith("zh");
  const text = (cn: string, en: string) => (zh ? cn : en);
  const [tab, setTab] = useState(0);
  const [client, setClient] = useState<"Codex" | "Cursor">("Codex");
  const [access, setAccess] = useState<
    Awaited<ReturnType<typeof loadMcpAccess>>
  >({ projects: [], tokens: [] });
  const [tools, setTools] = useState<McpTool[]>([]);
  const [records, setRecords] = useState<McpRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState("");
  const [keyFilter, setKeyFilter] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [projects, setProjects] = useState<string[]>([]);
  const [permissions, setPermissions] = useState<AgentScope[]>([
    "sessions:read",
    "files:read",
  ]);
  const [expiry, setExpiry] = useState("30");
  const [concurrency, setConcurrency] = useState(1);
  const [secret, setSecret] = useState("");
  const [revoking, setRevoking] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState<PendingStepUp | null>(null);
  const pendingStepUp = useRef<PendingStepUp | null>(null);
  const stepUpGeneration = useRef(0);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pendingStepUp.current = null;
    };
  }, []);
  const cancelStepUp = () => {
    pendingStepUp.current = null;
    setStepUp(null);
  };
  const startVerification = (id: number) => {
    const pending = pendingStepUp.current;
    if (!mounted.current || pending?.id !== id || pending.verifying)
      return false;
    pendingStepUp.current = { ...pending, verifying: true };
    setStepUp(pendingStepUp.current);
    return true;
  };
  const endVerification = (id: number) => {
    const pending = pendingStepUp.current;
    if (!mounted.current || pending?.id !== id) return;
    pendingStepUp.current = { ...pending, verifying: false };
    setStepUp(pendingStepUp.current);
  };
  const mutate = async (
    action: () => Promise<void>,
    retry = true,
    target: "create" | "revoke" = "create",
  ) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (error) {
      if (!mounted.current) return;
      const methods = retry ? getMfaStepUpMethods(error) : null;
      if (methods) {
        const pending: PendingStepUp = {
          id: ++stepUpGeneration.current,
          methods,
          target,
          verifying: false,
          retry: () => mutate(action, false, target),
        };
        pendingStepUp.current = pending;
        setStepUp(pending);
      } else {
        const response = (error as { response?: { data?: { error?: string } } })
          .response?.data;
        setError(
          response?.error ??
            text("操作失败，请重试", "Operation failed; please retry"),
        );
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const finishStepUp = async (id: number) => {
    const pending = pendingStepUp.current;
    if (!mounted.current || pending?.id !== id || !pending.verifying) return;
    // 在任何异步操作前同步消费，旧组件回调和重复响应都不能再次重试。
    pendingStepUp.current = null;
    setStepUp(null);
    await pending.retry();
  };
  const endpoint = mcpEndpoint();
  const config = mcpConfiguration(endpoint, client);
  const instructions = `${text("连接 CloudSSH MCP", "Connect to CloudSSH MCP")}\n${endpoint}\n${text("创建调用密钥并设置客户端环境变量 CLOUDSSH_MCP_KEY，然后添加以下配置。连接后先调用 cloudssh_context。", "Create an access key and set CLOUDSSH_MCP_KEY in the client environment. Add this configuration, then call cloudssh_context first.")}\n\n${config}`;
  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [a, t] = await Promise.all([loadMcpAccess(), loadMcpTools()]);
      setAccess(a);
      setTools(t);
    } catch {
      setError("Failed to load MCP management data / MCP 管理数据加载失败");
    } finally {
      setLoading(false);
    }
  }, []);
  const history = useCallback(async () => {
    const data = await loadMcpHistory(page, filter, keyFilter, status);
    setRecords(data.records);
    setTotal(data.total);
  }, [page, filter, keyFilter, status]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (tab !== 3) return;
    let active = true;
    setLoading(true);
    setError("");
    void loadMcpHistory(page, filter, keyFilter, status)
      .then((data) => {
        if (active) {
          setRecords(data.records);
          setTotal(data.total);
        }
      })
      .catch(() => {
        if (active) setError("Failed to load history / 调用记录加载失败");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [tab, page, filter, keyFilter, status]);
  const copy = async (value: string) => {
    try {
      await copyToClipboard(value);
      toast.success(text("已复制", "Copied"));
    } catch {
      toast.error(text("复制失败", "Copy failed"));
    }
  };
  const codeBlock = (value: string) => (
    <div className="relative rounded-md border border-border bg-background p-4 pr-14">
      <pre className="overflow-x-auto whitespace-pre-wrap break-all text-xs leading-6">
        {value}
      </pre>
      <Button
        aria-label={text("复制", "Copy")}
        variant="ghost"
        size="icon"
        className="absolute right-2 top-2"
        onClick={() => void copy(value)}
      >
        <Copy className="size-4" />
      </Button>
    </div>
  );
  const selectClass =
    "h-9 rounded-md border border-border bg-background px-3 text-sm";
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">
            {text(
              "连接外部 Agent，管理调用权限与密钥",
              "Connect agents and manage access",
            )}
          </p>
          <h2 className="mt-1 text-2xl font-semibold">
            {text("MCP 管理", "MCP management")}
          </h2>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => void copy(instructions)}>
            {text("复制接入说明", "Copy instructions")}
          </Button>
          <Button
            variant="ghost"
            disabled={loading}
            onClick={() =>
              void (tab === 3
                ? history().catch(() => setError("Failed to load history"))
                : refresh())
            }
          >
            <RefreshCw className="mr-2 size-4" />
            {text("刷新", "Refresh")}
          </Button>
        </div>
      </header>
      <nav
        className="flex gap-5 overflow-x-auto border-b border-border"
        aria-label="MCP"
      >
        {[
          text("MCP 接入", "Connection"),
          text("工具参考", "Tools"),
          text("调用密钥", "Access keys"),
          text("调用记录", "History"),
        ].map((label, index) => (
          <button
            key={index}
            className={`whitespace-nowrap border-b-2 pb-3 text-sm font-medium ${tab === index ? "border-primary text-primary" : "border-transparent text-muted-foreground"}`}
            onClick={() => setTab(index)}
            aria-current={tab === index ? "page" : undefined}
          >
            {label}
          </button>
        ))}
      </nav>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {loading && (
        <p role="status" className="text-sm text-muted-foreground">
          {text("加载中…", "Loading…")}
        </p>
      )}
      {tab === 0 && (
        <section className="rounded-xl border border-border bg-muted/30 p-6">
          <div className="grid gap-8 lg:grid-cols-2">
            <div className="space-y-5">
              <h3 className="text-xl font-semibold">
                {text("连接你的 SSH Agent", "Connect your SSH agent")}
              </h3>
              <p className="text-sm text-muted-foreground">
                {text(
                  "配置一次，通过 HTTP MCP 操作已授权的主机、命令任务、会话和远程文件。",
                  "Use HTTP MCP to operate authorized hosts, command jobs, sessions and remote files.",
                )}
              </p>
              <ol className="list-inside list-decimal space-y-4 text-sm">
                <li>
                  {text(
                    "创建调用密钥，选择项目、权限和有效期。",
                    "Create a key with projects, permissions and expiry.",
                  )}{" "}
                  <button
                    className="text-primary underline"
                    onClick={() => setTab(2)}
                  >
                    {text("管理密钥", "Manage keys")}
                  </button>
                </li>
                <li>
                  {text(
                    "将密钥放入客户端环境变量 CLOUDSSH_MCP_KEY。",
                    "Set CLOUDSSH_MCP_KEY in your client's environment.",
                  )}
                </li>
                <li>
                  {text(
                    "添加配置，连接后先调用 cloudssh_context。",
                    "Add the configuration and call cloudssh_context first.",
                  )}
                </li>
              </ol>
              <div className="space-y-2 border-t border-border pt-5">
                <h4>{text("当前服务 MCP 地址", "MCP endpoint")}</h4>
                {codeBlock(endpoint)}
                <p className="text-xs text-muted-foreground">
                  {text(
                    "复制配置不代表已连接，最近使用时间见调用密钥。",
                    "Copying configuration does not establish a connection. See key last-used times.",
                  )}
                </p>
              </div>
            </div>
            <div className="space-y-3">
              <div className="flex gap-2">
                {(["Cursor", "Codex"] as const).map((c) => (
                  <Button
                    key={c}
                    variant={client === c ? "secondary" : "ghost"}
                    onClick={() => setClient(c)}
                  >
                    {c}
                  </Button>
                ))}
              </div>
              <p className="text-sm">
                {client}{" "}
                {text(
                  "MCP 配置（使用环境变量）",
                  "MCP configuration (environment variable)",
                )}
              </p>
              {codeBlock(config)}
              <p className="text-xs leading-6 text-muted-foreground">
                {text(
                  "客户端进程必须能够读取环境变量。远程连接请使用可访问的 HTTPS 地址；localhost 仅供本机客户端使用。",
                  "The client process must inherit the environment variable. Remote connections require an accessible HTTPS address; localhost is local-only.",
                )}
              </p>
            </div>
          </div>
          <div className="mt-7 space-y-2 border-t border-border pt-5 text-sm text-muted-foreground">
            <h4 className="font-medium text-foreground">
              {text("工具与执行规则", "Tools and execution rules")} ·{" "}
              {tools.length}
            </h4>
            <p>
              {text(
                "工具按密钥权限开放；写操作需提供 request_id，重试使用原标识及参数。",
                "Tools follow key scopes. Writes require request_id; retries use identical IDs and arguments.",
              )}
            </p>
            <p>
              {text(
                "命令异步执行，通过任务状态读取退出码。审计不记录命令内容、输出或密钥，记录保留 30 天。",
                "Commands run asynchronously; poll job status for exit codes. Audit excludes arguments, output and secrets; history is retained for 30 days.",
              )}
            </p>
          </div>
        </section>
      )}
      {tab === 1 && (
        <div className="space-y-3">
          {tools.map((tool) => (
            <details
              key={tool.name}
              className="rounded-lg border border-border p-4"
            >
              <summary className="cursor-pointer font-mono text-sm">
                {tool.name}
                <span className="ml-3 font-sans text-xs text-muted-foreground">
                  {tool.scope ?? text("基础查询", "Discovery")}
                </span>
              </summary>
              <p className="my-3 text-sm text-muted-foreground">
                {tool.description}
              </p>
              {codeBlock(JSON.stringify(tool.inputSchema, null, 2))}
              <p className="mt-3 text-xs text-muted-foreground">
                {text("调用方式", "Invocation")}: tools/call → name: {tool.name}
                , arguments:{" "}
                {text("按上方 schema 填写", "according to the schema above")}
              </p>
            </details>
          ))}
        </div>
      )}
      {tab === 2 && (
        <div className="space-y-5">
          <form
            className="space-y-4 rounded-xl border border-border p-5"
            onSubmit={(event) => {
              event.preventDefault();
              if (busy || stepUp) return;
              const input = {
                name,
                projectIds: projects,
                scopes: permissions,
                expiresAt: expiry
                  ? new Date(
                      Date.now() + Number(expiry) * 86400000,
                    ).toISOString()
                  : null,
                maxConcurrentSessions: concurrency,
              };
              void mutate(async () => {
                const result = await createMcpKey(input);
                setSecret(result.token);
                setName("");
                await refresh();
              });
            }}
          >
            <h3 className="flex items-center gap-2 font-semibold">
              <KeyRound className="size-4" />
              {text("创建调用密钥", "Create access key")}
            </h3>
            <fieldset disabled={busy || Boolean(stepUp)} className="space-y-4">
              <label className="block space-y-2 text-sm">
                <span>{text("名称", "Name")}</span>
                <Input
                  required
                  maxLength={128}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <fieldset>
                <legend className="mb-2 text-sm">
                  {text("授权项目", "Authorized projects")}
                </legend>
                <div className="flex flex-wrap gap-4">
                  {access.projects.map((p) => (
                    <label key={p.id} className="flex gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={projects.includes(p.id)}
                        onChange={(e) =>
                          setProjects((old) =>
                            e.target.checked
                              ? [...old, p.id]
                              : old.filter((id) => id !== p.id),
                          )
                        }
                      />
                      {p.name}
                    </label>
                  ))}
                </div>
              </fieldset>
              <fieldset>
                <legend className="mb-2 text-sm">
                  {text("操作权限", "Permissions")}
                </legend>
                <div className="grid gap-2 sm:grid-cols-3">
                  {scopes.map((scope) => (
                    <label key={scope} className="flex gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={permissions.includes(scope)}
                        onChange={(e) =>
                          setPermissions((old) =>
                            e.target.checked
                              ? [...old, scope]
                              : old.filter((s) => s !== scope),
                          )
                        }
                      />
                      {scope}
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="flex flex-wrap gap-4">
                <label className="space-y-2 text-sm">
                  <span className="block">{text("有效期", "Expiry")}</span>
                  <select
                    className={selectClass}
                    value={expiry}
                    onChange={(e) => setExpiry(e.target.value)}
                  >
                    {["7", "30", "90", ""].map((v) => (
                      <option key={v} value={v}>
                        {v
                          ? `${v} ${text("天", "days")}`
                          : text("永不过期", "Never")}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-2 text-sm">
                  <span className="block">
                    {text("并发会话上限", "Concurrent sessions")}
                  </span>
                  <Input
                    type="number"
                    min={1}
                    max={100}
                    required
                    value={concurrency}
                    onChange={(e) => setConcurrency(Number(e.target.value))}
                  />
                </label>
              </div>
            </fieldset>
            {stepUp?.target === "create" ? (
              <MfaStepUpDialog
                inline
                open
                methods={stepUp.methods}
                title={text(
                  "验证身份并创建密钥",
                  "Verify identity to create key",
                )}
                description={text(
                  "在这里完成验证后，将自动按上面的配置创建密钥。",
                  "Verify here to automatically create the key with the settings above.",
                )}
                verifying={stepUp.verifying}
                onVerificationStart={() => startVerification(stepUp.id)}
                onVerificationEnd={() => endVerification(stepUp.id)}
                onCancel={cancelStepUp}
                onVerified={() => finishStepUp(stepUp.id)}
              />
            ) : (
              <Button
                type="submit"
                disabled={
                  busy ||
                  Boolean(stepUp) ||
                  !name.trim() ||
                  !projects.length ||
                  !permissions.length
                }
              >
                {text("创建密钥", "Create key")}
              </Button>
            )}
          </form>
          {!access.tokens.length && (
            <p className="text-sm text-muted-foreground">
              {text("暂无调用密钥", "No access keys")}
            </p>
          )}
          {access.tokens.map((key) => (
            <div
              key={key.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4"
            >
              <div>
                <h4 className="font-medium">
                  {key.name}{" "}
                  <span className="text-xs text-muted-foreground">
                    {!key.isActive
                      ? text("已撤销", "Revoked")
                      : key.expiresAt && Date.parse(key.expiresAt) <= Date.now()
                        ? text("已过期", "Expired")
                        : text("有效", "Active")}
                  </span>
                </h4>
                <p className="text-xs text-muted-foreground">
                  {key.tokenPrefix}… · {text("最近使用", "Last used")}:{" "}
                  {key.lastUsedAt
                    ? new Date(key.lastUsedAt).toLocaleString()
                    : "—"}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {key.scopes.join(", ")} · {text("到期", "Expires")}:{" "}
                  {key.expiresAt
                    ? new Date(key.expiresAt).toLocaleString()
                    : "—"}
                </p>
              </div>
              <Button
                variant="outline"
                disabled={!key.isActive || busy || Boolean(stepUp)}
                onClick={() => setRevoking(key.id)}
              >
                {text("撤销", "Revoke")}
              </Button>
            </div>
          ))}
        </div>
      )}
      {tab === 3 && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-3">
            <select
              aria-label="Tool filter"
              className={selectClass}
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
                setPage(1);
              }}
            >
              <option value="">{text("全部工具", "All tools")}</option>
              {tools.map((tool) => (
                <option key={tool.name}>{tool.name}</option>
              ))}
            </select>
            <select
              aria-label="Key filter"
              className={selectClass}
              value={keyFilter}
              onChange={(e) => {
                setKeyFilter(e.target.value);
                setPage(1);
              }}
            >
              <option value="">{text("全部密钥", "All keys")}</option>
              {access.tokens.map((key) => (
                <option key={key.id} value={key.id}>
                  {key.name}
                </option>
              ))}
            </select>
            <select
              aria-label="Status filter"
              className={selectClass}
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
            >
              <option value="">{text("全部结果", "All results")}</option>
              <option value="success">{text("成功", "Success")}</option>
              <option value="error">{text("失败", "Error")}</option>
            </select>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border text-muted-foreground">
                <tr>
                  {[
                    text("时间", "Time"),
                    text("工具", "Tool"),
                    text("密钥 / 项目", "Key / project"),
                    text("结果", "Result"),
                    text("耗时", "Duration"),
                  ].map((h) => (
                    <th key={h} className="p-3">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {records.map((r) => (
                  <tr key={r.id} className="border-b border-border">
                    <td className="whitespace-nowrap p-3">
                      {new Date(r.createdAt).toLocaleString()}
                    </td>
                    <td className="p-3 font-mono text-xs">{r.tool}</td>
                    <td className="p-3">
                      {r.tokenName}
                      <div className="text-xs text-muted-foreground">
                        {r.projectId ?? "—"}
                      </div>
                    </td>
                    <td className="p-3">
                      {r.success
                        ? text("成功", "Success")
                        : (r.code ?? "Error")}
                    </td>
                    <td className="p-3">{r.durationMs} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!records.length && !loading && (
            <p className="text-muted-foreground">
              {text("暂无调用记录", "No invocations")}
            </p>
          )}
          <div className="flex items-center justify-end gap-3">
            <Button
              variant="outline"
              disabled={page <= 1 || loading}
              onClick={() => setPage(page - 1)}
            >
              {text("上一页", "Previous")}
            </Button>
            <span className="text-sm">
              {page} / {Math.max(1, Math.ceil(total / 25))}
            </span>
            <Button
              variant="outline"
              disabled={page * 25 >= total || loading}
              onClick={() => setPage(page + 1)}
            >
              {text("下一页", "Next")}
            </Button>
          </div>
        </div>
      )}
      <Dialog
        open={Boolean(secret)}
        onOpenChange={(open) => {
          if (!open) setSecret("");
        }}
      >
        <DialogContent>
          <DialogTitle>
            {text("保存调用密钥", "Save your access key")}
          </DialogTitle>
          <DialogDescription>
            {text(
              "完整密钥仅显示一次。关闭后无法再次查看。",
              "This key is shown only once. Save it before closing.",
            )}
          </DialogDescription>
          {codeBlock(secret)}
          <Button onClick={() => setSecret("")}>
            {text("已保存", "Saved")}
          </Button>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(revoking) && !stepUp}
        onOpenChange={(open) => {
          if (!open && !busy) setRevoking(null);
        }}
      >
        <DialogContent>
          <DialogTitle>
            {text("撤销调用密钥？", "Revoke access key?")}
          </DialogTitle>
          <DialogDescription>
            {text(
              "撤销后，该密钥的后续 MCP 请求将被拒绝。",
              "Subsequent MCP requests using this key will be rejected.",
            )}
          </DialogDescription>
          <Button
            disabled={busy}
            onClick={() => {
              if (!revoking) return;
              void mutate(
                async () => {
                  await revokeMcpKey(revoking);
                  setRevoking(null);
                  await refresh();
                },
                true,
                "revoke",
              );
            }}
          >
            {text("确认撤销", "Confirm revoke")}
          </Button>
        </DialogContent>
      </Dialog>
      <MfaStepUpDialog
        open={stepUp?.target === "revoke"}
        methods={stepUp?.methods ?? []}
        verifying={stepUp?.verifying}
        onVerificationStart={() =>
          stepUp ? startVerification(stepUp.id) : false
        }
        onVerificationEnd={() => {
          if (stepUp) endVerification(stepUp.id);
        }}
        onCancel={() => {
          cancelStepUp();
          setRevoking(null);
        }}
        onVerified={() => {
          if (stepUp) return finishStepUp(stepUp.id);
        }}
      />
    </div>
  );
}

export function McpManagementButton() {
  const [open, setOpen] = useState(false);
  const { i18n } = useTranslation();
  const title = i18n.language.startsWith("zh") ? "MCP 管理" : "MCP management";
  return (
    <>
      <Button
        className="mb-4 w-full"
        variant="outline"
        onClick={() => setOpen(true)}
      >
        <Plug className="mr-2 size-4" />
        {title}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[92vh] w-[96vw] overflow-y-auto sm:max-w-6xl">
          <DialogTitle className="sr-only">{title}</DialogTitle>
          <DialogDescription className="sr-only">
            HTTP MCP · Cursor · Codex
          </DialogDescription>
          {open && <McpPanel />}
        </DialogContent>
      </Dialog>
    </>
  );
}
