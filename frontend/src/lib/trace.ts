type TraceValue = string | number | boolean | null | undefined;

export type TraceFields = Record<string, TraceValue>;

export function logTrace(scope: string, event: string, fields?: TraceFields): void {
  const payload: Record<string, TraceValue> = {
    ts: new Date().toISOString(),
  };
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) payload[key] = value;
    }
  }
  console.info(`[Trace][${scope}] ${event}`, payload);
}
