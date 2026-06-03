export function printJson(data: unknown): void {
  console.log(JSON.stringify({ status: 'ok', data }));
}

export function printJsonError(code: string, message: string, retryable: boolean): void {
  console.error(JSON.stringify({ status: 'error', error: { code, message, retryable } }));
}

export function isJsonFlagActive(): boolean {
  return process.argv.includes('--json');
}
