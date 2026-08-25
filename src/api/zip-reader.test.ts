import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseZip } from "./zip-reader.js";

const attrsWheel = new URL("../../fixtures/raw/pyapi/wheels/attrs-26.1.0-py3-none-any.whl", import.meta.url);

describe("parseZip", () => {
  it("lists and extracts a known entry from the frozen attrs wheel", async () => {
    const parsed = parseZip(await readFile(attrsWheel));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error);

    expect(parsed.value.listEntryNames()).toContain("attr/__init__.pyi");
    expect(parsed.value.listEntryNames()).toContain("attr/py.typed");

    const extracted = await parsed.value.extractText("attr/__init__.pyi");
    expect(extracted.ok).toBe(true);
    if (!extracted.ok) throw new Error(extracted.error);
    expect(extracted.value).toContain("class Attribute");
    expect(extracted.value).toContain("def attrib(");
  });

  it("fails closed for a truncated archive without throwing", async () => {
    const wheel = await readFile(attrsWheel);
    const truncated = new Uint8Array(wheel.subarray(0, Math.floor(wheel.byteLength / 2)));

    expect(() => parseZip(truncated)).not.toThrow();
    expect(parseZip(truncated)).toMatchObject({ ok: false });
  });
});
