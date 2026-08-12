import { describe, expect, it } from "vitest";
import { checkLicense } from "./compat.js";

describe("License Compatibility Matrix", () => {
  const cases = [
    { proj: "MIT", comp: "MIT", expected: "yes" },
    { proj: "MIT", comp: "Apache-2.0", expected: "yes" },
    { proj: "MIT", comp: "BSD-3-Clause", expected: "yes" },
    { proj: "MIT", comp: "ISC", expected: "yes" },
    { proj: "MIT", comp: "MPL-2.0", expected: "conditional" },
    { proj: "MIT", comp: "LGPL-3.0", expected: "conditional" },
    { proj: "MIT", comp: "GPL-3.0", expected: "no" },
    { proj: "MIT", comp: "AGPL-3.0", expected: "no" },
    { proj: "MIT", comp: "unknown", expected: "conditional" },
    { proj: "MIT", comp: null, expected: "conditional" },

    { proj: "GPL-3.0", comp: "MIT", expected: "yes" },
    { proj: "GPL-3.0", comp: "Apache-2.0", expected: "yes" },
    { proj: "GPL-3.0", comp: "MPL-2.0", expected: "conditional" },
    { proj: "GPL-3.0", comp: "GPL-3.0", expected: "yes" },
    { proj: "GPL-3.0", comp: "AGPL-3.0", expected: "no" },

    { proj: "AGPL-3.0", comp: "MIT", expected: "yes" },
    { proj: "AGPL-3.0", comp: "GPL-3.0", expected: "yes" },
    { proj: "AGPL-3.0", comp: "AGPL-3.0", expected: "yes" },

    { proj: "MPL-2.0", comp: "MIT", expected: "yes" },
    { proj: "MPL-2.0", comp: "MPL-2.0", expected: "yes" },
    { proj: "MPL-2.0", comp: "LGPL-3.0", expected: "conditional" },
    { proj: "MPL-2.0", comp: "GPL-3.0", expected: "no" },
  ];

  for (const { proj, comp, expected } of cases) {
    it(`should return ${expected} for project license ${proj} and component license ${comp}`, () => {
      const result = checkLicense(proj, comp);
      expect(result.compatible).toBe(expected);
      expect(result.notes.toLowerCase()).toContain("guidance");
    });
  }

  it.each([
    "GPL-3.0",
    "gpl-3.0",
    "GPL-3.0-only",
    "GPL-3.0-or-later",
    "GPL-3.0+",
    "(GPL-3.0)",
    "GPL-3.0 OR MIT",
    "AGPL-3.0",
    "AGPL-3.0-or-later",
  ])("recognizes strong-copyleft SPDX expression %s", (comp) => {
    expect(checkLicense("MIT", comp).compatible).toBe("no");
    expect(checkLicense("Apache-2.0", comp).compatible).toBe("no");
  });

  it.each(["LGPL-3.0-or-later", "lgpl-2.1+", "MIT AND LGPL-3.0-only"])(
    "recognizes weak-copyleft SPDX expression %s",
    (comp) => expect(checkLicense("MIT", comp).compatible).toBe("conditional"),
  );
});
