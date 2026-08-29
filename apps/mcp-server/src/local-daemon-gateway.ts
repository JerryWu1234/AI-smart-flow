import { LocalIpcClient } from "@smartflow/daemon";

import type { DaemonGateway, DaemonRequestContext } from "./daemon-gateway.js";

export class LocalDaemonGateway implements DaemonGateway {
  private readonly client: LocalIpcClient;

  public constructor(client: LocalIpcClient) {
    this.client = client;
  }

  public call(
    toolName: string,
    input: unknown,
    context?: DaemonRequestContext
  ): Promise<unknown> {
    return this.client.call(toolName, input, context?.clientName);
  }

  public close(): void {
    this.client.close();
  }
}
