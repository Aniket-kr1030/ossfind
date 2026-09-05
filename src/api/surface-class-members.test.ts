import { describe, expect, it } from "vitest";
import { ApiSurfaceSchema } from "../contracts/api-surface.js";
import type { HttpClient } from "../http/client.js";
import { ApiSurfaceExtractor } from "./surface.js";

/** Serves one declaration file so a specific class shape can be asserted exactly. */
function declaring(declaration: string): HttpClient {
  return async (url: string) => {
    if (url === "https://registry.npmjs.org/demo/latest") {
      return { ok: true, status: 200, json: async () => ({ name: "demo", version: "1.0.0", types: "index.d.ts" }) };
    }
    if (url === "https://cdn.jsdelivr.net/npm/demo@1.0.0/index.d.ts") {
      return { ok: true, status: 200, json: async () => ({}), text: async () => declaration };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

async function classFor(declaration: string, name = "Widget") {
  const surface = await new ApiSurfaceExtractor(declaring(declaration)).extract("demo");
  expect(ApiSurfaceSchema.parse(surface)).toEqual(surface);
  return surface.exports.find((entry) => entry.name === name);
}

describe("class member extraction", () => {
  it("reports methods, properties, accessors and the constructor with signatures", async () => {
    const found = await classFor(`
export declare class Widget {
  label: string;
  constructor(options?: { size: number });
  resize(width: number, height: number): void;
  get area(): number;
  static create(size: number): Widget;
}
`);
    expect(found?.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "label", kind: "property", signature: "label: string", static: false }),
      expect.objectContaining({ name: "constructor", kind: "constructor", signature: "constructor(options?:{size:number})" }),
      expect.objectContaining({ name: "resize", kind: "method", signature: "resize(width:number, height:number): void" }),
      expect.objectContaining({ name: "area", kind: "accessor", static: false }),
      expect.objectContaining({ name: "create", kind: "method", static: true }),
    ]));
  });

  // The gap this closed: minisearch exported `default` as a class and reported no
  // methods at all, so integration code for it had to be written from memory.
  it("reports members of a default-exported class", async () => {
    const surface = await new ApiSurfaceExtractor(declaring(`
export default class Store {
  add(item: string): void;
  search(query: string): string[];
}
`)).extract("demo");
    const entry = surface.exports.find((item) => item.members && item.members.length > 0);
    expect(entry?.members?.map((member) => member.name).sort()).toEqual(["add", "search"]);
  });

  it.each([
    ["private", "private secret(): void;"],
    ["protected", "protected internal(): void;"],
    ["#name", "#hidden(): void;"],
  ])("never exposes a %s member", async (_label, member) => {
    const found = await classFor(`
export declare class Widget {
  visible(): void;
  ${member}
}
`);
    expect(found?.members?.map((entry) => entry.name)).toEqual(["visible"]);
  });

  it("gives an unannotated property a null signature rather than an inferred one", async () => {
    const found = await classFor(`
export declare class Widget {
  declare untyped;
  typed: number;
}
`);
    const untyped = found?.members?.find((member) => member.name === "untyped");
    if (untyped) expect(untyped.signature).toBeNull();
    expect(found?.members).toContainEqual(expect.objectContaining({ name: "typed", signature: "typed: number" }));
  });

  it("collapses overloads into one entry", async () => {
    const found = await classFor(`
export declare class Widget {
  read(path: string): string;
  read(path: string, encoding: string): Buffer;
}
`);
    expect(found?.members?.filter((member) => member.name === "read")).toHaveLength(1);
  });

  it("distinguishes a static member from an instance member of the same name", async () => {
    const found = await classFor(`
export declare class Widget {
  create(): void;
  static create(): Widget;
}
`);
    const creates = found?.members?.filter((member) => member.name === "create");
    expect(creates).toHaveLength(2);
    expect(creates?.map((member) => member.static).sort()).toEqual([false, true]);
  });

  it("reports an empty member list for a class that declares nothing public", async () => {
    const found = await classFor("export declare class Widget {\n  private only(): void;\n}\n");
    expect(found?.members).toEqual([]);
  });

  it("omits members entirely for exports that are not classes", async () => {
    const surface = await new ApiSurfaceExtractor(declaring(`
export declare function run(value: string): string;
export interface Options { size: number }
`)).extract("demo");
    for (const entry of surface.exports) expect(entry.members).toBeUndefined();
  });

  it("flags truncation instead of silently dropping members", async () => {
    const many = Array.from({ length: 120 }, (_unused, index) => `  method${index}(): void;`).join("\n");
    const found = await classFor(`export declare class Widget {\n${many}\n}\n`);
    expect(found?.membersTruncated).toBe(true);
    expect(found?.members?.length).toBe(80);
  });

  it("reports a computed key verbatim rather than inventing a name", async () => {
    const found = await classFor(`
export declare class Widget {
  [Symbol.iterator](): Iterator<string>;
}
`);
    const names = found?.members?.map((member) => member.name) ?? [];
    expect(names.every((name) => name.length > 0)).toBe(true);
    expect(names.some((name) => name.includes("Symbol.iterator"))).toBe(true);
  });
});
