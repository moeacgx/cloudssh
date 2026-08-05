export class AgentApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentApiError";
  }
}

export function isAgentApiError(error: unknown): error is AgentApiError {
  return error instanceof AgentApiError;
}
