import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

import { StatsBarCard } from "../../dashboard/DashboardTab";

afterEach(cleanup);

describe("Dashboard version update entry", () => {
  it("opens online updates when an administrator clicks the version card", () => {
    const onOpenUpdates = vi.fn();

    render(
      <StatsBarCard
        hosts={[]}
        uptimeFormatted="1h"
        versionText="2.6.0-cloudssh.25"
        versionStatus="requires_update"
        dbHealth="healthy"
        onOpenUpdates={onOpenUpdates}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "admin.sectionUpdates" }),
    );
    expect(onOpenUpdates).toHaveBeenCalledOnce();
  });

  it("keeps the version card read-only without update permission", () => {
    render(
      <StatsBarCard
        hosts={[]}
        uptimeFormatted="1h"
        versionText="2.6.0-cloudssh.25"
        versionStatus="up_to_date"
        dbHealth="healthy"
      />,
    );

    expect(
      screen
        .getByRole("button", { name: "dashboard.version" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });
});
