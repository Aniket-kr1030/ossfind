import { describe, expect, it } from "vitest";
import * as g1 from "./g1.js";
import * as g2 from "./g2.js";
import * as g3 from "./g3.js";
import * as g4 from "./g4.js";
import * as g5 from "./g5.js";
import * as g6 from "./g6.js";
import * as g7 from "./g7.js";
import * as g8 from "./g8.js";
import * as g9 from "./g9.js";
import * as g10 from "./g10.js";
import * as g11 from "./g11.js";
import * as g12 from "./g12.js";
import * as g13 from "./g13.js";
import * as g14 from "./g14.js";

describe("Quality Gates Battery Verification Test", () => {
  const gates = [g1, g2, g3, g4, g5, g6, g7, g8, g9, g10, g11, g12, g13, g14];

  for (const gate of gates) {
    it(`should pass check() and detect failure in proveFailure() for gate ${gate.id}`, async () => {
      const checkRes = await gate.check();
      expect(checkRes.status).toBe("pass");

      const proveRes = await gate.proveFailure();
      expect(proveRes.status).toBe("detected");
    });
  }
});
