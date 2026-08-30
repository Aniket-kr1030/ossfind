import { readFileSync } from "node:fs";

/**
 * Single source of truth for the package version.
 *
 * Previously the version was hardcoded in two places (the MCP `serverInfo` and the
 * telemetry payload), which silently drifted: 0.1.1 shipped while the MCP server still
 * advertised 0.1.0 to clients. Reading package.json keeps them correct by construction.
 *
 * The relative path resolves correctly from both `src/` (tests, run via vitest) and
 * `dist/` (published build), since each sits one level below the package root.
 */
function readPackageVersion(): string {
  try {
    const pkgUrl = new URL("../package.json", import.meta.url);
    const raw = readFileSync(pkgUrl, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "version" in parsed) {
      const version = (parsed as { version?: unknown }).version;
      if (typeof version === "string" && version.length > 0) return version;
    }
  } catch {
    // Fall through: an unreadable package.json must never break the server.
  }
  return "0.0.0-unknown";
}

/** The running package version, read once at module load. */
export const PACKAGE_VERSION: string = readPackageVersion();
