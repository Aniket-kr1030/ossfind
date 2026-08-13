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
});
