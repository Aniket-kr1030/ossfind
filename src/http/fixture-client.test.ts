import { describe, expect, it } from "vitest";
import { createFixtureHttpClient } from "./fixture-client.js";

describe("createFixtureHttpClient", () => {
  it("maps the frozen attrs wheel as binary data without a network request", async () => {
    const client = createFixtureHttpClient();
    const response = await client(
      "https://files.pythonhosted.org/packages/64/b4/17d4b0b2a2dc85a6df63d1157e028ed19f90d4cd97c36717afef2bc2f395/attrs-26.1.0-py3-none-any.whl",
    );
    const binaryResponse = response as typeof response & { arrayBuffer?: () => Promise<ArrayBuffer> };

    expect(response.ok).toBe(true);
    expect(binaryResponse.arrayBuffer).toBeTypeOf("function");
    const bytes = new Uint8Array(await binaryResponse.arrayBuffer!());
    expect(bytes).toHaveLength(67_548);
    expect([...bytes.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

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

  it("maps Hugging Face model searches by their search query", async () => {
    const client = createFixtureHttpClient();
    const search = await client(
      "https://huggingface.co/api/models?search=video+generation&sort=downloads&direction=-1&limit=20",
    );

    expect(search.ok).toBe(true);
    await expect(search.json()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "Ngvrd/video_generation_model-Q2_K-GGUF" }),
    ]));
  });
});
