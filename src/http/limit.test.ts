import { describe, expect, it } from "vitest";
import { createLimiter } from "./limit.js";

describe("createLimiter", () => {
  it("caps peak in-flight work at the configured concurrency", async () => {
    const limit = createLimiter(2);
    let inFlight = 0;
    let peak = 0;
    const task = () => limit.run(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
    });

    await Promise.all([task(), task(), task(), task(), task()]);

    expect(peak).toBe(2);
    expect(inFlight).toBe(0);
  });

  it("rejects invalid concurrency", () => {
    expect(() => createLimiter(0)).toThrow(RangeError);
    expect(() => createLimiter(1.5)).toThrow(RangeError);
  });
});
