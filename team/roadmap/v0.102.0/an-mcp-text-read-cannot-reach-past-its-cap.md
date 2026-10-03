# An MCP text read cannot reach past its cap

Status: raised for a decision on 2026-10-03 by the lead, from the survey that [how-mcp-servers-cap-a-read-is-unsurveyed](how-mcp-servers-cap-a-read-is-unsurveyed.md) asked for; the owner had not ruled on it then. Read in the code on the v0.102.0 integration branch; nothing was run. Ruled on 2026-10-03: see Owner ruling.

## Owner ruling

On 2026-10-03 the owner ruled, as the lead recommended: an offset in bytes. `read_file` takes an optional offset and answers where the next page starts; a range of lines is not built. Accepted for a build.

## What was seen

`read_file` reads at most 256 KiB of a text file and answers the cut text with `truncated: true`, the whole file's `size` and its `mtime_ns` (`exec_read_file`, `crates/chan-llm/src/tools.rs`). Its parameters are a path alone (`ReadFileParams`, `crates/chan-llm/src/mcp.rs`), so a client cannot read what lies past the cap through the tool. The tool's description tells the client to ask again with a smaller scope (`crates/chan-llm/src/prompts.rs`), which a path cannot express.

Of the six other servers the survey read, four offer a part of a file, each counted in lines. None takes an offset in bytes, the two that page with no cap bound no bytes in a page of lines, and none says anything of a file that changes between two pages.

## Desired contract

Not written yet. A client that meets a cut text can read the rest in pages, each within the read's cap, and can tell when the file changed between two of them.

## What to do

Rule whether it is built, and its shape:

- (a) An offset in bytes. `read_file` takes an optional offset and answers where the next page starts. A page is one seek and one bounded read, cut at a character boundary as the first page is, and carries `size` and `mtime_ns` as an answer does today, so a client sees a change between two pages.
- (b) A range of lines, as four of the surveyed servers offer. It is the unit a client holds from a search's line numbers, but a line offset is found by reading the file from its start on every call, and a page of lines needs the cap in bytes as well, so one line over the cap still cannot be passed.
- (c) Both.
- (d) Neither: the cap stays the end of what the tool reads, and the description stops telling the client to ask again.

The lead recommends (a): it keeps the work of every call bounded, which is what the read's cap was built for, and a range of lines can follow over it as a convenience.

## Boundaries

`crates/chan-llm/src/tools.rs` and `crates/chan-llm/src/mcp.rs` (the tool's parameters and its answer), `crates/chan-llm/src/prompts.rs` (its description), the bounded read in `crates/chan-workspace` if it takes no offset, with their tests. `read_media` does not change.

## Acceptance

1. The ruling is recorded.
2. If it is built: a text file of several caps is read whole in pages, each within the cap and with no character split between two of them; a page at the end of the file says that nothing follows; a file that changed between two pages can be told from the two answers; a call without the offset answers as it does today.
