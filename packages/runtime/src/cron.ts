const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const DEFAULT_SEARCH_MINUTES = 8 * 366 * 24 * 60;
export const MAX_CRON_SEARCH_MINUTES = DEFAULT_SEARCH_MINUTES;

interface CronField {
  values: ReadonlySet<number>;
  unrestricted: boolean;
}

export interface ParsedCronExpression {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

export interface CronSearchOptions {
  maxSearchMinutes?: number;
}

export class CronExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronExpressionError";
  }
}

export class CronSearchExhaustedError extends Error {
  constructor() {
    super("No cron occurrence was found inside the configured search window.");
    this.name = "CronSearchExhaustedError";
  }
}

function cronInteger(value: string, label: string): number {
  if (!/^\d+$/.test(value)) {
    throw new CronExpressionError(`${label} contains a non-numeric value.`);
  }
  return Number(value);
}

function addRange(
  output: Set<number>,
  start: number,
  end: number,
  step: number,
  minimum: number,
  maximum: number,
  normalize: (value: number) => number,
  label: string,
): void {
  if (start < minimum || start > maximum || end < minimum || end > maximum) {
    throw new CronExpressionError(`${label} is outside ${minimum}-${maximum}.`);
  }
  if (start > end) {
    throw new CronExpressionError(`${label} ranges may not wrap.`);
  }
  for (let value = start; value <= end; value += step) {
    output.add(normalize(value));
  }
}

function parseField(
  source: string,
  minimum: number,
  maximum: number,
  label: string,
  normalize: (value: number) => number = (value) => value,
): CronField {
  if (!source) throw new CronExpressionError(`${label} is empty.`);
  const output = new Set<number>();
  for (const segment of source.split(",")) {
    if (!segment)
      throw new CronExpressionError(`${label} contains an empty item.`);
    const slash = segment.split("/");
    if (slash.length > 2) {
      throw new CronExpressionError(`${label} contains an invalid step.`);
    }
    const base = slash[0] ?? "";
    const step = slash[1] === undefined ? 1 : cronInteger(slash[1], label);
    if (step < 1 || step > maximum - minimum + 1) {
      throw new CronExpressionError(`${label} contains an invalid step.`);
    }
    if (base === "*") {
      addRange(
        output,
        minimum,
        maximum,
        step,
        minimum,
        maximum,
        normalize,
        label,
      );
      continue;
    }
    const range = base.split("-");
    if (range.length > 2 || !range[0]) {
      throw new CronExpressionError(`${label} contains an invalid range.`);
    }
    const start = cronInteger(range[0], label);
    const end =
      range[1] === undefined
        ? slash[1]
          ? maximum
          : start
        : cronInteger(range[1], label);
    addRange(output, start, end, step, minimum, maximum, normalize, label);
  }
  const fullSize = new Set(
    Array.from({ length: maximum - minimum + 1 }, (_, index) =>
      normalize(minimum + index),
    ),
  ).size;
  return { values: output, unrestricted: output.size === fullSize };
}

export function parseCronExpression(expression: string): ParsedCronExpression {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CronExpressionError(
      "Cron expressions must contain minute, hour, day-of-month, month, and day-of-week fields.",
    );
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  return {
    minute: parseField(minute ?? "", 0, 59, "minute"),
    hour: parseField(hour ?? "", 0, 23, "hour"),
    dayOfMonth: parseField(dayOfMonth ?? "", 1, 31, "day-of-month"),
    month: parseField(month ?? "", 1, 12, "month"),
    dayOfWeek: parseField(dayOfWeek ?? "", 0, 7, "day-of-week", (value) =>
      value === 7 ? 0 : value,
    ),
  };
}

interface LocalMinute {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    throw new CronExpressionError("timezone is not a supported IANA timezone.");
  }
}

function localMinute(
  dateFormatter: Intl.DateTimeFormat,
  instantMs: number,
): LocalMinute {
  const parts: Record<string, string> = {};
  for (const part of dateFormatter.formatToParts(new Date(instantMs))) {
    parts[part.type] = part.value;
  }
  const numberPart = (name: string): number => {
    const value = parts[name];
    if (!value) throw new CronExpressionError("timezone conversion failed.");
    return Number(value);
  };
  return {
    year: numberPart("year"),
    month: numberPart("month"),
    day: numberPart("day"),
    hour: numberPart("hour"),
    minute: numberPart("minute"),
  };
}

function wallMinuteMs(value: LocalMinute): number {
  return Date.UTC(
    value.year,
    value.month - 1,
    value.day,
    value.hour,
    value.minute,
  );
}

function offsetMinutes(
  dateFormatter: Intl.DateTimeFormat,
  instantMs: number,
): number {
  const instantMinute = Math.floor(instantMs / MINUTE_MS) * MINUTE_MS;
  return (
    (wallMinuteMs(localMinute(dateFormatter, instantMinute)) - instantMinute) /
    MINUTE_MS
  );
}

function possibleOffsets(
  dateFormatter: Intl.DateTimeFormat,
  afterMs: number,
  searchMinutes: number,
): readonly number[] {
  const offsets = new Set<number>();
  const start = afterMs - 370 * DAY_MS;
  const end = afterMs + searchMinutes * MINUTE_MS + 370 * DAY_MS;
  for (let instant = start; instant <= end; instant += DAY_MS) {
    offsets.add(offsetMinutes(dateFormatter, instant));
  }
  offsets.add(offsetMinutes(dateFormatter, afterMs));
  return [...offsets].sort((left, right) => left - right);
}

function matches(expression: ParsedCronExpression, wallMs: number): boolean {
  const date = new Date(wallMs);
  const month = date.getUTCMonth() + 1;
  if (
    !expression.minute.values.has(date.getUTCMinutes()) ||
    !expression.hour.values.has(date.getUTCHours()) ||
    !expression.month.values.has(month)
  ) {
    return false;
  }
  const dayOfMonthMatches = expression.dayOfMonth.values.has(date.getUTCDate());
  const dayOfWeekMatches = expression.dayOfWeek.values.has(date.getUTCDay());
  if (expression.dayOfMonth.unrestricted) return dayOfWeekMatches;
  if (expression.dayOfWeek.unrestricted) return dayOfMonthMatches;
  return dayOfMonthMatches || dayOfWeekMatches;
}

function resolvesToWallMinute(
  dateFormatter: Intl.DateTimeFormat,
  candidateMs: number,
  wallMs: number,
): boolean {
  return wallMinuteMs(localMinute(dateFormatter, candidateMs)) === wallMs;
}

/**
 * Returns the first instant strictly after `after`. Nonexistent DST wall times
 * are skipped; repeated wall times are returned once for each real instant.
 */
export function nextCronOccurrence(
  expressionValue: string,
  timeZone: string,
  after: Date | string,
  options: CronSearchOptions = {},
): Date {
  const expression = parseCronExpression(expressionValue);
  const afterDate = typeof after === "string" ? new Date(after) : after;
  const afterMs = afterDate.getTime();
  if (!Number.isFinite(afterMs)) {
    throw new CronExpressionError("after must be a valid instant.");
  }
  const maxSearchMinutes = options.maxSearchMinutes ?? DEFAULT_SEARCH_MINUTES;
  if (
    !Number.isSafeInteger(maxSearchMinutes) ||
    maxSearchMinutes < 1 ||
    maxSearchMinutes > MAX_CRON_SEARCH_MINUTES
  ) {
    throw new CronExpressionError(
      `maxSearchMinutes must be an integer between 1 and ${MAX_CRON_SEARCH_MINUTES}.`,
    );
  }
  const dateFormatter = formatter(timeZone);
  // Force Intl to validate lazy implementations before beginning the search.
  localMinute(dateFormatter, afterMs);
  const offsets = possibleOffsets(dateFormatter, afterMs, maxSearchMinutes);
  const minimumOffset = offsets[0] ?? 0;
  const maximumOffset = offsets.at(-1) ?? 0;
  const offsetSpan = maximumOffset - minimumOffset;
  const localAfterMs = wallMinuteMs(localMinute(dateFormatter, afterMs));
  const searchStart = localAfterMs - offsetSpan * MINUTE_MS;
  const searchEnd = localAfterMs + maxSearchMinutes * MINUTE_MS;
  let best: number | undefined;

  for (let wallMs = searchStart; wallMs <= searchEnd; wallMs += MINUTE_MS) {
    if (best !== undefined && wallMs - maximumOffset * MINUTE_MS > best) {
      return new Date(best);
    }
    if (!matches(expression, wallMs)) continue;
    for (const offset of offsets) {
      const candidate = wallMs - offset * MINUTE_MS;
      if (
        candidate <= afterMs ||
        candidate > afterMs + maxSearchMinutes * MINUTE_MS ||
        !resolvesToWallMinute(dateFormatter, candidate, wallMs)
      ) {
        continue;
      }
      if (best === undefined || candidate < best) best = candidate;
    }
  }
  if (best !== undefined) return new Date(best);
  throw new CronSearchExhaustedError();
}
