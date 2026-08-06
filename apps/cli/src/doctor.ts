import { createHash } from "node:crypto";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  loadSmartFlowConfig,
  resolveWorkerLaunchConfiguration,
  resolveInstallationDataDirectory,
  resolveProjectDataDirectory,
  type ResolvedWorkerLaunchConfiguration,
  type SmartFlowConfig
} from "@smartflow/daemon";
import { PiProvider } from "@smartflow/provider-pi";
import {
  FilesystemWorkspaceApplyAdapter,
  loadOrCreateInstallationSigningKey
} from "@smartflow/publish";
import { ExecutionSandboxAdapter } from "@smartflow/workspace";

export type CapabilityStatus = "ready" | "optional-unavailable" | "blocking-unavailable";

export interface DoctorCapability {
  id: "config" | "data-dir" | "sandbox" | "provider" | "apply-adapter" | "signing-key";
  required: boolean;
  status: CapabilityStatus;
  summary: string;
  details?: Record<string, unknown>;
}

export interface DoctorReport {
  schemaVersion: 1;
  protocolVersion: "smartflow.v5";
  status: CapabilityStatus;
  ready: boolean;
  config: SmartFlowConfig | null;
  dataDirectory: string;
  capabilities: DoctorCapability[];
}

export interface DoctorProbe {
  id: DoctorCapability["id"];
  required: boolean;
  run(): Promise<DoctorProbeObservation>;
}

export interface DoctorProbeObservation {
  available: boolean;
  summary: string;
  details?: Record<string, unknown>;
}

export interface DoctorOptions {
  projectRoot?: string;
  environment?: NodeJS.ProcessEnv;
  probes?: DoctorProbe[];
  configPath?: string;
}

function projectIdFor(root: string): string {
  return `doctor-${createHash("sha256").update(resolve(root), "utf8").digest("hex").slice(0, 20)}`;
}

function defaultProbes(
  projectRoot: string,
  dataDirectory: string,
  environment: NodeJS.ProcessEnv,
  workerConfiguration: ResolvedWorkerLaunchConfiguration
): DoctorProbe[] {
  return [
    {
      id: "config",
      required: true,
      run: () => Promise.resolve({
        available: true,
        summary: "Direct MCP single-model configuration is valid"
      })
    },
    {
      id: "data-dir",
      required: true,
      async run(): Promise<DoctorProbeObservation> {
        const projectData = resolveProjectDataDirectory({
          projectRoot,
          projectId: projectIdFor(projectRoot),
          environment
        });
        await mkdir(projectData, { recursive: true, mode: 0o700 });
        const marker = resolve(projectData, `.doctor-${String(process.pid)}`);
        await writeFile(marker, "ok", { flag: "wx", mode: 0o600 });
        await access(marker);
        await rm(marker);
        return { available: true, summary: "Data Dir is writable and outside the project", details: { projectData } };
      }
    },
    {
      id: "sandbox",
      required: true,
      async run(): Promise<DoctorProbeObservation> {
        const capabilities = await new ExecutionSandboxAdapter().probe();
        return {
          available:
            capabilities.available &&
            capabilities.fileIsolation &&
            capabilities.networkIsolation &&
            capabilities.processTreeControl,
          summary: capabilities.available
            ? "Execution sandbox enforces file, network, and process-tree boundaries"
            : `Execution sandbox unavailable: ${capabilities.reason ?? "unknown reason"}`,
          details: { ...capabilities }
        };
      }
    },
    {
      id: "provider",
      required: true,
      async run(): Promise<DoctorProbeObservation> {
        const result = await new PiProvider({
          runtimeConfig: workerConfiguration.runtimeConfig,
          environment: {
            SMARTFLOW_PI_API_KEY: workerConfiguration.credential
          }
        }).probe();
        return {
          available: result.available,
          summary: result.available
            ? "Pi SDK, bundled model Extension, credential and sandbox capabilities passed"
            : result.reason,
          details: {
            capabilities: result.capabilities,
            ...(result.available
              ? { providerRuntimeConfigHash: result.providerRuntimeConfigHash, ...result.details }
              : { code: result.code })
          }
        };
      }
    },
    {
      id: "apply-adapter",
      required: false,
      async run(): Promise<DoctorProbeObservation> {
        const adapter = new FilesystemWorkspaceApplyAdapter(projectRoot, {
          read: (): Promise<Uint8Array> =>
            Promise.reject(new Error("doctor apply probe must not read blobs"))
        }, resolve(dataDirectory, "doctor", "publish-results"));
        const capabilities = await adapter.probe();
        const available =
          capabilities.expectedOldHashCas &&
          (capabilities.atomicBatchCas || capabilities.preflightBatchWrite === true) &&
          capabilities.stableOperationId &&
          capabilities.queryResult;
        return {
          available,
          summary: available
            ? "Host adapter can publish after checking all Candidate paths"
            : "No behavior-verified publish adapter; reviewed results will use DeliveryBundle",
          details: { ...capabilities }
        };
      }
    },
    {
      id: "signing-key",
      required: true,
      async run(): Promise<DoctorProbeObservation> {
        const key = await loadOrCreateInstallationSigningKey(resolve(dataDirectory, "keys", "daemon-ed25519.pem"));
        return { available: true, summary: "Installation Ed25519 signing key is ready", details: { keyId: key.keyId } };
      }
    }
  ];
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const environment = options.environment ?? process.env;
  const dataDirectory = resolveInstallationDataDirectory({ environment });
  let config: SmartFlowConfig | null = null;
  let probes = options.probes;
  if (probes === undefined) {
    try {
      config = await loadSmartFlowConfig(options.configPath ?? environment.SMARTFLOW_CONFIG);
      const workerConfiguration = resolveWorkerLaunchConfiguration([], environment);
      probes = defaultProbes(projectRoot, dataDirectory, environment, workerConfiguration);
    } catch (error) {
      probes = [
        {
          id: "config",
          required: true,
          run: (): Promise<DoctorProbeObservation> => Promise.resolve({
            available: false,
            summary: error instanceof Error ? error.message : String(error)
          })
        }
      ];
    }
  }
  const capabilities: DoctorCapability[] = [];
  for (const probe of probes) {
    try {
      const result = await probe.run();
      capabilities.push({
        id: probe.id,
        required: probe.required,
        status: result.available ? "ready" : probe.required ? "blocking-unavailable" : "optional-unavailable",
        summary: result.summary,
        ...(result.details === undefined ? {} : { details: result.details })
      });
    } catch (error) {
      capabilities.push({
        id: probe.id,
        required: probe.required,
        status: probe.required ? "blocking-unavailable" : "optional-unavailable",
        summary: error instanceof Error ? error.message : String(error)
      });
    }
  }
  const blocking = capabilities.some((capability) => capability.status === "blocking-unavailable");
  const optional = capabilities.some((capability) => capability.status === "optional-unavailable");
  return {
    schemaVersion: 1,
    protocolVersion: "smartflow.v5",
    status: blocking ? "blocking-unavailable" : optional ? "optional-unavailable" : "ready",
    ready: !blocking,
    config,
    dataDirectory,
    capabilities
  };
}
