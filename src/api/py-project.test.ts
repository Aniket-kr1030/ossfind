import { describe, expect, it } from "vitest";
import {
  normalizeDistributionName,
  parsePep508Requirement,
  parsePyprojectToml,
  parseRequirementsTxt,
} from "./py-project.js";

describe("py-project", () => {
  describe("normalizeDistributionName", () => {
    it("normalizes case, underscores, and dots to hyphens", () => {
      expect(normalizeDistributionName("Requests")).toBe("requests");
      expect(normalizeDistributionName("typing_extensions")).toBe("typing-extensions");
      expect(normalizeDistributionName("zope.interface")).toBe("zope-interface");
      expect(normalizeDistributionName("Foo--_..Bar")).toBe("foo-bar");
    });
  });

  describe("parsePep508Requirement", () => {
    it("parses name and version specifiers", () => {
      const parsed = parsePep508Requirement("requests>=2.0,<3");
      expect(parsed).toEqual({
        name: "requests",
        normalizedName: "requests",
        extras: undefined,
        specifier: ">=2.0,<3",
        marker: undefined,
      });
    });

    it("parses extras and environment markers", () => {
      const parsed = parsePep508Requirement('requests[socks,security] >= 2.28.0 ; python_version < "3.11"');
      expect(parsed).toEqual({
        name: "requests",
        normalizedName: "requests",
        extras: ["socks", "security"],
        specifier: ">= 2.28.0",
        marker: 'python_version < "3.11"',
      });
    });

    it("returns null for empty lines, comments, and direct URLs", () => {
      expect(parsePep508Requirement("")).toBeNull();
      expect(parsePep508Requirement("   ")).toBeNull();
      expect(parsePep508Requirement("# just a comment")).toBeNull();
      expect(parsePep508Requirement("pkg @ https://example.com/pkg.tar.gz")).toBeNull();
      expect(parsePep508Requirement("git+https://github.com/org/repo.git")).toBeNull();
    });
  });

  describe("parseRequirementsTxt", () => {
    it("parses standard PEP 508 lines and ignores comments and blank lines", () => {
      const content = `
        # Requirements file
        requests>=2.0,<3
        urllib3<3,>=1.26

        # Another dependency
        certifi
      `;
      const context = parseRequirementsTxt(content);
      expect(context.dependencies).toEqual({
        requests: ">=2.0,<3",
        urllib3: "<3,>=1.26",
        certifi: "*",
      });
      expect(context.uncertain).toBeUndefined();
    });

    it("handles extras and environment markers while recording notes", () => {
      const content = `
        requests[socks]>=2.28.0
        importlib-metadata>=4.4; python_version < "3.10"
      `;
      const context = parseRequirementsTxt(content);
      expect(context.dependencies).toEqual({
        requests: ">=2.28.0",
        "importlib-metadata": ">=4.4",
      });
      expect(context.notes).toContainEqual(expect.stringContaining('Ignored extras [socks] for package "requests"'));
      expect(context.notes).toContainEqual(expect.stringContaining('Recorded environment marker "python_version < "3.10""'));
    });

    it("skips nested requirement files and editable installs with notes", () => {
      const content = `
        -r base-requirements.txt
        -e .
        --requirement dev-reqs.txt
        pydantic>=2.0
      `;
      const context = parseRequirementsTxt(content);
      expect(context.dependencies).toEqual({
        pydantic: ">=2.0",
      });
      expect(context.notes).toContainEqual(expect.stringContaining("Nested requirement file include skipped"));
      expect(context.notes).toContainEqual(expect.stringContaining("Editable requirement option skipped"));
      expect(context.uncertain).toBeUndefined();
    });

    it("handles line continuations ending in backslash", () => {
      const content = `
        requests\\
          >=2.28.0,\\
          <3.0.0
      `;
      const context = parseRequirementsTxt(content);
      expect(context.dependencies).toEqual({
        requests: ">=2.28.0, <3.0.0",
      });
    });

    it("marks uncertain and records note for unparseable direct URL requirements", () => {
      const content = `
        requests>=2.0
        my-custom-pkg @ https://github.com/custom/pkg/archive/main.zip
      `;
      const context = parseRequirementsTxt(content);
      expect(context.dependencies).toEqual({
        requests: ">=2.0",
      });
      expect(context.uncertain).toBe(true);
      expect(context.notes).toContainEqual(expect.stringContaining("Cannot evaluate direct URL or VCS requirement"));
    });
  });

  describe("parsePyprojectToml", () => {
    it("parses PEP 621 pyproject.toml dependencies, requires-python, and license", () => {
      const toml = `
[project]
name = "demo-app"
version = "0.1.0"
requires-python = ">=3.10"
license = "MIT"
dependencies = [
    "requests>=2.28.0",
    "urllib3<3,>=1.26",
]

[project.optional-dependencies]
dev = [
    "pytest>=7.0",
]
      `;
      const context = parsePyprojectToml(toml);
      expect(context.requiresPython).toBe(">=3.10");
      expect(context.engines).toEqual({ python: ">=3.10" });
      expect(context.license).toBe("MIT");
      expect(context.dependencies).toEqual({
        requests: ">=2.28.0",
        urllib3: "<3,>=1.26",
      });
      expect(context.devDependencies).toEqual({
        pytest: ">=7.0",
      });
      expect(context.uncertain).toBeUndefined();
    });

    it("parses inline dependencies array and license table", () => {
      const toml = `
[project]
name = "inline-app"
requires-python = ">=3.8"
license = { text = "Apache-2.0" }
dependencies = ["flask>=2.0", "click>=8.0"]
      `;
      const context = parsePyprojectToml(toml);
      expect(context.requiresPython).toBe(">=3.8");
      expect(context.license).toBe("Apache-2.0");
      expect(context.dependencies).toEqual({
        flask: ">=2.0",
        click: ">=8.0",
      });
      expect(context.uncertain).toBeUndefined();
    });

    it("fails closed on non-PEP 621 Poetry projects with an honest note (The Honesty Test)", () => {
      const toml = `
[tool.poetry]
name = "poetry-app"
version = "0.1.0"

[tool.poetry.dependencies]
python = "^3.10"
requests = "^2.28.0"
      `;
      const context = parsePyprojectToml(toml);
      expect(context.uncertain).toBe(true);
      expect(context.notes).toContainEqual(expect.stringContaining("No [project] table found in pyproject.toml"));
    });

    it("fails closed on dynamic dependencies with an honest note", () => {
      const toml = `
[project]
name = "dynamic-app"
dynamic = ["dependencies", "version"]
requires-python = ">=3.9"
      `;
      const context = parsePyprojectToml(toml);
      expect(context.uncertain).toBe(true);
      expect(context.notes).toContainEqual(expect.stringContaining("pyproject.toml declares dynamic field(s)"));
    });

    it("fails closed on unresolved license files with a clear note", () => {
      const toml = `
[project]
name = "license-file-app"
license = { file = "LICENSE" }
dependencies = ["requests>=2.0"]
      `;
      const context = parsePyprojectToml(toml);
      expect(context.uncertain).toBe(true);
      expect(context.notes).toContainEqual(expect.stringContaining("License file reference \"LICENSE\" cannot be resolved statically."));
    });
  });
});
