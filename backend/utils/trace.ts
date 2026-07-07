type TraceValue = string | number | boolean | null | undefined;

export type TraceFields = Record<string, TraceValue>;

function normalizeFields(fields?: TraceFields): Record<string, TraceValue> {
  const normalized: Record<string, TraceValue> = {
    ts: new Date().toISOString(),
  };
  if (!fields) return normalized;
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) normalized[key] = value;
  }
  return normalized;
}

export function logTrace(scope: string, event: string, fields?: TraceFields): void {
  const payload = normalizeFields(fields);
  console.log(`[Trace][${scope}] ${event} ${JSON.stringify(payload)}`);
}

export function warnTrace(scope: string, event: string, fields?: TraceFields): void {
  const payload = normalizeFields(fields);
  console.warn(`[Trace][${scope}] ${event} ${JSON.stringify(payload)}`);
}
