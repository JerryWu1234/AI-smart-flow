import type { WorkerProvider } from "@smartflow/provider-core";
import {
  API_KEY_ENVIRONMENT_VARIABLE,
  PiProvider,
  frozenPiRuntimeConfig,
  piRuntimeConfigHash
} from "@smartflow/provider-pi";

import {
  resolveWorkerRegistration,
  type ResolvedWorkerLaunchConfiguration
} from "../config/worker-config.js";

export interface RegisteredProviderRuntime {
  daemonConfigFingerprint: string;
  providerRuntimeConfigHash: string;
  providerRuntimeConfig: Readonly<Record<string, unknown>>;
  provider: WorkerProvider;
}

export type ProviderRuntimeResolver = (
  providerRuntimeConfigHash: string
) => RegisteredProviderRuntime | undefined;

export class ProviderRegistry {
  private readonly entries = new Map<string, RegisteredProviderRuntime>();

  public register(
    configuration: ResolvedWorkerLaunchConfiguration
  ): RegisteredProviderRuntime {
    const providerRuntimeConfigHash = piRuntimeConfigHash(configuration.runtimeConfig);
    const current = this.entries.get(providerRuntimeConfigHash);
    if (current?.daemonConfigFingerprint === configuration.daemonConfigFingerprint) return current;
    const entry: RegisteredProviderRuntime = {
      daemonConfigFingerprint: configuration.daemonConfigFingerprint,
      providerRuntimeConfigHash,
      providerRuntimeConfig: frozenPiRuntimeConfig(configuration.runtimeConfig),
      provider: new PiProvider({
        runtimeConfig: configuration.runtimeConfig,
        environment: {
          [API_KEY_ENVIRONMENT_VARIABLE]: configuration.credential
        }
      })
    };
    this.entries.set(providerRuntimeConfigHash, entry);
    return entry;
  }

  public registerEnvironment(value: unknown): RegisteredProviderRuntime {
    return this.register(resolveWorkerRegistration(value));
  }

  public resolve(providerRuntimeConfigHash: string): RegisteredProviderRuntime | undefined {
    return this.entries.get(providerRuntimeConfigHash);
  }
}
