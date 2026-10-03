# How other MCP servers answer a read of a file over their cap is not surveyed

Status: accepted by the owner on 2026-09-27 for a later version than v0.101.0, so it is held under v0.102.0; raised by the owner the same day, with the acceptance of the read's bound in [an-mcp-read-loads-the-whole-file-before-its-cap](../done/an-mcp-read-loads-the-whole-file-before-its-cap.md). Surveyed on 2026-10-03 from sources, with nothing run: see What shipped.

## Owner ruling

Accepted on 2026-09-27 for the next version, at the owner's own request: accepting a stat before the read for chan's two reading tools, the owner asked in the same answer for an investigation of how other MCP servers handle a read of a file over their cap. It is not part of v0.101.0.

## What is asked

A survey of other MCP servers that read files for a client. For each server, what it answers for a file over its cap: a refusal, a cut text, or the whole file; whether it reads the file before it refuses or cuts it, or learns the file's size first; and whether it offers a range or a page of a file, so that a client can read a large file in parts.

## Acceptance

1. A written comparison of the servers surveyed, with the three answers for each and where each was read: the server's source or its documentation, at a named version.
2. A recommendation for chan's tools: whether the bound [an-mcp-read-loads-the-whole-file-before-its-cap](../done/an-mcp-read-loads-the-whole-file-before-its-cap.md) builds is enough, and whether chan's reads should offer a range or a page.

## What shipped

Surveyed on 2026-10-03 on the v0.102.0 integration branch and not on `main`, from sources read and not run: chan's own two tools at the branch, by a builder, and six other servers, each cell read from the server's source at a pinned commit of a named version. The lead read two cells again at those commits (the reference server's `read_text_file` and the GitHub server's cap); the rest stand on the survey's reading. No SDK or transport layer was read, so a limit on a message's size below a tool's handler is not established for any of them.

**chan 0.101.0.** `read_file` (text) reads at most 256 KiB (`READ_FILE_CAP_BYTES`, `crates/chan-llm/src/tools.rs`), cuts back to a character boundary and answers the cut text with `truncated: true`, a note and the whole file's `size` from its metadata; it takes a path alone. `read_media` (an image or a PDF) learns the size from the open handle and refuses a file over its cap, 10 MiB unless the host sets another, before any content is read (`crates/chan-llm/src/mcp.rs`); it takes a path alone.

**The six servers,** with the three answers for each:

- **The reference filesystem server** (`modelcontextprotocol/servers` 2026.8.31, commit `a40bc270fb5e`; `src/filesystem/index.ts:192-355`, `src/filesystem/lib.ts:201-203` and `:364-440`). Over a cap: it has none; `read_text_file`, `read_media_file` and `read_multiple_files` answer the whole file. Before it decides: it reads the whole file, with no stat. A part: `head` or `tail` of the text tool, counted in lines, not both and with no offset.
- **Desktop Commander** (`wonderwhy-er/DesktopCommanderMCP` v0.2.52, commit `c774c3b505de`; `src/utils/files/text.ts`, `src/handlers/filesystem-handlers.ts:93-107`, `src/tools/schemas.ts:56-61`). Over a cap: it has no cap in bytes; it answers a page of lines, 1,000 by default, under a first line that says how many lines were read and how many remain. Before it decides: a stat, though a file under 10 MiB is then read whole to count its lines. A part: `offset` and `length`, in lines.
- **The GitHub server** (`github/github-mcp-server` v1.14.0, commit `f10e4e1f923d`; `pkg/github/repositories.go:1085-1135`). Over its cap of 1 MiB: no content; a result that is not an error, with a sentence that names the size and an address to download from. Before it decides: the size comes with the API's metadata. A part: none.
- **mark3labs' filesystem server** (`mark3labs/mcp-filesystem-server` v0.11.1, commit `5646396f50ba`; `filesystemserver/handler.go:24-28` and `:694-716`). Over its cap of 5 MiB: no content; a notice with the size and a resource address. Before it decides: `os.Stat`, and it reads only a file at or under the cap. A part: none.
- **The Rust filesystem server** (`rust-mcp-stack/rust-mcp-filesystem` v0.4.5, commit `ef4797360ea0`; `src/fs_service/io/read.rs:40-267`). Over a cap: `read_text_file` has none and answers the whole file; `read_media_file` refuses only over a `max_bytes` its caller passes, and reads the whole file before it compares. A part: `read_file_lines` with `offset` and `limit` in lines, and a head and a tail by lines.
- **Serena** (`oraios/serena` v1.7.0, commit `949a27ef1e5f`; `src/serena/tools/file_tools.py:31-55`, `src/serena/tools/tools_base.py:281-311`). Over its cap of 150,000 characters of the lines asked for: no content; a sentence that names the length. Before it decides: it reads the whole file, slices it, then measures. A part: `start_line` and `end_line`.

**What the comparison shows.** Three answers exist: no cap (the reference server, the Rust server's text tool), a notice with no content (GitHub, mark3labs, Serena), and a page of lines with a hint to go on (Desktop Commander). None answers as chan does, with a text cut at a bound in bytes, a flag and the whole size. Two of the six learn the size before they read (mark3labs, GitHub), and a third stats and still reads a smaller file whole. Every part of a file that any of them offers is counted in lines, in four of the six; none takes an offset in bytes. A page of lines bounds no bytes in the two that page with no cap, so one long line comes back whole. A line offset is found by reading the file from its start on every call. No server that pages says anything of a file that changes between two pages.

## Recommendation

The bound [an-mcp-read-loads-the-whole-file-before-its-cap](../done/an-mcp-read-loads-the-whole-file-before-its-cap.md) built is enough for what it was built for: neither tool reads more than its cap, which two of the six surveyed can say of a read, at caps of 1 MiB and 5 MiB.

It is not enough for a client that needs the rest of a large text file. `read_file` takes a path alone, so what lies past 256 KiB cannot be read through it, while its description tells the client to ask again with a smaller scope (`crates/chan-llm/src/prompts.rs`). A page is worth offering, and it is raised as its own item for the owner's ruling: [an-mcp-text-read-cannot-reach-past-its-cap](an-mcp-text-read-cannot-reach-past-its-cap.md). The lead recommends an offset in bytes over a range of lines there, though lines are what the surveyed servers offer: a line offset costs a read from the start of the file on every call, which is the work the bound exists to avoid.
