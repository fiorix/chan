use std::time::Instant;

#[derive(Debug)]
pub(crate) enum SessionState {
    Clean,
    Dirty {
        since: Instant,
    },
    Observing {
        dirty_since: Option<Instant>,
        observation: DiskObservation,
    },
    Conflicted(SessionConflict),
    Removed,
}

#[derive(Debug)]
pub(crate) enum DiskObservation {
    Content {
        hash: u64,
        mtime_ns: Option<i64>,
        seen: Instant,
    },
    Removal {
        seen: Instant,
    },
}

#[derive(Debug)]
pub(crate) struct DurableBaseline {
    pub(crate) content: String,
    pub(crate) content_hash: u64,
    pub(crate) mtime_ns: Option<i64>,
    pub(crate) authority_version: u64,
}

#[derive(Debug)]
pub(crate) struct SessionConflict {
    pub(crate) id: String,
    pub(crate) baseline_version: u64,
    pub(crate) disk_version: u64,
    pub(crate) authority_version: u64,
    pub(crate) disk_mtime_ns: Option<i64>,
    pub(crate) disk_content: String,
}

/// Three-way merge result consumed by the session state transition.
pub(crate) enum MergeOutcome {
    Merged(String),
    Conflict,
}

/// Result of the conflict-aware PUT mutation gate.
pub(crate) enum HttpReplaceOutcome {
    Applied,
    PreconditionRequired {
        current_version: u64,
        disk_mtime_ns: Option<i64>,
    },
    Stale {
        current_version: u64,
        disk_mtime_ns: Option<i64>,
    },
    Conflicted {
        disk_mtime_ns: Option<i64>,
    },
}

pub(crate) struct HttpWriteView {
    pub(crate) disk_mtime_ns: Option<i64>,
    pub(crate) authority_version: u64,
    pub(crate) conflict_mtime_ns: Option<Option<i64>>,
    pub(crate) write_budget: u64,
}

pub(crate) struct HttpReadView {
    pub(crate) content: String,
    pub(crate) disk_mtime_ns: Option<i64>,
    pub(crate) authority_version: u64,
    pub(crate) disk_conflicted: bool,
}

impl SessionState {
    pub(crate) fn dirty_since(&self) -> Option<Instant> {
        match self {
            Self::Dirty { since } => Some(*since),
            Self::Observing { dirty_since, .. } => *dirty_since,
            _ => None,
        }
    }

    pub(crate) fn is_dirty(&self) -> bool {
        self.dirty_since().is_some() || matches!(self, Self::Conflicted(_))
    }

    pub(crate) fn mark_dirty(&mut self, authority_version: u64) {
        match self {
            Self::Clean | Self::Removed => {
                *self = Self::Dirty {
                    since: Instant::now(),
                };
            }
            Self::Dirty { .. } => {}
            Self::Observing { dirty_since, .. } => {
                dirty_since.get_or_insert_with(Instant::now);
            }
            Self::Conflicted(conflict) => conflict.authority_version = authority_version,
        }
    }

    pub(crate) fn observe_content(&mut self, hash: u64, mtime_ns: Option<i64>) {
        if matches!(self, Self::Conflicted(_)) {
            return;
        }
        let dirty_since = self.dirty_since();
        *self = Self::Observing {
            dirty_since,
            observation: DiskObservation::Content {
                hash,
                mtime_ns,
                seen: Instant::now(),
            },
        };
    }

    pub(crate) fn observe_removal(&mut self) {
        if matches!(self, Self::Conflicted(_)) {
            return;
        }
        let dirty_since = self.dirty_since();
        *self = Self::Observing {
            dirty_since,
            observation: DiskObservation::Removal {
                seen: Instant::now(),
            },
        };
    }

    pub(crate) fn clear_observation(&mut self) {
        let Self::Observing { dirty_since, .. } = self else {
            return;
        };
        *self = match *dirty_since {
            Some(since) => Self::Dirty { since },
            None => Self::Clean,
        };
    }

    pub(crate) fn content_observation(&self) -> Option<(u64, Option<i64>, Instant)> {
        match self {
            Self::Observing {
                observation:
                    DiskObservation::Content {
                        hash,
                        mtime_ns,
                        seen,
                    },
                ..
            } => Some((*hash, *mtime_ns, *seen)),
            _ => None,
        }
    }

    #[cfg(test)]
    pub(crate) fn content_observation_mut(&mut self) -> Option<&mut Instant> {
        match self {
            Self::Observing {
                observation: DiskObservation::Content { seen, .. },
                ..
            } => Some(seen),
            _ => None,
        }
    }

    pub(crate) fn removal_observation(&self) -> Option<Instant> {
        match self {
            Self::Observing {
                observation: DiskObservation::Removal { seen },
                ..
            } => Some(*seen),
            _ => None,
        }
    }

    #[cfg(test)]
    pub(crate) fn removal_observation_mut(&mut self) -> Option<&mut Instant> {
        match self {
            Self::Observing {
                observation: DiskObservation::Removal { seen },
                ..
            } => Some(seen),
            _ => None,
        }
    }

    pub(crate) fn has_observation(&self) -> bool {
        matches!(self, Self::Observing { .. })
    }

    pub(crate) fn conflict_disk_mtime_ns(&self) -> Option<Option<i64>> {
        match self {
            Self::Conflicted(conflict) => Some(conflict.disk_mtime_ns),
            _ => None,
        }
    }

    pub(crate) fn clear_after_flush(&mut self) {
        match self {
            Self::Dirty { .. } => *self = Self::Clean,
            Self::Observing { dirty_since, .. } => *dirty_since = None,
            Self::Clean | Self::Conflicted(_) | Self::Removed => {}
        }
    }
}

#[cfg(test)]
pub(crate) mod characterization {
    use super::{SessionConflict, SessionState};

    #[derive(Debug, PartialEq, Eq)]
    pub(crate) struct ConflictTrace {
        pub id_retained: bool,
        pub baseline_version: u64,
        pub disk_version: u64,
        pub authority_version: u64,
        pub disk_mtime_ns: Option<i64>,
        pub disk_content: String,
    }

    #[derive(Debug, PartialEq, Eq)]
    pub(crate) struct LifecycleTrace {
        pub first_dirty_instant_preserved: bool,
        pub observation_preserves_dirty_instant: bool,
        pub clear_observation_restores_dirty: bool,
        pub same_observation_matches: bool,
        pub changed_hash_does_not_match: bool,
        pub changed_mtime_does_not_match: bool,
        pub conflict_is_dirty: bool,
        pub conflict: ConflictTrace,
        pub removed_survives_flush_clear: bool,
    }

    pub(crate) fn lifecycle_trace() -> LifecycleTrace {
        let mut state = SessionState::Clean;
        state.mark_dirty(1);
        let first_dirty = state.dirty_since().expect("clean state becomes dirty");
        state.mark_dirty(2);
        let first_dirty_instant_preserved = state.dirty_since() == Some(first_dirty);

        state.observe_content(7, Some(8));
        let observation_preserves_dirty_instant = state.dirty_since() == Some(first_dirty);
        let same_observation_matches = matches!(
            state.content_observation(),
            Some((hash, mtime_ns, _)) if hash == 7 && mtime_ns == Some(8)
        );
        let changed_hash_does_not_match = !matches!(
            state.content_observation(),
            Some((hash, mtime_ns, _)) if hash == 9 && mtime_ns == Some(8)
        );
        let changed_mtime_does_not_match = !matches!(
            state.content_observation(),
            Some((hash, mtime_ns, _)) if hash == 7 && mtime_ns == Some(10)
        );
        state.clear_observation();
        let clear_observation_restores_dirty = matches!(
            state,
            SessionState::Dirty { since } if since == first_dirty
        );

        let mut state = SessionState::Conflicted(SessionConflict {
            id: "conflict".into(),
            baseline_version: 11,
            disk_version: 22,
            authority_version: 33,
            disk_mtime_ns: Some(55),
            disk_content: "disk".into(),
        });
        state.mark_dirty(44);
        let conflict_is_dirty = state.is_dirty();
        state.clear_after_flush();
        let SessionState::Conflicted(conflict) = state else {
            panic!("flush clearing must retain a conflict");
        };
        let conflict = ConflictTrace {
            id_retained: conflict.id == "conflict",
            baseline_version: conflict.baseline_version,
            disk_version: conflict.disk_version,
            authority_version: conflict.authority_version,
            disk_mtime_ns: conflict.disk_mtime_ns,
            disk_content: conflict.disk_content,
        };

        let mut removed = SessionState::Removed;
        removed.clear_after_flush();

        LifecycleTrace {
            first_dirty_instant_preserved,
            observation_preserves_dirty_instant,
            clear_observation_restores_dirty,
            same_observation_matches,
            changed_hash_does_not_match,
            changed_mtime_does_not_match,
            conflict_is_dirty,
            conflict,
            removed_survives_flush_clear: matches!(removed, SessionState::Removed),
        }
    }

    #[derive(Debug, PartialEq, Eq)]
    pub(crate) enum HttpOutcomeTrace {
        PreconditionRequired {
            current_version: u64,
            token_matches: bool,
        },
        Stale {
            current_version: u64,
            token_matches: bool,
        },
        Conflicted {
            token_matches: bool,
        },
    }

    #[derive(Debug, PartialEq, Eq)]
    pub(crate) struct HttpViewTrace {
        pub authority_version: u64,
        pub read_write_version_match: bool,
        pub read_write_token_match: bool,
        pub disk_conflicted: bool,
        pub conflict_layer_present: bool,
        pub conflict_token_matches: bool,
    }

    #[derive(Debug, PartialEq, Eq)]
    pub(crate) struct HttpTrace {
        pub precondition_required: HttpOutcomeTrace,
        pub stale: HttpOutcomeTrace,
        pub conflicted: HttpOutcomeTrace,
        pub conflicted_view: HttpViewTrace,
        pub reloaded_view: HttpViewTrace,
        pub overwritten_view: HttpViewTrace,
    }
}

#[cfg(test)]
mod tests {
    use super::characterization::{
        ConflictTrace, HttpOutcomeTrace, HttpTrace, HttpViewTrace, LifecycleTrace,
    };

    #[test]
    fn shared_lifecycle_transitions_preserve_characterized_behavior() {
        let trace = super::characterization::lifecycle_trace();

        assert_eq!(
            trace,
            LifecycleTrace {
                first_dirty_instant_preserved: true,
                observation_preserves_dirty_instant: true,
                clear_observation_restores_dirty: true,
                same_observation_matches: true,
                changed_hash_does_not_match: true,
                changed_mtime_does_not_match: true,
                conflict_is_dirty: true,
                conflict: ConflictTrace {
                    id_retained: true,
                    baseline_version: 11,
                    disk_version: 22,
                    authority_version: 44,
                    disk_mtime_ns: Some(55),
                    disk_content: "disk".into(),
                },
                removed_survives_flush_clear: true,
            }
        );
    }

    #[tokio::test]
    async fn document_and_scene_http_metadata_transitions_match() {
        let document = crate::doc_sessions::characterization_http_trace().await;
        let scene = crate::scene_sessions::characterization_http_trace().await;

        assert_eq!(document, scene);
        assert_eq!(
            document,
            HttpTrace {
                precondition_required: HttpOutcomeTrace::PreconditionRequired {
                    current_version: 0,
                    token_matches: true,
                },
                stale: HttpOutcomeTrace::Stale {
                    current_version: 0,
                    token_matches: true,
                },
                conflicted: HttpOutcomeTrace::Conflicted {
                    token_matches: true,
                },
                conflicted_view: HttpViewTrace {
                    authority_version: 0,
                    read_write_version_match: true,
                    read_write_token_match: true,
                    disk_conflicted: true,
                    conflict_layer_present: true,
                    conflict_token_matches: true,
                },
                reloaded_view: HttpViewTrace {
                    authority_version: 1,
                    read_write_version_match: true,
                    read_write_token_match: true,
                    disk_conflicted: false,
                    conflict_layer_present: false,
                    conflict_token_matches: true,
                },
                overwritten_view: HttpViewTrace {
                    authority_version: 2,
                    read_write_version_match: true,
                    read_write_token_match: true,
                    disk_conflicted: false,
                    conflict_layer_present: false,
                    conflict_token_matches: true,
                },
            }
        );
    }
}
