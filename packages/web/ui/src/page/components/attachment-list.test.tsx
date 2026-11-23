/**
 * What: the attachment list shows stored files with a real open button and a
 * sibling Download button, plus empty, loading, and busy states.
 * Why: opening and downloading are different promises; a click on one must
 * never trigger the other, and both need names that include the file.
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AttachmentItem } from "../../elements/index.js";

import { AttachmentList } from "./attachment-list.js";

afterEach(() => {
  cleanup();
});

const manual: AttachmentItem = {
  id: "file-1",
  fileName: "manual.pdf",
  contentType: "application/pdf",
  byteSize: 25_000,
};

describe("AttachmentList", () => {
  it("shows each file's name and a readable type and size", () => {
    render(<AttachmentList items={[manual]} onDownload={vi.fn()} />);

    expect(screen.getByText("manual.pdf")).toBeDefined();
    expect(screen.getByText(/PDF\s*·\s*25(\.0)? ?(kB|KB|kilobytes?)/i)).toBeDefined();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it("opens from the name button and never downloads", () => {
    const onOpen = vi.fn();
    const onDownload = vi.fn();
    render(<AttachmentList items={[manual]} onOpen={onOpen} onDownload={onDownload} />);

    fireEvent.click(screen.getByRole("button", { name: "Open manual.pdf" }));

    expect(onOpen).toHaveBeenCalledWith(manual);
    expect(onDownload).not.toHaveBeenCalled();
  });

  it("describes the open button with the file's type and size", () => {
    render(<AttachmentList items={[manual]} onOpen={vi.fn()} onDownload={vi.fn()} />);

    const button = screen.getByRole("button", { name: "Open manual.pdf" });
    const descriptionId = button.getAttribute("aria-describedby") ?? "";

    expect(document.getElementById(descriptionId)?.textContent).toMatch(/PDF\s*·\s*25(\.0)? ?(kB|KB|kilobytes?)/i);
  });

  it("downloads from its own button and never opens", () => {
    const onOpen = vi.fn();
    const onDownload = vi.fn();
    render(<AttachmentList items={[manual]} onOpen={onOpen} onDownload={onDownload} />);

    fireEvent.click(screen.getByRole("button", { name: "Download manual.pdf" }));

    expect(onDownload).toHaveBeenCalledWith(manual);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("shows plain text and no open button without onOpen", () => {
    render(<AttachmentList items={[manual]} onDownload={vi.fn()} />);

    expect(screen.queryByRole("button", { name: /^Open/ })).toBeNull();
    expect(screen.getByText("manual.pdf")).toBeDefined();
  });

  it("shows the default and a custom empty message", () => {
    const { rerender } = render(<AttachmentList items={[]} onDownload={vi.fn()} />);
    expect(screen.getByText("No files yet")).toBeDefined();

    rerender(<AttachmentList items={[]} onDownload={vi.fn()} emptyMessage="No files attached." />);
    expect(screen.getByText("No files attached.")).toBeDefined();
  });

  it("shows a busy skeleton list while loading", () => {
    render(<AttachmentList items={[manual]} status="loading" onDownload={vi.fn()} />);

    const list = screen.getByRole("list", { name: "Loading files" });
    expect(list.getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByText("manual.pdf")).toBeNull();
  });

  it("marks Download busy while its promise is pending", async () => {
    let finish: () => void = () => undefined;
    const onDownload = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render(<AttachmentList items={[manual]} onDownload={onDownload} />);
    const button = screen.getByRole("button", { name: "Download manual.pdf" });

    fireEvent.click(button);
    expect(button.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(button);
    expect(onDownload).toHaveBeenCalledTimes(1);

    finish();
    await waitFor(() => {
      expect(button.getAttribute("aria-busy")).toBe("false");
    });
  });

  it("clears the busy state when a download rejects", async () => {
    const onDownload = vi.fn(() => Promise.reject(new Error("down")));
    render(<AttachmentList items={[manual]} onDownload={onDownload} />);
    const button = screen.getByRole("button", { name: "Download manual.pdf" });

    fireEvent.click(button);

    await waitFor(() => {
      expect(button.getAttribute("aria-busy")).toBe("false");
    });
  });

  it("renders item actions and the caller's failure", () => {
    render(
      <AttachmentList
        items={[manual]}
        onDownload={vi.fn()}
        itemActions={(item) => <button type="button">Remove {item.fileName}</button>}
        failure={<p role="alert">Could not download.</p>}
      />,
    );

    expect(screen.getByRole("button", { name: "Remove manual.pdf" })).toBeDefined();
    expect(screen.getByRole("alert").textContent).toBe("Could not download.");
  });
});
