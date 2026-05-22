export class UserError extends Error {
  hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'UserError';
    this.hint = hint;
  }
}
