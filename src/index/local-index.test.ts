import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultEmbeddingsProvider } from "../fit/embeddings.js";
import type { IndexRecord } from "./corpus.js";
import { buildIndex, openIndex, sanitizeFtsQuery, type LocalIndex } from "./local-index.js";

const directories: string[] = [];
let index: LocalIndex;

async function fixtureRecords(): Promise<IndexRecord[]> {
  const fixture = new URL("../../fixtures/index/pypi-sample.json", import.meta.url);
  return JSON.parse(await readFile(fixture, "utf8")) as IndexRecord[];
}

beforeEach(async () => {
  const directory = await mkdtemp(join(tmpdir(), "ossfind-index-"));
  directories.push(directory);
  const dbPath = join(directory, "pypi.db");
  buildIndex(dbPath, await fixtureRecords());
  index = openIndex(dbPath);
});

afterEach(async () => {
  index.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("local FTS5 index", () => {
  it("reports that an FTS-only index has no stored vectors and hybrid safely falls back to BM25", async () => {
    const embedder = new DefaultEmbeddingsProvider();
    const queryVector = (await embedder.embed(["date parsing"]))[0];
    const expected = index.search("date parsing", { ecosystem: "pypi" });

    expect(index.hasVectors()).toBe(false);
    expect(index.searchHybrid("date parsing", queryVector, { ecosystem: "pypi" })).toEqual(expected);
    expect(() => index.searchHybrid("foo OR NOT bar", queryVector, { ecosystem: "pypi" })).not.toThrow();
  });

  it("recalls a vocabulary-gap package with hashing vectors and hybrid search", async () => {
    const directory = directories.at(-1);
    if (!directory) throw new Error("test index directory was not created");

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
      {
        ecosystem: "pypi",
        name: "requests",
        description: "HTTP library for web clients.",
        keywords: ["http", "client", "web"],
        downloads: 1,
      },
      {
        ecosystem: "pypi",
        name: "pandas",
        description: "Data structures and analysis tools.",
        keywords: ["data", "analysis", "dataframe"],
        downloads: 1,
      },
    ];
    const query = "video generation";
    const embedder = new DefaultEmbeddingsProvider();

    index.close();
    await buildIndex(join(directory, "pypi.db"), records, { embedder });
    index = openIndex(join(directory, "pypi.db"));

    const queryVector = (await embedder.embed([query]))[0];
    expect(index.hasVectors()).toBe(true);
    expect(index.search(query, { ecosystem: "pypi" })).toEqual([]);
    expect(index.searchVector(queryVector, { ecosystem: "pypi", limit: 1 }).map((record) => record.name))
      .toEqual(["diffusers"]);
    expect(index.searchHybrid(query, Float32Array.from(queryVector), { ecosystem: "pypi", limit: 1 }).map((record) => record.name))
      .toEqual(["diffusers"]);
  });

  it("replaces an existing index on rebuild", async () => {
    const directory = directories.at(-1);
    if (!directory) throw new Error("test index directory was not created");

    index.close();
    buildIndex(join(directory, "pypi.db"), [(await fixtureRecords())[4]]);
    index = openIndex(join(directory, "pypi.db"));

    expect(index.search("http", { ecosystem: "pypi" }).map((result) => result.name))
      .toEqual(["requests"]);
    expect(index.search("video", { ecosystem: "pypi" })).toEqual([]);
  });

  it("ranks video packages above an unrelated encoding package and returns complete records", () => {
    const results = index.search("video encoding", { ecosystem: "pypi" });
    const names = results.map((result) => result.name);
    const htmlEncoding = names.indexOf("html-encoding-sniffer");

    expect(names).toContain("ffmpeg-python");
    expect(names).toContain("moviepy");
    expect(names.indexOf("ffmpeg-python")).toBeLessThan(htmlEncoding);
    expect(names.indexOf("moviepy")).toBeLessThan(htmlEncoding);
    expect(results.find((result) => result.name === "ffmpeg-python")).toMatchObject({
      downloads: 1_820_000,
      repoUrl: "https://github.com/kkroening/ffmpeg-python",
      homepage: "https://github.com/kkroening/ffmpeg-python",
      latestVersion: "0.2.0",
    });
  });

  it("finds dateparser for date parsing", () => {
    expect(index.search("date parsing", { ecosystem: "pypi" }).map((result) => result.name))
      .toContain("dateparser");
  });

  it.each(["c++", "a AND b", "\"quote", "video-editing", "", "*", "foo OR NOT bar"])(
    "safely handles hostile FTS input %j",
    (query) => {
      expect(() => index.search(query, { ecosystem: "pypi" })).not.toThrow();
    },
  );

  it("uses only quoted alphanumeric terms in FTS5 MATCH expressions", () => {
    expect(sanitizeFtsQuery("video-editing AND c++ \"quote *")).toBe(
      "\"video\" OR \"editing\" OR \"AND\" OR \"c\" OR \"quote\"",
    );
    expect(sanitizeFtsQuery("***")).toBe("");
  });
});
