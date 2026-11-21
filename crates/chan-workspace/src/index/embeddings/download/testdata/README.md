# Model download test data

`bge-small-en-v1.5-config.json` is `BAAI/bge-small-en-v1.5`'s `config.json` at the commit the model table pins, byte for byte: the inspecting-proxy test serves it to the production client, which accepts it only when its sha256 is the pinned one. When the pin moves, fetch it again from `https://huggingface.co/BAAI/bge-small-en-v1.5/resolve/<commit>/config.json`; the test names the commit when the file no longer matches.

`hf-hub-cache/` describes a cache in hf-hub's layout, the one chan wrote before it pinned each model; its README says what each file holds.

The TLS tests make their CA and leaf at run time, through chan-tls's `testing::pki`; nothing here is key material.
