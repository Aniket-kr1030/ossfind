import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComponentCandidateSchema } from "../contracts/index.js";
import { DefaultEmbeddingsProvider, type EmbeddingsProvider } from "../fit/embeddings.js";
import type { IndexRecord } from "../index/corpus.js";
import { buildIndex, openIndex } from "../index/local-index.js";
import { LocalIndexDiscoverer } from "./local-index-discovery.js";

const directories: string[] = [];
let discoverer: LocalIndexDiscoverer;
let dbPath: string;

async function fixtureRecords(): Promise<IndexRecord[]> {
  const fixture = new URL("../../fixtures/index/pypi-sample.json", import.meta.url);
  return JSON.parse(await readFile(fixture, "utf8")) as IndexRecord[];
}

beforeEach(async () => {
  const directory = await mkdtemp(join(tmpdir(), "ossfind-local-discovery-"));
  directories.push(directory);
  dbPath = join(directory, "pypi.db");
  buildIndex(dbPath, await fixtureRecords());
  discoverer = new LocalIndexDiscoverer("pypi", dbPath);
});

afterEach(async () => {
  discoverer.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("LocalIndexDiscoverer", () => {
  it("uses hybrid recall for vector-enabled indexes", async () => {
    const records: IndexRecord[] = [
      {
        ecosystem: "pypi",
        name: "diffusers",
        description: "Generative toolkit for creating visual clips from text prompts.",
        keywords: ["diffusion", "generative-ai", "text-to-image"],
        downloads: 1,
      },
      {
        ecosystem: "pypi",
        name: "dateparser",
        description: "Parse dates in natural language and multiple locales.",
        keywords: ["date", "parsing", "datetime"],
        downloads: 1,
      },
    ];
    const embedder = new DefaultEmbeddingsProvider();

    discoverer.close();
    await buildIndex(dbPath, records, { embedder });

    const index = openIndex(dbPath);
    expect(index.search("video generation", { ecosystem: "pypi" })).toEqual([]);
    index.close();

    discoverer = new LocalIndexDiscoverer("pypi", dbPath, 25, embedder);
    await expect(discoverer.discover("video generation")).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "pypi:diffusers" }),
    ]));
  });

  it("uses BM25 without initializing an embedder for FTS-only indexes", async () => {
    let embeds = 0;
    const unavailableEmbedder: EmbeddingsProvider = {
      async embed(): Promise<number[][]> {
        embeds += 1;
        throw new Error("model unavailable");
      },
    };

    discoverer.close();
    discoverer = new LocalIndexDiscoverer("pypi", dbPath, 25, unavailableEmbedder);

    await expect(discoverer.discover("video editing")).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "pypi:moviepy" }),
    ]));
    expect(embeds).toBe(0);
  });

  it("falls back to BM25 when query embedding fails", async () => {
    const embedder = new DefaultEmbeddingsProvider();
    const failingEmbedder: EmbeddingsProvider = {
      async embed(): Promise<number[][]> {
        throw new Error("model unavailable");
      },
    };

    discoverer.close();
    await buildIndex(dbPath, await fixtureRecords(), { embedder });
    discoverer = new LocalIndexDiscoverer("pypi", dbPath, 25, failingEmbedder);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(discoverer.discover("video editing")).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "pypi:moviepy" }),
        expect.objectContaining({ id: "pypi:ffmpeg-python" }),
      ]));
      await expect(discoverer.discover("video")).resolves.toEqual(expect.any(Array));
      expect(warning).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockRestore();
    }
  });

  it("maps fixture-index records into schema-valid PyPI candidates", async () => {
    const candidates = await discoverer.discover("video editing");

    expect(candidates.map((candidate) => candidate.id)).toEqual(expect.arrayContaining([
      "pypi:moviepy",
      "pypi:ffmpeg-python",
    ]));
    for (const candidate of candidates) {
      expect(ComponentCandidateSchema.parse(candidate)).toEqual(candidate);
    }
  });

  it.each(["c++", "a AND b", "\"quote", "video-editing", "", "*", "foo OR NOT bar"])(
    "does not throw for hostile input %j",
    async (query) => {
      await expect(discoverer.discover(query)).resolves.toEqual(expect.any(Array));
    },
  );

  it("reports a missing index as unavailable and returns an empty result", async () => {
    const missing = new LocalIndexDiscoverer("pypi", join(tmpdir(), "no-such-ossfind-index.db"));

    expect(missing.isAvailable()).toBe(false);
    await expect(missing.discover("video editing")).resolves.toEqual([]);
  });

  it("reports an unreadable index as unavailable instead of throwing", async () => {
    const directory = directories.at(-1);
    if (!directory) throw new Error("test index directory was not created");
    const dbPath = join(directory, "invalid.db");
    await writeFile(dbPath, "not a SQLite database");
    const invalid = new LocalIndexDiscoverer("pypi", dbPath);

    expect(invalid.isAvailable()).toBe(false);
    await expect(invalid.discover("video editing")).resolves.toEqual([]);
  });

  it("caches each query in memory", async () => {
    const first = discoverer.discover("video editing");
    expect(discoverer.discover("video editing")).toBe(first);
    await expect(first).resolves.toEqual(expect.any(Array));
  });
});
