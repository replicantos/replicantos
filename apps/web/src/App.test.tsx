import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App.js";

afterEach(cleanup);

describe("ReplicantOS application shell", () => {
  it("starts on the synthetic chat workspace", () => {
    render(<App />);
    expect(
      screen.getByRole("heading", { name: "#product" }),
    ).toBeInTheDocument();
    expect(screen.getByText("SYNTHETIC DATA")).toBeInTheDocument();
  });

  it("opens the protected database view without exposing credential tables", () => {
    render(<App />);
    fireEvent.click(screen.getAllByRole("button", { name: /database/i })[0]!);
    expect(screen.getAllByText("SAFE TABLES").length).toBeGreaterThan(0);
    expect(
      screen.getByText(/Credential and session tables are excluded/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /credentials/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps the screenshot workspace aligned with implemented v0.1 surfaces", () => {
    render(<App />);
    expect(
      screen.queryByRole("button", { name: /attach/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/validating the archive/i),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/POLLING FOR REPLIES/i)).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: /library/i })[0]!);
    expect(
      screen.getByRole("button", { name: "INDEX / REINDEX" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /upload/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("JSON")).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: /database/i })[0]!);
    expect(screen.getByText(/ALLOWLIST workspaces/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /run query/i }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: /settings/i })[0]!);
    expect(screen.getAllByText("NOT CHECKED")).toHaveLength(4);
    expect(screen.queryByText(/DOCTOR PASSED/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /configure/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Backup & export")).not.toBeInTheDocument();
    expect(screen.queryByText("Night Watch")).not.toBeInTheDocument();
  });
});
