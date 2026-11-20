/**
 * What: the sidebar preserves desktop geometry while behaving like a touch-first
 * navigation drawer on narrow screens.
 * Why: the app shell must not overflow mobile viewports or leave navigation
 * covering the destination a user just selected.
 * @vitest-environment jsdom
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "./sidebar.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("sidebar layout", () => {
  it("allows the main content column to shrink within the shell", () => {
    render(<SidebarInset>Content</SidebarInset>);

    expect(screen.getByRole("main").className).toContain("min-w-0");
  });

  it("uses a menu icon and closes the mobile drawer after navigation", async () => {
    setViewportWidth(375);
    const view = render(<MobileSidebarFixture navigationKey="/orders" />);
    const trigger = screen.getByRole("button", { name: "Toggle Sidebar" });

    await waitFor(() => {
      expect(
        trigger.querySelector('[data-sidebar-trigger-icon="menu"]'),
      ).not.toBeNull();
    });

    fireEvent.click(trigger);
    const drawer = await screen.findByRole("dialog");
    expect(drawer.className).toContain("[&>button]:size-11");
    expect(drawer.className).toContain("data-[state=open]:duration-[260ms]");

    fireEvent.click(screen.getByRole("link", { name: "Orders" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    fireEvent.click(trigger);
    expect(await screen.findByRole("dialog")).toBeDefined();

    view.rerender(<MobileSidebarFixture navigationKey="/tickets" />);

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("draws the drawer close button in the drawer colours, not the page surface", async () => {
    setViewportWidth(375);
    render(<MobileSidebarFixture navigationKey="/orders" />);

    fireEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
    const drawer = await screen.findByRole("dialog");

    expect(screen.getByRole("button", { name: "Close" })).toBeDefined();
    expect(drawer.className).toContain("[&>button]:text-sidebar-foreground");
    expect(drawer.className).toContain("[&>button]:bg-transparent");
    expect(drawer.className).toContain("[&>button]:border-transparent");
  });

  it("keeps the desktop rail icon and desktop collapse state", async () => {
    setViewportWidth(1280);
    render(<MobileSidebarFixture navigationKey="/orders" />);
    const trigger = screen.getByRole("button", { name: "Toggle Sidebar" });

    await waitFor(() => {
      expect(
        trigger.querySelector('[data-sidebar-trigger-icon="panel"]'),
      ).not.toBeNull();
    });

    fireEvent.click(trigger);
    expect(
      document
        .querySelector('[data-slot="sidebar"]')
        ?.getAttribute("data-state"),
    ).toBe("collapsed");
  });

  it("clips sideways overflow so expanding the rail cannot flash a scrollbar", () => {
    setViewportWidth(1280);
    render(
      <SidebarProvider>
        <Sidebar>
          <SidebarContent>Nav</SidebarContent>
        </Sidebar>
      </SidebarProvider>,
    );

    const content = document.querySelector('[data-slot="sidebar-content"]');
    expect(content?.className).toContain("overflow-x-hidden");
    expect(content?.className).toContain("overflow-y-auto");
    expect(content?.className).not.toContain(
      "group-data-[collapsible=icon]:overflow-hidden",
    );
    expect(content?.className).toContain("gap-4");
    expect(content?.className).toContain("group-data-[collapsible=icon]:gap-2");
  });

  it("does not stack group padding on the content gap", () => {
    setViewportWidth(1280);
    render(
      <SidebarProvider>
        <Sidebar>
          <SidebarGroup>
            <SidebarGroupLabel>Operate</SidebarGroupLabel>
          </SidebarGroup>
        </Sidebar>
      </SidebarProvider>,
    );

    const group = document.querySelector('[data-slot="sidebar-group"]');
    const label = document.querySelector('[data-slot="sidebar-group-label"]');
    expect(group?.className).toContain("px-2");
    expect(group?.className).not.toContain("p-2");
    expect(label?.className).toContain("pb-1");
    expect(label?.className).not.toContain("h-8");
    expect(label?.className).toContain("text-xs");
    expect(label?.className).toContain("font-semibold");
    expect(label?.className).toContain("uppercase");
    expect(label?.className).toContain("tracking-wider");
    expect(label?.className).toContain("text-sidebar-foreground/80");
    expect(label?.className).not.toContain("text-sm");
    expect(label?.className).toContain("group-data-[collapsible=icon]:hidden");
  });

  it("gives navigation rows a mobile touch target without changing desktop height", () => {
    setViewportWidth(1280);
    render(
      <SidebarProvider>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton>Orders</SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarProvider>,
    );

    const row = screen.getByRole("button", { name: "Orders" });
    expect(row.className).toContain("in-data-[mobile=true]:min-h-11");
    expect(row.className).toContain("md:h-8");
  });
});

function MobileSidebarFixture({
  navigationKey,
}: {
  readonly navigationKey: string;
}) {
  return (
    <SidebarProvider mobileNavigationKey={navigationKey}>
      <SidebarTrigger />
      <Sidebar>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild closeMobileOnClick>
              <a href="#orders">Orders</a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </Sidebar>
    </SidebarProvider>
  );
}

function setViewportWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
  vi.stubGlobal("matchMedia", () => ({
    matches: width < 768,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}
