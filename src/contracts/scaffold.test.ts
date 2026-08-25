import { describe, expect, it } from "vitest";
import { ScaffoldSchema } from "./scaffold.js";

describe("ScaffoldSchema", () => {
  it("validates a complete scaffold object with verified signatures", () => {
    const scaffold = {
      component: "npm:axios",
      install: "npm install axios",
      imports: ['import axios from "axios";'],
      snippet: "// Verified signature: get(url: string)\nconst response = await axios.get(url);",
      basedOn: [{ name: "get", signature: "get(url: string): Promise<any>" }],
      confidence: "verified-signatures" as const,
      notes: [],
      warnings: [],
    };
    expect(ScaffoldSchema.parse(scaffold)).toEqual(scaffold);
  });

  it("validates an import-only scaffold with null snippet", () => {
    const scaffold = {
      component: "npm:unknown-pkg",
      install: "npm install unknown-pkg",
      imports: ['import unknownPkg from "unknown-pkg";'],
      snippet: null,
      basedOn: [],
      confidence: "import-only" as const,
      notes: ["API surface types are not available (typesAvailable: none); no usage code was generated."],
      warnings: [],
    };
    expect(ScaffoldSchema.parse(scaffold)).toEqual(scaffold);
  });

  it("rejects invalid confidence values", () => {
    const invalid = {
      component: "npm:axios",
      install: "npm install axios",
      imports: ['import axios from "axios";'],
      snippet: null,
      basedOn: [],
      confidence: "guessed",
      notes: [],
      warnings: [],
    };
    expect(() => ScaffoldSchema.parse(invalid)).toThrow();
  });
});
