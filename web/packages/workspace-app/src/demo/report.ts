// chan-reports for the test transport. Per-file stats (language, SLOC,
// comments, blanks, complexity) arrive with the MockWorkspaceData; this
// module serves per-file rows and rolls them up per language + totals, with
// Basic COCOMO, matching chan-report's shapes and formulas
// (crates/chan-report: summary.rs, cocomo.rs).

import type {
  ReportCocomoSummary,
  ReportFileStats,
  ReportLanguageStats,
  ReportPrefix,
  ReportTotals,
} from "../api/types";

function zeroTotals(): ReportTotals {
  return { files: 0, bytes: 0, code: 0, comments: 0, blanks: 0, complexity: 0 };
}

// Basic COCOMO, Organic model, from chan-report/cocomo.rs: effort = a*KSLOC^b,
// schedule = c*effort^d, cost = effort * $8000/mo * 2.4 overhead.
function cocomo(totalCode: number): ReportCocomoSummary {
  const model = "basic-organic";
  if (totalCode === 0) {
    return { model, effort_person_months: 0, schedule_months: 0, developers: 0, estimated_cost_usd: 0 };
  }
  const a = 2.4, b = 1.05, c = 2.5, d = 0.38;
  const salary = 8000, overhead = 2.4;
  const ksloc = totalCode / 1000;
  const effort = a * ksloc ** b;
  const schedule = c * effort ** d;
  const developers = schedule > 0 ? effort / schedule : 0;
  const cost = effort * salary * overhead;
  const r2 = (x: number): number => Math.round(x * 100) / 100;
  return {
    model,
    effort_person_months: r2(effort),
    schedule_months: r2(schedule),
    developers: r2(developers),
    estimated_cost_usd: r2(cost),
  };
}

function rollup(rows: ReportFileStats[]): ReportPrefix {
  const totals = zeroTotals();
  const byLang = new Map<string, ReportLanguageStats>();
  for (const r of rows) {
    totals.files++;
    totals.bytes = (totals.bytes ?? 0) + r.bytes;
    totals.code += r.code;
    totals.comments += r.comments;
    totals.blanks += r.blanks;
    totals.complexity += r.complexity;
    let l = byLang.get(r.language);
    if (!l) {
      l = { name: r.language, files: 0, bytes: 0, code: 0, comments: 0, blanks: 0, complexity: 0 };
      byLang.set(r.language, l);
    }
    l.files++;
    l.bytes = (l.bytes ?? 0) + r.bytes;
    l.code += r.code;
    l.comments += r.comments;
    l.blanks += r.blanks;
    l.complexity += r.complexity;
  }
  const by_language = [...byLang.values()].sort((a, z) => z.code - a.code || a.name.localeCompare(z.name));
  return { totals, by_language, cocomo: cocomo(totals.code) };
}

export class MockReports {
  #byPath = new Map<string, ReportFileStats>();
  #rows: ReportFileStats[];

  constructor(rows: ReportFileStats[]) {
    this.#rows = rows;
    for (const r of rows) this.#byPath.set(r.path, r);
  }

  /// Per-file stats, or null when the file has no report (media, binary,
  /// unrecognized language) - which the inspector renders as "no report".
  file(path: string): ReportFileStats | null {
    return this.#byPath.get(path) ?? null;
  }

  /// Roll-up for a subtree. Empty path is the whole-workspace roll-up.
  prefix(path: string): ReportPrefix {
    const rows =
      path === ""
        ? this.#rows
        : this.#rows.filter((r) => r.path === path || r.path.startsWith(`${path}/`));
    return rollup(rows);
  }
}
