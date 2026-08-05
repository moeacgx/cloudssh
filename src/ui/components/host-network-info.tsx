import { MapPin, RadioTower } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { HostNetworkInfo } from "@/types/index";
import { ispText, locationText } from "@/lib/host-network-info";

type HostNetworkInfoLayout = "grid" | "stacked";

export function HostNetworkInfoView({
  networkInfo,
  layout = "grid",
  className = "",
}: {
  networkInfo?: HostNetworkInfo | null;
  layout?: HostNetworkInfoLayout;
  className?: string;
}) {
  const { t } = useTranslation();
  const location = locationText(networkInfo, t);
  const isp = ispText(networkInfo, t);
  const ariaLabel = `${t("hosts.networkLocation")}: ${location}; ${t("hosts.networkIsp")}: ${isp}`;

  return (
    <div
      className={`${
        layout === "stacked"
          ? "flex flex-col gap-0.5"
          : "grid grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] gap-x-2"
      } min-w-0 ${className}`}
      role="group"
      aria-label={ariaLabel}
      title={ariaLabel}
      data-testid="host-network-info"
    >
      <span className="flex min-w-0 items-center gap-1 truncate text-[10px] leading-4 text-muted-foreground/75">
        <MapPin className="size-2.5 shrink-0 text-muted-foreground/55" />
        <span className="truncate">{location}</span>
      </span>
      <span className="flex min-w-0 items-center gap-1 truncate text-[10px] leading-4 text-muted-foreground/75">
        <RadioTower className="size-2.5 shrink-0 text-muted-foreground/55" />
        <span className="truncate">{isp}</span>
      </span>
    </div>
  );
}
