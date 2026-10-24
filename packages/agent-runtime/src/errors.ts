export class FatalToolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FatalToolError";
  }
}

export class AgentRuntimeError extends Error {
  readonly retryable: boolean;
  readonly status?: number;

  constructor(message: string, options: { retryable: boolean; status?: number; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = "AgentRuntimeError";
    this.retryable = options.retryable;
    this.status = options.status;
  }
}
