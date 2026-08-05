import type { Request } from "express";

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase();
  if (normalized === "::1") return true;
  const ipv4 = normalized.startsWith("::ffff:")
    ? normalized.slice("::ffff:".length)
    : normalized;
  return /^127(?:\.\d{1,3}){3}$/.test(ipv4);
}

export function isAdministrativeTransportAllowed(
  request: Pick<Request, "secure" | "ip">,
  environment = process.env.NODE_ENV,
): boolean {
  if (environment !== "production") return true;
  return request.secure || isLoopbackAddress(request.ip);
}

export function trustLoopbackProxy(address: string, hop: number): boolean {
  if (hop !== 0) return false;
  return isLoopbackAddress(address);
}
