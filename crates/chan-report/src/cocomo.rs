use serde::{Deserialize, Serialize};

/// Basic COCOMO model. Coefficients live in `coefficients`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
pub enum CocomoModel {
    #[default]
    Organic,
    SemiDetached,
    Embedded,
}

impl CocomoModel {
    /// (a, b, c, d) for `effort = a * KSLOC^b`,
    /// `schedule = c * effort^d`.
    pub fn coefficients(self) -> (f64, f64, f64, f64) {
        match self {
            CocomoModel::Organic => (2.4, 1.05, 2.5, 0.38),
            CocomoModel::SemiDetached => (3.0, 1.12, 2.5, 0.35),
            CocomoModel::Embedded => (3.6, 1.20, 2.5, 0.32),
        }
    }

    /// Stable string label written to the JSONL `cocomo.model`
    /// field. Consumers parse this back into a variant via
    /// matching on the literal.
    pub fn label(self) -> &'static str {
        match self {
            CocomoModel::Organic => "basic-organic",
            CocomoModel::SemiDetached => "basic-semi-detached",
            CocomoModel::Embedded => "basic-embedded",
        }
    }
}

/// Tunable inputs to the cost calculation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CocomoParams {
    pub model: CocomoModel,
    pub avg_monthly_salary_usd: f64,
    /// Multiplier applied on top of salary to approximate fully-
    /// loaded cost (benefits, equipment, facilities). 2.4 is the
    /// default Boehm used in the original paper.
    pub overhead_multiplier: f64,
}

impl Default for CocomoParams {
    fn default() -> Self {
        Self {
            model: CocomoModel::Organic,
            avg_monthly_salary_usd: 8_000.0,
            overhead_multiplier: 2.4,
        }
    }
}

/// JSONL `kind: "cocomo"` record.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct CocomoSummary {
    pub model: String,
    pub effort_person_months: f64,
    pub schedule_months: f64,
    pub developers: f64,
    pub estimated_cost_usd: f64,
}

/// Compute the summary from total SLOC. Pure function; no I/O.
pub(crate) fn compute(total_sloc: u64, params: &CocomoParams) -> CocomoSummary {
    let label = params.model.label().to_string();
    if total_sloc == 0 {
        return CocomoSummary {
            model: label,
            ..Default::default()
        };
    }
    let (a, b, c, d) = params.model.coefficients();
    let ksloc = total_sloc as f64 / 1000.0;
    let effort = a * ksloc.powf(b);
    let schedule = c * effort.powf(d);
    let developers = if schedule > 0.0 {
        effort / schedule
    } else {
        0.0
    };
    let cost = effort * params.avg_monthly_salary_usd * params.overhead_multiplier;
    CocomoSummary {
        model: label,
        effort_person_months: round2(effort),
        schedule_months: round2(schedule),
        developers: round2(developers),
        estimated_cost_usd: round2(cost),
    }
}

fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_sloc_zero_effort() {
        let s = compute(0, &CocomoParams::default());
        assert_eq!(s.effort_person_months, 0.0);
        assert_eq!(s.schedule_months, 0.0);
        assert_eq!(s.estimated_cost_usd, 0.0);
        assert_eq!(s.model, "basic-organic");
    }

    #[test]
    fn known_organic_value() {
        // 32 KSLOC, organic: effort = 2.4 * 32^1.05 ~= 91.34
        let s = compute(32_000, &CocomoParams::default());
        assert!((s.effort_person_months - 91.34).abs() < 0.5);
        assert!(s.schedule_months > 0.0);
        assert!(s.developers > 0.0);
        assert!(s.estimated_cost_usd > 0.0);
    }

    #[test]
    fn embedded_costs_more_than_organic() {
        let organic = compute(10_000, &CocomoParams::default());
        let embedded = compute(
            10_000,
            &CocomoParams {
                model: CocomoModel::Embedded,
                ..CocomoParams::default()
            },
        );
        assert!(embedded.effort_person_months > organic.effort_person_months);
    }
}
