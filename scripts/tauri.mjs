import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const commandIndex = args.findIndex((arg) => arg === "dev" || arg === "build");
const command = args[commandIndex];
const isDevelopmentBuild =
  command === "dev" ||
  (command === "build" && (args.includes("--debug") || args.includes("-d")));

if (isDevelopmentBuild) {
  const devConfig = fileURLToPath(
    new URL("../src-tauri/tauri.dev.conf.json", import.meta.url),
  );

  // Add the flavor before any user-supplied config so callers can still
  // override individual values later on the command line.
  args.splice(commandIndex + 1, 0, "--config", devConfig);
}

const child = spawn("tauri", args, { stdio: "inherit" });

child.on("error", (error) => {
  console.error(`Failed to start Tauri: ${error.message}`);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exitCode = code ?? 1;
  }
});
