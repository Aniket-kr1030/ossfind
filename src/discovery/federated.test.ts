import { describe, expect, it, vi } from "vitest";
import type { ComponentCandidate } from "../contracts/index.js";
import type { Discoverer } from "../pipeline/interfaces.js";
import { FederatedDiscoverer } from "./federated.js";

function candidate(name: string): ComponentCandidate {
  return {
    id: `npm:${name}`,
    name,
    ecosystem: "npm",
    description: `${name} description`,
  };
}

function discoverer(candidates: ComponentCandidate[]): Discoverer {
  return { discover: vi.fn().mockResolvedValue(candidates) };
}

describe("FederatedDiscoverer", () => {
  it("round-robins sources, deduplicates by id, and applies the total limit deterministically", async () => {
    const first = discoverer([candidate("a"), candidate("shared"), candidate("c")]);
    const second = discoverer([
      candidate("b"),
      { ...candidate("shared"), description: "second shared description" },
      candidate("d"),
    ]);
    const federation = new FederatedDiscoverer([
      { name: "first", discoverer: first },
      { name: "second", discoverer: second },
    ], { perSourceLimit: 3, totalLimit: 3 });

    await expect(federation.discover("video editing")).resolves.toHaveLength(3);
    await expect(federation.discover("video editing")).resolves.toMatchObject([
      { id: "npm:a", description: "a description" },
      { id: "npm:b", description: "b description" },
      { id: "npm:shared", description: "shared description" },
    ]);
    expect(first.discover).toHaveBeenCalledWith("video editing");
    expect(second.discover).toHaveBeenCalledWith("video editing");
  });

  it("isolates a failed source and warns for that source only once", async () => {
    const warn = vi.fn();
    const failure: Discoverer = {
      discover: vi.fn(() => { throw new Error("credential=secret"); }),
    };
    const healthy = discoverer([candidate("healthy")]);
    const federation = new FederatedDiscoverer([
      { name: "failing-source", discoverer: failure },
      { name: "healthy-source", discoverer: healthy },
    ], { warn });

    await expect(federation.discover("video editing")).resolves.toMatchObject([{ id: "npm:healthy" }]);
    await expect(federation.discover("another query")).resolves.toMatchObject([{ id: "npm:healthy" }]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[ossfind] discovery source unavailable: failing-source.");
    expect(warn.mock.calls.flat().join(" ")).not.toContain("secret");
  });

  it("reports and skips structurally unavailable sources without treating them as empty searches", async () => {
    const unavailable = {
      isAvailable: () => false,
      discover: vi.fn().mockResolvedValue([candidate("should-not-run")]),
    };
    const federation = new FederatedDiscoverer([{ name: "optional-source", discoverer: unavailable }]);

    await expect(federation.discover("nothing")).resolves.toEqual([]);
    expect(unavailable.discover).not.toHaveBeenCalled();
    expect(federation.availability()).toEqual({
      available: false,
      sources: [{ name: "optional-source", available: false }],
    });
  });

  it("keeps a genuine empty result distinct when a source was available", async () => {
    const available = {
      isAvailable: () => true,
      discover: vi.fn().mockResolvedValue([]),
    };
    const federation = new FederatedDiscoverer([{ name: "searched-source", discoverer: available }]);

    await expect(federation.discover("nothing")).resolves.toEqual([]);
    expect(available.discover).toHaveBeenCalledWith("nothing");
    expect(federation.availability()).toEqual({
      available: true,
      sources: [{ name: "searched-source", available: true }],
    });
  });
});
