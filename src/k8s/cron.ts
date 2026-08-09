/**
 * The cron schedule format `spec.schedule` on a CronJob is parsed with:
 * `pkg/apis/batch/validation.validateScheduleFormat` calls
 * `pkg/util/parsers.ParseCronScheduleWithPanicRecovery`, which wraps
 * `github.com/robfig/cron/v3`'s `ParseStandard`. That accepts three shapes —
 * a fixed set of descriptors ("@daily"), "@every <duration>" in Go's
 * `time.ParseDuration` syntax, or five whitespace-separated fields (minute,
 * hour, day of month, month, day of week) — and this mirrors its parser
 * closely enough to catch the same malformed schedules, field by field.
 *
 * The `TZ=`/`CRON_TZ=` prefix `ParseStandard` also understands is deliberately
 * not handled here: `validateScheduleFormat` rejects it outright once
 * `spec.timeZone` exists to say the same thing, so `rules/cronjob.ts` checks
 * for it directly, beside the field that makes it redundant.
 */

import type { FormatCheck } from './names.js';

interface FieldBounds {
  min: number;
  max: number;
  names?: Record<string, number>;
}

// https://github.com/robfig/cron/blob/v3.0.1/spec.go — the bounds robfig/cron
// checks each field against; ParseStandard has no seconds field.
const MINUTE: FieldBounds = { min: 0, max: 59 };
const HOUR: FieldBounds = { min: 0, max: 23 };
const DAY_OF_MONTH: FieldBounds = { min: 1, max: 31 };
const MONTH: FieldBounds = {
  min: 1,
  max: 12,
  names: { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 },
};
const DAY_OF_WEEK: FieldBounds = {
  min: 0,
  max: 6,
  names: { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 },
};

const FIELDS: ReadonlyArray<readonly [string, FieldBounds]> = [
  ['minute', MINUTE],
  ['hour', HOUR],
  ['day of month', DAY_OF_MONTH],
  ['month', MONTH],
  ['day of week', DAY_OF_WEEK],
];

const DESCRIPTORS = new Set([
  '@yearly',
  '@annually',
  '@monthly',
  '@weekly',
  '@daily',
  '@midnight',
  '@hourly',
]);

/** `spec.schedule` — https://en.wikipedia.org/wiki/Cron, robfig/cron's dialect. */
export function isCronSchedule(value: string): FormatCheck {
  if (value.length === 0) return { ok: false, reason: 'must not be empty' };

  if (value.startsWith('@')) {
    if (DESCRIPTORS.has(value)) return { ok: true };
    if (value.startsWith('@every ')) {
      const duration = value.slice('@every '.length);
      return isGoDuration(duration)
        ? { ok: true }
        : {
            ok: false,
            reason: `has a duration ("${duration}") that is not valid Go duration syntax, such as "1h30m"`,
          };
    }
    return {
      ok: false,
      reason:
        'is not a recognised descriptor — @yearly, @monthly, @weekly, @daily, @hourly or "@every <duration>"',
    };
  }

  const fields = value.trim().split(/\s+/);
  if (fields.length !== 5) {
    return {
      ok: false,
      reason: `must have 5 fields (minute hour day-of-month month day-of-week), but has ${fields.length}`,
    };
  }

  for (const [index, [label, bounds]] of FIELDS.entries()) {
    const check = isCronField(fields[index]!, bounds);
    if (!check.ok) return { ok: false, reason: `${label} field "${fields[index]}" ${check.reason}` };
  }
  return { ok: true };
}

/** A field is a comma-separated list of ranges. */
function isCronField(field: string, bounds: FieldBounds): FormatCheck {
  for (const range of field.split(',')) {
    const check = isCronRange(range, bounds);
    if (!check.ok) return check;
  }
  return { ok: true };
}

/** A range is `value | value "-" value`, optionally followed by `"/" step`. */
function isCronRange(expr: string, bounds: FieldBounds): FormatCheck {
  const slashParts = expr.split('/');
  if (slashParts.length > 2) return { ok: false, reason: 'has more than one "/"' };

  const [rangePart, stepPart] = slashParts;
  const dashParts = rangePart!.split('-');
  if (dashParts.length > 2) return { ok: false, reason: 'has more than one "-"' };

  let start: number;
  let end: number;
  const [low, high] = dashParts;
  if (low === '*' || low === '?') {
    start = bounds.min;
    end = bounds.max;
  } else {
    const parsedLow = parseCronValue(low!, bounds);
    if (parsedLow === undefined) return { ok: false, reason: `has "${low}", which is not a valid value` };
    start = parsedLow;
    end = start;
    if (high !== undefined) {
      const parsedHigh = parseCronValue(high, bounds);
      if (parsedHigh === undefined) {
        return { ok: false, reason: `has "${high}", which is not a valid value` };
      }
      end = parsedHigh;
    }
  }

  if (start < bounds.min || start > bounds.max || end < bounds.min || end > bounds.max) {
    return { ok: false, reason: `must be between ${bounds.min} and ${bounds.max}` };
  }
  if (start > end) {
    return { ok: false, reason: `starts (${start}) after it ends (${end})` };
  }

  if (stepPart !== undefined) {
    if (!/^\d+$/.test(stepPart)) {
      return { ok: false, reason: `has a step ("${stepPart}") that is not a whole number` };
    }
    if (Number(stepPart) === 0) return { ok: false, reason: 'has a step of 0, which is not a positive number' };
  }

  return { ok: true };
}

function parseCronValue(text: string, bounds: FieldBounds): number | undefined {
  const named = bounds.names?.[text.toLowerCase()];
  if (named !== undefined) return named;
  return /^\d+$/.test(text) ? Number(text) : undefined;
}

/**
 * Go's `time.ParseDuration`: a signed sequence of decimal numbers, each with
 * an optional fraction and a unit ("ns", "us"/"µs", "ms", "s", "m", "h"),
 * such as "300ms" or "2h45m" — or the bare literal "0", the one case Go
 * accepts without a unit.
 */
function isGoDuration(value: string): boolean {
  if (value === '0') return true;
  const unsigned = value.startsWith('+') || value.startsWith('-') ? value.slice(1) : value;
  if (unsigned.length === 0) return false;

  const component = /(\d+(?:\.\d*)?|\.\d+)(ns|us|µs|ms|s|m|h)/y;
  let consumed = 0;
  while (consumed < unsigned.length) {
    component.lastIndex = consumed;
    const match = component.exec(unsigned);
    if (!match) return false;
    consumed += match[0].length;
  }
  return consumed === unsigned.length && consumed > 0;
}
