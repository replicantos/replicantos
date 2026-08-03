import { expect, type Page } from "@playwright/test";

const forbiddenTextPatterns = [
  {
    label: "absolute macOS home path",
    value: new RegExp(
      ["/", "Users", "/", "[A-Za-z0-9._-]+", "/"].join(""),
      "u",
    ),
  },
  {
    label: "absolute Linux home path",
    value: new RegExp(["/", "home", "/", "[A-Za-z0-9._-]+", "/"].join(""), "u"),
  },
  {
    label: "JWT-like token",
    value: /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/u,
  },
  {
    label: "provider key-like token",
    value: /\b(?:sk-(?:proj-)?|sk-ant-|xai-)[A-Za-z0-9_-]{20,}\b/u,
  },
];

export async function expectSyntheticDom(page: Page) {
  const text = await page.locator("body").innerText();
  for (const pattern of forbiddenTextPatterns) {
    expect(text, `DOM contained ${pattern.label}`).not.toMatch(pattern.value);
  }

  const emailMatches =
    text.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu) ?? [];
  expect(
    emailMatches.filter((email) => !email.endsWith("@example.invalid")),
  ).toEqual([]);
}
