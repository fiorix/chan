# Error response fixtures

`model-download-certificate-transport.json` contains the unchanged JSON string emitted by `index::embeddings::download::tls_tests::untrusted_metadata_certificate_preserves_the_transport_error` through its `MODELROOTS_CERTIFICATE_TRANSPORT_JSON` marker. The [downloader TLS test](../../../chan-workspace/src/index/embeddings/download/tls_tests.rs) connects to a loopback TLS server whose certificate is rejected with `UnknownIssuer`. Its port is part of the recorded transport error; consuming this fixture opens no connection.

The server test wraps this cause through `EmbedError::Certificate`, `IndexError::Embed` and `ChanError::Search`, then calls `err_from`, matching the model-download route. The fixture contains the transport cause rather than a constructed HTTP response.

- Fixture SHA256: `c80b926e847178b480268425431d6915b02f50d2a4f49246542ecfbdb0737cd9`.
- Native capture log SHA256: `deeb75d1c501d754713afc4938d0ff65983251f78ffa0cda7b3afb8fffd80551`.
- Capturing test binary SHA256: `2aeac8d4c1f324e73f8daaaafa383196dd3dd0fbe70c611862953c3aa641f3b0`.
- Capturing TLS test source SHA256: `d7c42fb7077f918bc8700d5536e853cba9a552a34825ad920def3750df459bc2`.

The browser check uses the exact response bytes emitted by the mapper test in [model-download-refusal.json](../../../../scripts/e2e/browser-smoke/fixtures/model-download-refusal.json), SHA256 `f240dfb496701c56498a2e8ef7e73380d70c46b9768750ff9b3b762d6c4c9885`. The mapper test also compares its response with that fixture, so the browser refusal retains the server envelope and transport cause.
