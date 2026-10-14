export function failureDetail(error: unknown): string {
  const stderr =
    typeof error === 'object' &&
    error !== null &&
    'stderr' in error &&
    typeof error.stderr === 'string'
      ? error.stderr
      : '';

  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  return (
    lines.find((line) => /^(fatal|error):/i.test(line)) ??
    lines.at(-1) ??
    (error instanceof Error ? error.message : String(error))
  );
}
