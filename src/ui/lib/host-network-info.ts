import type { HostNetworkInfo } from "@/types/index";

type Translate = (key: string) => string;

export function countryText(info: HostNetworkInfo): string {
  const code = info.countryCode?.trim().toUpperCase();
  const country = info.country?.trim();
  return [code, country].filter(Boolean).join(" ");
}

export function locationText(
  info: HostNetworkInfo | null | undefined,
  t: Translate,
): string {
  if (!info) return t("hosts.networkUnknown");
  if (info.status === "private") return t("hosts.networkPrivate");
  if (info.status === "pending") return t("hosts.networkLookupPending");
  if (info.status !== "ready") {
    return t("hosts.networkUnknown");
  }

  const country = countryText(info);
  const locality = info.city?.trim() || info.region?.trim();
  return (
    [country, locality].filter(Boolean).join(" · ") || t("hosts.networkUnknown")
  );
}

export function ispText(
  info: HostNetworkInfo | null | undefined,
  t: Translate,
): string {
  if (!info) return t("hosts.networkUnknown");
  if (info.status === "private") return t("hosts.networkNotApplicable");
  if (info.status === "pending") return t("hosts.networkLookupPending");
  if (info.status !== "ready") {
    return t("hosts.networkUnknown");
  }
  return info.isp?.trim() || t("hosts.networkUnknown");
}

/** 地区查询异步完成前短暂轮询主机列表，完成后立即停止。 */
export function hasPendingHostNetworkInfo(
  hosts: Array<{ networkInfo?: HostNetworkInfo | null }>,
): boolean {
  return hosts.some((host) => host.networkInfo?.status === "pending");
}
