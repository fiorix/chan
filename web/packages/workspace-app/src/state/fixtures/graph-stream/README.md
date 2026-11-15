# Graph stream fixture

`response.ndjson` is the complete, verbatim response from `GET /api/graph?stream=1` for the adjacent `a.md` and `b.md` inputs. It was captured from the release binary built at `23ee2e97b3b5d1eb50ccc78a3a4cc90cf2bda660`, after the isolated workspace's index reported idle and ready. The response was HTTP 200 with `application/x-ndjson` and no content encoding. All six nonempty response lines are retained, without field filtering or replacement records.

The first node batch contains a tag and two files. The second repeats those nodes with report metadata on the files, adds the root directory and the language node, and is followed by filesystem and language edges. The two link edges resolve in both directions. This lets the tests check replacement metadata, stable insertion order and duplicate-edge suppression using captured records; their stress cases repeat those records without inventing graph nodes or edges. Failure controls terminate the test transport or abort the request.

SHA256 checksums:

```text
a591d6a145cb02d1d8b7f154ae0c42024f9bf1ac2397f98f9d2ca93c1482bd18  response.ndjson
0c38d91511904aa8d616fcc7ac1bf7834cb4653e1cebda366afae208a57c2de6  a.md
e57b4b9bec8902b81ef1d9f7a41e5de6283e76dc725adbc04fe110afe65420e9  b.md
ebe528ed727114cac31e912d5980a23bed52fcb4b91c5cd0b946148c2137ba2c  release binary
9ce8946e7c36235775d233b68233eaecfa44c050ebd0ce7fc58803932d2c4de5  crates/chan-server/src/routes/graph.rs
```
