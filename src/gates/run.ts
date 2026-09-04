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
import * as g15 from "./g15.js";

async function main() {
  const gates = [g1, g2, g3, g4, g5, g6, g7, g8, g9, g10, g11, g12, g13, g14, g15];
  let anyFailed = false;

  console.log(`\n=== Running Quality-Gate Battery ===\n`);
  console.log(
    `| Gate ID | Description | check() status | proveFailure() status |`
  );
  console.log(
    `|---------|-------------|----------------|-----------------------|`
  );

  for (const gate of gates) {
    const checkRes = await gate.check();
    const proveRes = await gate.proveFailure();

    const checkStr = checkRes.status === "pass" ? "pass" : `fail (${checkRes.status})`;
    const proveStr = proveRes.status === "detected" ? "detected" : `fail (${proveRes.status})`;

    console.log(
      `| ${gate.id.padEnd(7)} | ${gate.description.padEnd(100)} | ${checkStr.padEnd(14)} | ${proveStr.padEnd(21)} |`
    );

    const isCheckPassed = checkRes.status === "pass";
    const isProvePassed = proveRes.status === "detected";

    if (!isCheckPassed || !isProvePassed) {
      anyFailed = true;
    }
  }

  console.log(`\n====================================\n`);

  if (anyFailed) {
    console.error("❌ Some quality gates failed or were not implemented.\n");
    process.exit(1);
  } else {
    console.log("✅ All quality gates passed successfully!\n");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
