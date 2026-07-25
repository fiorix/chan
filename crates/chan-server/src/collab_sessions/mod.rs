#[cfg(test)]
pub(crate) mod characterization {
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
    fn document_and_scene_lifecycle_transitions_match() {
        let document = crate::doc_sessions::characterization_lifecycle_trace();
        let scene = crate::scene_sessions::characterization_lifecycle_trace();

        assert_eq!(document, scene);
        assert_eq!(
            document,
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
