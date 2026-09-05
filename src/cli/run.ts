import { main } from "./main.js";

main()
  .then((code) => { process.exitCode = code; })
  .catch((error: unknown) => {
    process.stderr.write(`ossfind: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
