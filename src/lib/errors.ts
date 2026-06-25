export class UserError extends Error {
  hint?: string;
  exitCode: number;
  retryable: boolean;

  constructor(message: string, hint?: string, exitCode = 1, retryable = false) {
    super(message);
    this.name = 'UserError';
    this.hint = hint;
    this.exitCode = exitCode;
    this.retryable = retryable;
  }
}

// exit 3 — API key invalid/expired/forbidden
export class AuthError extends UserError {
  constructor(message: string, hint?: string) { super(message, hint, 3); this.name = 'AuthError'; }
}

// exit 4 — project/env/resource not found
export class NotFoundError extends UserError {
  constructor(message: string, hint?: string) { super(message, hint, 4); this.name = 'NotFoundError'; }
}

// exit 5 — connection refused / timeout (retryable)
export class NetworkError extends UserError {
  constructor(message: string, hint?: string) { super(message, hint, 5, true); this.name = 'NetworkError'; }
}

// exit 6 — resource already exists / lock conflict
export class ConflictError extends UserError {
  constructor(message: string, hint?: string) { super(message, hint, 6); this.name = 'ConflictError'; }
}

// exit 7 — malformed input / validation failure
export class ValidationError extends UserError {
  constructor(message: string, hint?: string) { super(message, hint, 7); this.name = 'ValidationError'; }
}

// Thrown to signal a specific exit code. If userMessage is set, index.ts prints it before exiting.
export class ControlledExit extends Error {
  constructor(public readonly code: number, public readonly userMessage?: string) {
    super(`exit ${code}`);
    this.name = 'ControlledExit';
  }
}
