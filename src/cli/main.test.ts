import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./main.js";

let out: string[];
let err: string[];

beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => { out.push(String(chunk)); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => { err.push(String(chunk)); return true; });
  vi.stubEnv("OSSFIND_FIXTURES", "1");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const stdout = () => out.join("");
const stderr = () => err.join("");

describe("ossfind CLI argument handling", () => {
  it("prints the version alone", async () => {
    await expect(main(["--version"])).resolves.toBe(0);
    expect(stdout().trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  // Asking for help succeeded; being given nothing did not.
  it("exits 0 for --help and 1 for no arguments", async () => {
    await expect(main(["--help"])).resolves.toBe(0);
    expect(stdout()).toContain("ossfind search <query>");

    out = [];
    await expect(main([])).resolves.toBe(1);
    expect(stderr()).toContain("ossfind search <query>");
  });

  it.each([
    [["bogus"], /unknown command "bogus"/],
    [["search"], /search needs a query/],
    [["inspect"], /inspect needs a package name/],
    [["search", "x", "-e", "klingon"], /unknown ecosystem "klingon"/],
    [["search", "x", "-n", "0"], /--limit must be a positive integer/],
    [["search", "x", "-n", "abc"], /--limit must be a positive integer/],
  ])("rejects %j", async (argv, message) => {
    await expect(main(argv)).resolves.toBe(1);
    expect(stderr()).toMatch(message);
  });

  it("reports an unknown flag without a stack trace", async () => {
    await expect(main(["search", "x", "--nope"])).resolves.toBe(1);
    expect(stderr()).toContain("--nope");
    expect(stderr()).not.toMatch(/node:internal|\.ts:\d+|\.js:\d+/);
  });

  it("refuses inspect for ecosystems that publish no declarations", async () => {
    await expect(main(["inspect", "serde", "-e", "cargo"])).resolves.toBe(1);
    expect(stderr()).toMatch(/npm and pypi only/);
  });

  it("joins a multi-word query given without quotes", async () => {
    await expect(main(["search", "http", "client", "-n", "1"])).resolves.toBe(0);
    expect(stdout()).toContain('"http client"');
  });
});

describe("ossfind CLI output", () => {
  it("renders a ranked result with its safety evidence", async () => {
    await expect(main(["search", "http client", "-n", "2", "--no-color"])).resolves.toBe(0);
    const text = stdout();
    expect(text).toMatch(/result\(s\) for "http client" in npm/);
    expect(text).toMatch(/SHIP|CAUTION|AVOID/);
    expect(text).toMatch(/CVEs?/);
  });

  it("emits parseable JSON with --json and no ANSI codes", async () => {
    await expect(main(["search", "http client", "-n", "2", "--json"])).resolves.toBe(0);
    const payload = JSON.parse(stdout());
    expect(payload.query).toBe("http client");
    expect(payload.ecosystem).toBe("npm");
    expect(Array.isArray(payload.results)).toBe(true);
    // eslint-disable-next-line no-control-regex
    expect(stdout()).not.toMatch(/\[/);
  });

  it("passes the project license through to ranking", async () => {
    await expect(main(["search", "http client", "-n", "1", "-l", "GPL-3.0", "--json"])).resolves.toBe(0);
    expect(JSON.parse(stdout()).projectLicense).toBe("GPL-3.0");
  });

  it("honours NO_COLOR", async () => {
    vi.stubEnv("NO_COLOR", "1");
    await expect(main(["search", "http client", "-n", "1"])).resolves.toBe(0);
    // eslint-disable-next-line no-control-regex
    expect(stdout()).not.toMatch(/\[/);
  });
});
