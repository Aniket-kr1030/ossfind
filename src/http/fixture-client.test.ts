import { describe, expect, it } from "vitest";
import { createFixtureHttpClient } from "./fixture-client.js";

describe("createFixtureHttpClient", () => {
  it("maps libraries.io PyPI searches by q while ignoring credentials and page size", async () => {
    const client = createFixtureHttpClient();
    const response = await client(
      "https://libraries.io/api/search?q=video+editing&platforms=Pypi&per_page=100&api_key=fixture",
    );

    expect(response.ok).toBe(true);
    await expect(response.json()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "moviepy", platform: "Pypi" })]),
    );
  });

  it("maps GitHub repository searches and deps.dev project scorecards", async () => {
    const client = createFixtureHttpClient();
    const search = await client(
      "https://api.github.com/search/repositories?q=video+generation&sort=stars&order=desc&per_page=20",
    );
    const scorecard = await client(
      "https://api.deps.dev/v3/projects/github.com%2Fhuggingface%2Fdiffusers",
    );
    const missing = await client(
      "https://api.deps.dev/v3/projects/github.com%2Fzai-org%2FCogVideo",
    );

    expect(search.ok).toBe(true);
    await expect(search.json()).resolves.toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ full_name: "huggingface/diffusers" })]),
    });
    expect(scorecard.ok).toBe(true);
    expect(missing.status).toBe(404);
  });
});
