import type { RequestHandler } from "express";
import { isValidFileManagerSessionId } from "./session.js";

function nonEmptyText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !value.includes("\0")
  );
}

/** 先校验连接参数形状，避免错误类型流入 DNS、SSH 和主机解析。 */
export const validateFileManagerConnectInput: RequestHandler = (
  req,
  res,
  next,
) => {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    res.status(400).json({ error: "Invalid SSH connection parameters" });
    return;
  }
  const { sessionId, ip, port, username, hostId, projectHostId } = body;
  const validHostId =
    hostId === undefined ||
    ((typeof hostId === "number" ||
      (typeof hostId === "string" && /^-?\d+$/.test(hostId))) &&
      Number.isSafeInteger(Number(hostId)));
  if (
    !isValidFileManagerSessionId(sessionId) ||
    !nonEmptyText(ip) ||
    !nonEmptyText(username) ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !validHostId ||
    (projectHostId !== undefined &&
      (!Number.isSafeInteger(projectHostId) || projectHostId <= 0))
  ) {
    res.status(400).json({ error: "Invalid SSH connection parameters" });
    return;
  }
  next();
};
