import { cn } from "@/lib/utils";
import { getPersistedHostId, type HostId } from "@/lib/host-id";

export function HostIdBadge({
  hostId,
  className,
}: {
  hostId: HostId;
  className?: string;
}) {
  const id = getPersistedHostId(hostId);
  if (!id) return null;

  return (
    <span
      className={cn(
        "inline-flex shrink-0 whitespace-nowrap font-mono text-[10px] font-normal text-muted-foreground",
        className,
      )}
    >
      {`#${id}`}
    </span>
  );
}
