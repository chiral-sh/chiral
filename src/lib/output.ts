export type OutputMode = 'human' | 'json';

export function resolveOutputMode(options: { json?: boolean }): OutputMode {
  if (options.json || !process.stdout.isTTY) return 'json';
  return 'human';
}

export function printJson(data: unknown): void {
  console.log(JSON.stringify({ status: 'ok', data }));
}

export function printJsonError(code: string, message: string, retryable: boolean, extra?: Record<string, unknown>): void {
  console.error(JSON.stringify({ status: 'error', error: { code, message, retryable, ...extra } }));
}

export function isJsonFlagActive(): boolean {
  return process.argv.includes('--json');
}
