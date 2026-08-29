import type { z } from "zod";

export interface DaemonRequestContext {
  clientName?: string;
}

export interface DaemonGateway {
  call(toolName: string, input: unknown, context?: DaemonRequestContext): Promise<unknown>;
}

export type ValidatedHandler = (input: unknown) => Promise<unknown>;

export function createValidatedHandler<I, O>(
  gateway: DaemonGateway,
  toolName: string,
  inputSchema: z.ZodType<I>,
  outputSchema: z.ZodType<O>
): ValidatedHandler {
  return async (input: unknown): Promise<O> => {
    const request = inputSchema.parse(input);
    const response = await gateway.call(toolName, request);
    return outputSchema.parse(response);
  };
}
