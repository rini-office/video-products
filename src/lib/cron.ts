/**
 * Minimal cron expression parser — calculates the next run time.
 * Supports standard 5-field cron: minute hour dayOfMonth month dayOfWeek
 * with wildcard (*), specific values, and step values (/N).
 */

interface CronFields {
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
}

function parseField(field: string, min: number, max: number): number[] {
  if (field === '*') {
    return Array.from({ length: max - min + 1 }, (_, i) => min + i);
  }

  const values = new Set<number>();

  for (const part of field.split(',')) {
    if (part.includes('/')) {
      const [range, stepStr] = part.split('/');
      const step = parseInt(stepStr, 10);
      const [rangeMin, rangeMax] = range === '*'
        ? [min, max]
        : range.split('-').map(Number);

      for (let i = rangeMin; i <= rangeMax; i += step) {
        values.add(i);
      }
    } else if (part.includes('-')) {
      const [rangeMin, rangeMax] = part.split('-').map(Number);
      for (let i = rangeMin; i <= rangeMax; i++) {
        values.add(i);
      }
    } else {
      values.add(parseInt(part, 10));
    }
  }

  return Array.from(values).sort((a, b) => a - b);
}

function parseCron(cronExpression: string): CronFields {
  const parts = cronExpression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: "${cronExpression}". Expected 5 fields.`);
  }
  return {
    minute: parseField(parts[0], 0, 59),
    hour: parseField(parts[1], 0, 23),
    dayOfMonth: parseField(parts[2], 1, 31),
    month: parseField(parts[3], 1, 12),
    dayOfWeek: parseField(parts[4], 0, 6),
  };
}

/**
 * Get date components in a specific timezone using Intl.DateTimeFormat.
 */
function getTimeComponents(date: Date, timezone: string): {
  year: number; month: number; day: number; hour: number; minute: number; dayOfWeek: number;
} {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const map: Record<string, number> = {};

  for (const part of parts) {
    if (part.type === 'year' || part.type === 'month' || part.type === 'day' ||
        part.type === 'hour' || part.type === 'minute') {
      map[part.type] = parseInt(part.value, 10);
    }
    if (part.type === 'weekday') {
      const weekdays: Record<string, number> = {
        'Sun': 0, 'Mon': 1, 'Tue': 2, 'Wed': 3, 'Thu': 4, 'Fri': 5, 'Sat': 6,
      };
      map['dayOfWeek'] = weekdays[part.value] ?? 0;
    }
  }

  // Intl gives month 01-12, we want 1-12
  return {
    year: map.year,
    month: map.month,
    day: map.day,
    hour: map.hour,
    minute: map.minute,
    dayOfWeek: map.dayOfWeek,
  };
}

/**
 * Check if the current time (in the given timezone) matches a cron expression.
 */
function matchesCronNow(cronExpression: string, now: Date, timezone: string): boolean {
  const parts = cronExpression.trim().split(/\s+/);
  const fields = parseCron(cronExpression);
  const t = getTimeComponents(now, timezone);

  if (!fields.minute.includes(t.minute)) return false;
  if (!fields.hour.includes(t.hour)) return false;

  // dayOfMonth — only check if the field is not wildcard
  if (parts[2] !== '*') {
    if (!fields.dayOfMonth.includes(t.day)) return false;
  }

  // month — only check if not wildcard
  if (parts[3] !== '*') {
    if (!fields.month.includes(t.month)) return false;
  }

  // dayOfWeek — only check if not wildcard
  if (parts[4] !== '*') {
    if (!fields.dayOfWeek.includes(t.dayOfWeek)) return false;
  }

  return true;
}

/**
 * Check if it's time to run based on the cron expression, timezone, and last run time.
 * Called by the Vercel Cron endpoint (runs every ~5 min) to decide whether to execute.
 */
export function shouldRunCron(
  cronExpression: string,
  lastRunIso: string | undefined,
  now: Date = new Date(),
  timezone: string = 'UTC'
): boolean {
  if (!lastRunIso) return true;

  if (!matchesCronNow(cronExpression, now, timezone)) return false;

  // Prevent re-execution within the same slot: if last run was < 4 min ago, skip
  const lastRun = new Date(lastRunIso).getTime();
  return (now.getTime() - lastRun) > 4 * 60 * 1000;
}

/**
 * Calculate the next cron run time in the given timezone (for countdown display).
 */
export function getNextCronTime(
  cronExpression: string,
  from: Date = new Date(),
  timezone: string = 'UTC'
): Date {
  const fields = parseCron(cronExpression);
  const t = getTimeComponents(from, timezone);

  // Start from the current minute + 1
  let minute = t.minute + 1;
  let hour = t.hour;
  let day = t.day;
  let month = t.month;
  let year = t.year;

  // Search forward up to 4 years
  const maxYear = year + 4;

  for (let y = year; y <= maxYear; y++) {
    const mStart = y === year ? month : 1;
    for (let m = mStart; m <= 12; m++) {
      const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();

      const dStart = (y === year && m === month) ? day : 1;
      for (let d = dStart; d <= daysInMonth; d++) {
        // Check dayOfMonth
        if (!fields.dayOfMonth.includes(d)) continue;

        // Check month
        if (!fields.month.includes(m)) continue;

        // Check dayOfWeek — compute via UTC date since we only care about the weekday number
        const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
        if (!fields.dayOfWeek.includes(dow)) continue;

        const hStart = (y === year && m === month && d === day) ? hour : 0;
        for (let h = hStart; h <= 23; h++) {
          if (!fields.hour.includes(h)) continue;

          const minStart = (y === year && m === month && d === day && h === hour) ? minute : 0;
          for (let min = minStart; min <= 59; min++) {
            if (!fields.minute.includes(min)) continue;

            // Found! Now we need to construct the date in the target timezone
            // We have year, month, day, hour, minute in the target timezone
            // We need to figure out the UTC equivalent
            const localDateStr = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}T${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}:00`;
            
            // Use a trick: parse the date string, then figure out the offset
            // Intl.DateTimeFormat can give us the UTC equivalent
            const utcMs = Date.parse(localDateStr);
            if (!isNaN(utcMs)) {
              // Date.parse assumes local timezone of the runtime (UTC on Vercel)
              // We need to adjust: the localDateStr represents time in the TARGET timezone
              // So we need to shift by the timezone offset
              
              // Calculate the offset between target timezone and UTC at this moment
              const jan1 = new Date(Date.UTC(y, 0, 1));
              const july1 = new Date(Date.UTC(y, 6, 1));
              const jan1Target = getTimeComponents(jan1, timezone);
              const july1Target = getTimeComponents(july1, timezone);
              
              // Get approximate offset
              const jan1Utc = new Date(Date.UTC(y, 0, 1, jan1Target.hour, jan1Target.minute));
              const offsetMs = jan1.getTime() - jan1Utc.getTime();
              
              const candidate = new Date(utcMs + offsetMs);
              if (candidate > from) {
                return candidate;
              }
            }
          }
        }
        // Reset hour for next day
        hour = 0;
      }
      minute = 0;
    }
  }

  throw new Error(`No next cron time found within 4 years for "${cronExpression}"`);
}

/**
 * Human-readable description of a cron expression (for common patterns).
 */
export function describeCron(cronExpression: string): string {
  const parts = cronExpression.trim().split(/\s+/);
  if (parts.length !== 5) return cronExpression;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    if (hour === '*' && minute === '*') return 'Every minute';
    if (hour === '*' && !minute.includes('*')) return `Every hour at minute ${minute}`;
    if (!hour.includes('*') && !minute.includes('*')) {
      const h = parseInt(hour, 10);
      const m = parseInt(minute, 10);
      const period = h >= 12 ? 'PM' : 'AM';
      const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
      return `Daily at ${h12}:${m.toString().padStart(2, '0')} ${period}`;
    }
  }

  return cronExpression;
}
