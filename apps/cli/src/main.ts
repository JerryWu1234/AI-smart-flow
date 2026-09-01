import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { realpath } from "node:fs/promises";

import {
  LocalIpcClient,
  daemonEndpoint,
  resolveMcpWorkerLaunchConfiguration,
  resolveWorkerLaunchConfiguration,
  resolveInstallationDataDirectory,
  serveSmartFlowDaemon
} from "@smartflow/daemon";
import { runSmartFlowMcpGateway } from "@smartflow/mcp-server";
import { StructuredLogger } from "@smartflow/observability";

import { runDoctor } from "./doctor.js";

function flagValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  const command = argv[0] ?? "help";
  if (command === "doctor") {
    const configPath = flagValue(argv, "--config");
    const report = await runDoctor({
      projectRoot: flagValue(argv, "--project") ?? process.cwd(),
      ...(configPath === undefined ? {} : { configPath })
    });
    if (argv.includes("--json")) print(report);
    else {
      process.stdout.write(`SmartFlow doctor: ${report.status}\n`);
      for (const capability of report.capabilities) {
        process.stdout.write(`- ${capability.id}: ${capability.status} — ${capability.summary}\n`);
      }
    }
    return report.ready ? 0 : 1;
  }
  if (command === "daemon") {
    const dataDirectory = flagValue(argv, "--data-dir");
    const configPath = flagValue(argv, "--config");
    const workerLaunchConfiguration = resolveWorkerLaunchConfiguration(argv);
    await serveSmartFlowDaemon({
      ...(dataDirectory === undefined ? {} : { dataDirectory }),
      ...(configPath === undefined ? {} : { configPath }),
      workerLaunchConfiguration
    });
    return 0;
  }
  if (command === "mcp") {
    const entryPath = process.argv[1];
    if (entryPath === undefined) throw new Error("CLI entry path is unavailable");
    const dataDirectory = flagValue(argv, "--data-dir");
    const workerLaunchConfiguration = resolveMcpWorkerLaunchConfiguration(argv);
    await runSmartFlowMcpGateway({
      executablePath: process.execPath,
      entryPath,
      ...(dataDirectory === undefined ? {} : { dataDirectory }),
      workerLaunchConfiguration
    });
    return 0;
  }
  if (command === "health") {
    const dataDirectory = flagValue(argv, "--data-dir") ?? resolve(resolveInstallationDataDirectory(), "daemon");
    const client = await LocalIpcClient.connect(daemonEndpoint(dataDirectory));
    try {
      print(await client.call("smartflow_health", {}));
    } finally {
      client.close();
    }
    return 0;
  }
  if (command === "version" || command === "--version" || command === "-v") {
    process.stdout.write("0.1.0\n");
    return 0;
  }
  process.stdout.write(
    [
      "Usage: smartflow <command>",
      "  doctor [--json] [--project PATH] [--config PATH]",
      "  daemon [--data-dir PATH] [--config PATH]",
      "  mcp [--data-dir PATH]",
      "  Required MCP Pi env: BASE_URL, MODEL, API_KEY",
      "  Optional MCP Pi env: API, SMARTFLOW_PI_CONTEXT_WINDOW, SMARTFLOW_PI_MAX_TOKENS, EFFORT, SMARTFLOW_PI_ATTEMPT_DEADLINE_MS",
      "  health [--data-dir PATH]",
      "  version"
    ].join("\n") + "\n"
  );
  return command === "help" || command === "--help" || command === "-h" ? 0 : 2;
}

const entryPath = process.argv[1];
const canonicalEntryPath = entryPath === undefined
  ? undefined
  : await realpath(entryPath).catch(() => resolve(entryPath));
if (canonicalEntryPath !== undefined && import.meta.url === pathToFileURL(canonicalEntryPath).href) {
  const logger = new StructuredLogger("smartflow-cli");
  try {
    process.exitCode = await runCli();
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
    logger.log({
      level: "error",
      event: "cli.failed",
      error: error instanceof Error
        ? {
            name: error.name,
            message: error.message,
            ...(typeof code === "string" ? { code } : {})
          }
        : error
    });
    process.exitCode = 1;
  }
}
