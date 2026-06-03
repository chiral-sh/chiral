export class UserError extends Error {
  hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'UserError';
    this.hint = hint;
  }
}

// Thrown to signal a specific exit code without printing an error message.
// Caught at the top-level boundary in index.ts.
export class ControlledExit extends Error {
  constructor(public readonly code: number) {
    super(`exit ${code}`);
    this.name = 'ControlledExit';
  }
}
