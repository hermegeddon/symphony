export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface StructuredLogEntry {
  readonly level: LogLevel;
  readonly event: string;
  readonly outcome: string;
  readonly issue_id?: string;
  readonly issue_identifier?: string;
  readonly session_id?: string;
  readonly reason?: string;
  readonly [key: string]: unknown;
}

const OMITTED_LOG_KEYS = new Set(['raw_payload', 'payload', 'large_payload', 'body', 'response_body']);
const ORDERED_KEYS = ['level', 'event', 'outcome', 'issue_id', 'issue_identifier', 'session_id', 'reason'] as const;

export function formatStructuredLogLine(entry: StructuredLogEntry): string {
  const parts: string[] = [];
  for (const key of ORDERED_KEYS) {
    const value = entry[key];
    if (value !== undefined) {
      parts.push(`${key}=${formatLogValue(value)}`);
    }
  }

  const orderedKeySet = new Set<string>(ORDERED_KEYS);
  for (const key of Object.keys(entry).sort()) {
    if (orderedKeySet.has(key) || OMITTED_LOG_KEYS.has(key)) {
      continue;
    }
    const value = entry[key];
    if (isScalarLogValue(value)) {
      parts.push(`${key}=${formatLogValue(value)}`);
    }
  }
  return parts.join(' ');
}

export class StructuredLogger {
  public constructor(private readonly sink: (line: string) => void = (line) => process.stderr.write(`${line}\n`)) {}

  public write(entry: StructuredLogEntry): void {
    try {
      this.sink(formatStructuredLogLine(entry));
    } catch {
      // Observability is best-effort: a failing sink must not bring down orchestration.
    }
  }
}

function isScalarLogValue(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function formatLogValue(value: unknown): string {
  if (typeof value === 'string') {
    if (/^[A-Za-z0-9._:/@+-]+$/.test(value)) {
      return value;
    }
    return JSON.stringify(value.length > 240 ? `${value.slice(0, 237)}...` : value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value === null) {
    return 'null';
  }
  return JSON.stringify('[non-scalar]');
}
