import { afterEach, describe, expect, it, vi } from "vitest";
import { ComponentCandidateSchema } from "../contracts/index.js";
import { createFixtureHttpClient } from "../http/fixture-client.js";
import { LibrariesIoDiscoverer } from "./libraries-discovery.js";

const originalLibrariesIoKey = process.env.LIBRARIES_IO_API_KEY;
const originalLibraryIoKey = process.env.LIBRARY_IO_API_KEY;

afterEach(() => {
  if (originalLibrariesIoKey === undefined) delete process.env.LIBRARIES_IO_API_KEY;
  else process.env.LIBRARIES_IO_API_KEY = originalLibrariesIoKey;
  if (originalLibraryIoKey === undefined) delete process.env.LIBRARY_IO_API_KEY;
  else process.env.LIBRARY_IO_API_KEY = originalLibraryIoKey;
});

describe("LibrariesIoDiscoverer", () => {
  it("maps frozen PyPI search results into schema-valid candidates", async () => {
    const candidates = await new LibrariesIoDiscoverer(createFixtureHttpClient(), { apiKey: "fixture" })
      .discover("video editing");

    expect(candidates.some((candidate) => candidate.id === "pypi:moviepy")).toBe(true);
    expect(candidates.find((candidate) => candidate.id === "pypi:moviepy")?.keywords)
      .toContain("video-editing");
    for (const candidate of candidates) {
      expect(candidate.id).toMatch(/^pypi:.+/);
      expect(ComponentCandidateSchema.parse(candidate)).toEqual(candidate);
    }
  });

  it("returns a degraded result once when no key is configured", async () => {
    delete process.env.LIBRARIES_IO_API_KEY;
    delete process.env.LIBRARY_IO_API_KEY;
    const warn = vi.fn();
    const discoverer = new LibrariesIoDiscoverer(undefined, { warn });

    expect(discoverer.isAvailable()).toBe(false);
    await expect(discoverer.discover("video editing")).resolves.toEqual([]);
    await expect(discoverer.discover("another query")).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("accepts the legacy singular environment variable", async () => {
    delete process.env.LIBRARIES_IO_API_KEY;
    process.env.LIBRARY_IO_API_KEY = "fixture";

    const discoverer = new LibrariesIoDiscoverer(createFixtureHttpClient());
    expect(discoverer.isAvailable()).toBe(true);
    await expect(discoverer.discover("video editing"))
      .resolves.toContainEqual(expect.objectContaining({ id: "pypi:moviepy" }));
  });
});
