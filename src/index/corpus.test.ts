import { afterEach, describe, expect, it, vi } from "vitest";
import type { HttpClient } from "../http/client.js";
import { fetchCorpus } from "./corpus.js";

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe("fetchCorpus", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("pages the download-ranked registry and maps only usable package records", async () => {
    const urls: URL[] = [];
    const http: HttpClient = async (rawUrl) => {
      const url = new URL(rawUrl);
      urls.push(url);
      if (url.searchParams.get("page") === "1") {
        return response([
          {
            name: "moviepy",
            description: "Video editing",
            keywords_array: ["video", "editing", 17],
            downloads: 1234,
            repository_url: "https://github.com/Zulko/moviepy",
            homepage: "https://zulko.github.io/moviepy/",
            latest_release_number: "2.2.1",
          },
          { description: "packages without names cannot be indexed" },
        ]);
      }
      return response([]);
    };

    await expect(fetchCorpus({ ecosystem: "pypi", max: 10, http })).resolves.toEqual([
      {
        ecosystem: "pypi",
        name: "moviepy",
        description: "Video editing",
        keywords: ["video", "editing"],
        downloads: 1234,
        repoUrl: "https://github.com/Zulko/moviepy",
        homepage: "https://zulko.github.io/moviepy/",
        latestVersion: "2.2.1",
      },
    ]);
    expect(urls).toHaveLength(2);
    expect(urls[0].pathname).toBe("/api/v1/registries/pypi.org/packages");
    expect(urls[0].searchParams.get("sort")).toBe("downloads");
    expect(urls[0].searchParams.get("order")).toBe("desc");
    expect(urls[0].searchParams.get("per_page")).toBe("100");
  });

  it("honors max and the INDEX_MAX default without touching a further page", async () => {
    vi.stubEnv("INDEX_MAX", "2");
    const http = vi.fn<HttpClient>(async () => response([
      { name: "first", downloads: 10 },
      { name: "second", downloads: 9 },
      { name: "third", downloads: 8 },
    ]));

    const records = await fetchCorpus({ ecosystem: "npm", http });

    expect(records.map((record) => record.name)).toEqual(["first", "second"]);
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ ecosystem: "npm", description: "", keywords: [], downloads: 10 }),
    ]));
    expect(http).toHaveBeenCalledTimes(1);
    expect(new URL(http.mock.calls[0][0]).pathname).toBe("/api/v1/registries/npmjs.org/packages");
  });

  it("backs off and retries a rate-limited page", async () => {
    const http = vi.fn<HttpClient>()
      .mockResolvedValueOnce(response({}, 429))
      .mockResolvedValueOnce(response([{ name: "available-after-retry" }]))
      .mockResolvedValueOnce(response([]));

    await expect(fetchCorpus({ ecosystem: "pypi", max: 2, http })).resolves.toEqual([
      expect.objectContaining({ name: "available-after-retry" }),
    ]);
    expect(http).toHaveBeenCalledTimes(3);
  });
});
