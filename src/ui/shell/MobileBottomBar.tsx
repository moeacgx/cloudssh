import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Bot,
  Clock,
  Hammer,
  KeyRound,
  LayoutPanelLeft,
  MoreHorizontal,
  Play,
  Server,
  Settings,
  User,
  Zap,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/dropdown-menu";
import type { RailView } from "@/sidebar/AppRail";
import type { SplitMode } from "@/types/ui-types";

const PRIMARY_ITEMS: {
  view: RailView;
  icon: React.ReactNode;
  titleKey: string;
}[] = [
  { view: "hosts", icon: <Server className="size-5" />, titleKey: "nav.hosts" },
  {
    view: "quick-connect",
    icon: <Zap className="size-5" />,
    titleKey: "nav.quickConnect",
  },
  {
    view: "ssh-tools",
    icon: <Hammer className="size-5" />,
    titleKey: "nav.sshTools",
  },
  {
    view: "snippets",
    icon: <Play className="size-5" />,
    titleKey: "nav.snippets",
  },
];

const MORE_ITEMS: {
  view: RailView;
  icon: React.ReactNode;
  titleKey: string;
}[] = [
  {
    view: "credentials",
    icon: <KeyRound className="size-4" />,
    titleKey: "nav.credentials",
  },
  {
    view: "history",
    icon: <Clock className="size-4" />,
    titleKey: "nav.history",
  },
  {
    view: "split-screen",
    icon: <LayoutPanelLeft className="size-4" />,
    titleKey: "nav.splitScreen",
  },
  {
    view: "user-profile",
    icon: <User className="size-4" />,
    titleKey: "nav.userProfile",
  },
  {
    view: "admin-settings",
    icon: <Settings className="size-4" />,
    titleKey: "nav.admin",
  },
  {
    view: "agent-integration",
    icon: <Bot className="size-4" />,
    titleKey: "nav.agentIntegration",
  },
];

export function MobileBottomBar({
  railView,
  sidebarOpen,
  splitMode,
  onRailClick,
}: {
  railView: RailView;
  sidebarOpen: boolean;
  splitMode: SplitMode;
  onRailClick: (view: RailView) => void;
}) {
  const { t } = useTranslation();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreActive = MORE_ITEMS.some((i) => i.view === railView) && sidebarOpen;

  return (
    <div className="md:hidden flex items-stretch shrink-0 bg-sidebar border-t border-border safe-bottom">
      {PRIMARY_ITEMS.map((item) => {
        const active = sidebarOpen && railView === item.view;
        const hasDot = item.view === "split-screen" && splitMode !== "none";
        return (
          <button
            key={item.view}
            onClick={() => onRailClick(item.view)}
            className={`relative flex flex-col items-center justify-center flex-1 gap-0.5 py-2 min-h-[56px] transition-colors text-[10px] font-medium
              ${active ? "text-accent-brand" : "text-muted-foreground"}`}
          >
            {item.icon}
            <span>{t(item.titleKey)}</span>
            {hasDot && (
              <span className="absolute top-1.5 right-[calc(50%-10px)] size-1.5 rounded-full bg-accent-brand" />
            )}
          </button>
        );
      })}

      <DropdownMenu open={moreOpen} onOpenChange={setMoreOpen}>
        <DropdownMenuTrigger asChild>
          <button
            className={`relative flex flex-col items-center justify-center flex-1 gap-0.5 py-2 min-h-[56px] transition-colors text-[10px] font-medium
              ${moreActive ? "text-accent-brand" : "text-muted-foreground"}`}
          >
            <MoreHorizontal className="size-5" />
            <span>{t("common.more")}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="end"
          className="mb-1 min-w-[180px]"
        >
          {MORE_ITEMS.map((item, i) => {
            const active = sidebarOpen && railView === item.view;
            if (
              (item.view === "user-profile" ||
                item.view === "agent-integration") &&
              i > 0
            ) {
              return (
                <React.Fragment key={item.view}>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => {
                      onRailClick(item.view);
                      setMoreOpen(false);
                    }}
                    className={active ? "text-accent-brand" : ""}
                  >
                    {item.icon}
                    {t(item.titleKey)}
                  </DropdownMenuItem>
                </React.Fragment>
              );
            }
            return (
              <DropdownMenuItem
                key={item.view}
                onClick={() => {
                  onRailClick(item.view);
                  setMoreOpen(false);
                }}
                className={active ? "text-accent-brand" : ""}
              >
                {item.icon}
                {t(item.titleKey)}
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={() => window.dispatchEvent(new Event("termix:logout"))}
          >
            <KeyRound className="size-4" />
            {t("common.logout")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
