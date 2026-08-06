import { LocalIpcClient } from "@smartflow/daemon";

import type { DaemonGateway } from "./daemon-gateway.js";

export class LocalDaemonGateway implements DaemonGateway {
  private readonly client: LocalIpcClient;

  public constructor(client: LocalIpcClient) {
    this.client = client;
  }

  public call(toolName: string, input: unknown): Promise<unknown> {
    return this.client.call(toolName, input);
  }

  public close(): void {
    this.client.close();
  }
}
