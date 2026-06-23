export class UserError extends Error {
  hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'UserError';
    this.hint = hint;
  }
}

// Thrown to signal a specific exit code. If userMessage is set, index.ts prints it before exiting.
export class ControlledExit extends Error {
  constructor(public readonly code: number, public readonly userMessage?: string) {
    super(`exit ${code}`);
    this.name = 'ControlledExit';
  }
}
