/// What runs in a terminal, as its server reads it once beside the output:
/// the title the foreground program last set with OSC 0 or OSC 2, and the
/// name of the foreground command. Each is null when unknown, and the pair
/// always arrives whole, replacing the one before.
export type TerminalProgram = { title: string | null; command: string | null };

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/// The reading a `session` or `program` frame carries, or undefined when it
/// carries none: a server that predates the reading sends no field, and a
/// value that is not an object reads as none rather than as a stale pair.
export function terminalProgramFromWire(value: unknown): TerminalProgram | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const wire = value as Record<string, unknown>;
  return { title: text(wire.title), command: text(wire.command) };
}

/// The text shown beside a terminal's name: the program's title, else its
/// command, null when the reading holds neither.
export function terminalProgramText(reading: TerminalProgram | undefined): string | null {
  return reading?.title ?? reading?.command ?? null;
}
