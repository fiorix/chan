// Public surface of the search-index module. Hybrid (BM25 + dense)
// retrieval over per-heading chunks.
//
// Layout:
//   bm25       lexical side, tantivy-backed
//   chunking   markdown -> Chunk[]
//   config     on-disk index config (model, chunking strategy, …)
//   embeddings candle BertModel wrapper (gated by `embeddings`)
//   facade     high-level Index: build / search / forget
//   fusion     reciprocal-rank fusion (BM25 + semantic)
//   vectors    on-disk vector store + brute-force cosine
//
// All callers (the CLI's `chan workspace index` / `chan workspace search` and the
// chan-server background indexer) go through this module so search
// results match across surfaces.

pub mod bm25;
pub mod chunking;
pub mod config;
#[cfg(feature = "embeddings")]
pub mod embeddings;
pub mod facade;
pub mod fusion;
pub mod vectors;

pub use config::{Chunking, IndexConfig, DEFAULT_MODEL};
pub use facade::{
    BuildOptions, BuildSummary, Hit, Index, IndexError, IndexOpenOptions, IndexStats, Mode,
    SearchAggression, SearchBudget, SearchResult,
};

#[cfg(all(test, feature = "embeddings"))]
pub(crate) mod test_support {
    use std::path::Path;

    pub(crate) fn seed_embedding_model(cache: &Path) {
        use crate::index::embeddings::{repo_dir_name, Embedder};
        use candle_core::Device;
        use candle_nn::{VarBuilder, VarMap};
        use candle_transformers::models::bert::{BertModel, Config, DTYPE};
        use tokenizers::{
            models::wordlevel::WordLevel, processors::bert::BertProcessing, Tokenizer,
        };

        // A complete, tiny model exercises cache discovery and inference
        // without a download. Its four dimensions identify the fixture.
        let repo = cache.join(repo_dir_name(crate::DEFAULT_MODEL));
        let snapshot = repo.join("snapshots/test-model");
        std::fs::create_dir_all(repo.join("refs")).unwrap();
        std::fs::create_dir_all(&snapshot).unwrap();
        std::fs::write(repo.join("refs/main"), "test-model").unwrap();
        let config = serde_json::json!({
            "vocab_size": 4, "hidden_size": 4, "num_hidden_layers": 1,
            "num_attention_heads": 2, "intermediate_size": 8, "hidden_act": "gelu",
            "hidden_dropout_prob": 0.0, "max_position_embeddings": 512,
            "type_vocab_size": 2, "initializer_range": 0.02,
            "layer_norm_eps": 1e-12, "pad_token_id": 0, "model_type": "bert"
        });
        std::fs::write(
            snapshot.join("config.json"),
            serde_json::to_vec(&config).unwrap(),
        )
        .unwrap();
        let config: Config = serde_json::from_value(config).unwrap();
        let weights = VarMap::new();
        let _model = BertModel::load(
            VarBuilder::from_varmap(&weights, DTYPE, &Device::Cpu),
            &config,
        )
        .unwrap();
        weights.save(snapshot.join("model.safetensors")).unwrap();
        let vocabulary = ["[PAD]", "[UNK]", "[CLS]", "[SEP]"]
            .into_iter()
            .enumerate()
            .map(|(id, token)| (token.to_string(), id as u32))
            .collect();
        let word_model = WordLevel::builder()
            .vocab(vocabulary)
            .unk_token("[UNK]".into())
            .build()
            .unwrap();
        let mut tokenizer = Tokenizer::new(word_model);
        tokenizer.with_post_processor(Some(BertProcessing::new(
            ("[SEP]".into(), 3),
            ("[CLS]".into(), 2),
        )));
        tokenizer
            .save(snapshot.join("tokenizer.json"), false)
            .unwrap();

        let model = Embedder::open(crate::DEFAULT_MODEL, cache).unwrap();
        let rows = model.embed_documents(&["addedtoken"]).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].len(), 4);
        assert!(rows[0].iter().all(|value| value.is_finite()));
        assert!(rows[0].iter().any(|value| *value != 0.0));
        println!("synthetic-cache-open-and-embed-verified");
    }
}
