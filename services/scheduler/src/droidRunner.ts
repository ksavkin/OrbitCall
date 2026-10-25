import { runDroid } from "./droid.js";
import { safeError } from "./protocol.js";
let input = "";
for await (const chunk of process.stdin) { input += chunk; if (input.length > 400_000) process.exit(1); }
try { process.stdout.write(JSON.stringify({ receipt: await runDroid(JSON.parse(input)) })); }
catch (error) { process.stdout.write(JSON.stringify({ error: safeError(error) })); process.exitCode = 1; }
