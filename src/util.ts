export function safeStringify(obj: any): string {
  return JSON.stringify(obj, (_, value) =>
    typeof value === 'bigint' ? `${value}n` : value
  );
}