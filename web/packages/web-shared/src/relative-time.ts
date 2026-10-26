/** A notice's age in words, using its event time in milliseconds. */
export function relativeAge(atMs: number, nowMs: number): string {
  const elapsed = Math.max(0, nowMs - atMs);
  if (elapsed < 60_000) return "just now";
  if (elapsed < 3_600_000) {
    const count = Math.floor(elapsed / 60_000);
    return `${count} minute${count === 1 ? "" : "s"} ago`;
  }
  if (elapsed < 86_400_000) {
    const count = Math.floor(elapsed / 3_600_000);
    return `${count} hour${count === 1 ? "" : "s"} ago`;
  }
  if (elapsed < 7 * 86_400_000) {
    const count = Math.floor(elapsed / 86_400_000);
    return `${count} day${count === 1 ? "" : "s"} ago`;
  }
  return new Date(atMs).toISOString().slice(0, 10);
}

/** Local date and time with the numeric UTC offset, including DST at the event. */
export function exactStamp(atMs: number): string {
  const date = new Date(atMs);
  const pad = (part: number) => String(part).padStart(2, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "-" : "+";
  const offset = `${sign}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${offset}`;
}
