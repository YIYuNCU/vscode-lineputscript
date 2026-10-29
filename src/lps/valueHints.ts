/**
 * Plain-language hints for raw LPS values (hover text). Pure functions, no vscode dependency.
 * LinePutScript stores everything as strings, so these are guesses based on the value shape.
 */

const ticksPerMillisecond = 10000n;
const unixEpochTicks = 621355968000000000n;
const minTicks = 504911232000000000n; // 1601-01-01
const maxTicks = 3155378975999999999n; // 9999-12-31

const minUnixSeconds = 946684800; // 2000-01-01
const maxUnixSeconds = 4102444800; // 2100-01-01

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** `YYYY-MM-DD HH:mm:ss` from the UTC fields of `date`. */
function formatUtc(date: Date): string {
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} `
    + `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

/** Converts .NET `DateTime.Ticks` to a display string, or undefined when out of the valid range. */
export function formatDotNetTicks(value: string): string | undefined {
  if (!/^\d{16,19}$/.test(value)) {
    return undefined;
  }

  const ticks = BigInt(value);
  if (ticks < minTicks || ticks > maxTicks) {
    return undefined;
  }

  const unixMilliseconds = Number((ticks - unixEpochTicks) / ticksPerMillisecond);
  const date = new Date(unixMilliseconds);
  return Number.isNaN(date.getTime()) ? undefined : formatUtc(date);
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Returns one or more short descriptions of the value's likely type, or an empty array. */
export function describeValue(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return [];
  }

  const ticks = formatDotNetTicks(trimmed);
  if (ticks) {
    return [`.NET Ticks（DateTime.Ticks），约 ${ticks}（不含时区）`];
  }

  if (/^\d{10}$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (seconds >= minUnixSeconds && seconds <= maxUnixSeconds) {
      return [`可能是 Unix 秒时间戳：${formatUtc(new Date(seconds * 1000))} UTC`];
    }
  }

  if (/^\d{13}$/.test(trimmed)) {
    const milliseconds = Number(trimmed);
    if (milliseconds >= minUnixSeconds * 1000 && milliseconds <= maxUnixSeconds * 1000) {
      return [`可能是 Unix 毫秒时间戳：${formatUtc(new Date(milliseconds))} UTC`];
    }
  }

  if (/^(true|false)$/i.test(trimmed)) {
    return ["布尔值"];
  }

  const integer = /^(-?)(\d+)$/.exec(trimmed);
  if (integer) {
    const digits = integer[2].replace(/^0+(?=\d)/, "");
    return [digits.length > 4 ? `整数 ${integer[1]}${groupThousands(digits)}` : "整数"];
  }

  if (/^-?\d+\.\d+$/.test(trimmed)) {
    return ["小数"];
  }

  return [];
}
