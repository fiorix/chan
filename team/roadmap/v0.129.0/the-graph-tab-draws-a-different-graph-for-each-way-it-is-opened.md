# The graph tab draws a different graph for each way it is opened

Status: built on `feat/graph-review` from `8ded1bda9` (the v0.128.0 tag) on 2026-11-12 and taken into the integration branch as `a6c33ae86` the same day; reviewed at intake and fixed in four rounds, merged as `7e1bc29c9` on 2026-11-13 (the sections Built and Reviews and fixes). The integration gate covered the intake at `4b752e94e`; the fix rounds had not been through it at this record. The owner walks it on macOS at the release.

Record: raised on 2026-11-12 by a review of the graph tab, which began from a graph tab the owner had moved to another pane and which lost its selection there, and built on a branch of its own as the review went. The owner decided the model below the same day and brought the work into v0.129.0 the same day: "more work finished, ready to integrate in this release".

## What was there

In v0.128.0 a graph tab had a mode (semantic, filesystem or language) and a scope (the workspace, a directory, a file, a tag, a mention, a contact or a language), and a scope other than the workspace drew a graph of its own. The review found:

- **Each scope drew its own layout.** One force model served every scope, a node's band its depth in the tree, and each scope pinned nodes at the world origin, the root's own place, against those bands: a directory scope framed the view on one of its files with the workspace root below the bottom edge, a file scope zigzagged its spine with the nodes below the file cut off, and a tag, mention, contact or language scope drew its subject on top of the root with the notes that reference it in an arc around it. Seen in the graph tuner, which runs the panel's own scope rules.
- **"Graph from here" on one file gave three graphs.** The file tree, the File Browser, the editor and search opened filesystem mode on the file's directory, a file node in a graph opened semantic mode on its directory, and the chord, Hybrid Nav and `cs` opened a semantic `file:` scope.
- **A pill did a different thing on each surface.** An unresolved `@@name` opened the whole workspace with the node selected from the workspace's Details, and a `mention:` lens from a file's.
- **A lens's depth was not hops of references.** It walked every edge kind in both directions, `contains` and the language hub among them, so at depth 2 it pulled in every sibling of each note through its directory and, through `language:Markdown`, every Markdown file.
- **A moved tab lost its selection.** Moving a tab to another pane mounted a new panel whose selection started empty, so a tab whose whole query was its selection, such as the owner's `@@contact` tab, fell back to the plain workspace graph.
- **Every tab streamed the whole workspace.** Each graph tab asked `/api/graph` for the workspace and kept its own copy, and the shared store asked once more for the inspectors.

## Desired contract (the owner's decisions, 2026-11-12)

1. One graph, rooted at the workspace, everywhere: the root pinned at the bottom and the tree growing up from it. A tag, a mention, a contact, a language, a file or a directory is a selection over that graph, not a graph of its own.
2. "Graph from here" is that graph with the node selected.
3. The depth belongs to the selected node, and resets or adjusts when the selection moves.
4. Nothing of the old behaviour is kept, and a click on a directory selects it only.
5. The filesystem and language modes go: a graph tab has no mode and no scope. Graph tabs, sessions and links of the old shape get no backwards compatibility ("no need for backwards compatibility here, nobody cares about broken graph tabs right now.. we can focus on the *new* behaviour and ignore the old one"); what the branch built to read them as the one graph stays unless it is in the way of a fix.
6. A window's graph tabs share one copy of the graph, and a hidden tab keeps only the part it draws.
7. The route compresses its answer; the bounded load, assessed, is not built.

## Boundaries

- Changed: the workspace app's graph tab (`GraphPanel.svelte`, `src/graph/` with `selectionView.ts` for the rules and `sharedGraph.ts` for the shared copy, `state/graphData.svelte.ts`, the openers, session restore, `chan://graph` links and the canvas); the workspace search's traversal in chan-workspace, held to the app's golden fixture `fixtures/workspace-search/expected.json`; the `cs graph` and `cs search` help; chan-server's `/api/graph` and `/api/fs-graph`; the graph browser checks (98, 110, 111, 112, 174, 218 and the new 224); the manual's graph and search pages.
- Not built: the bounded load, a server answer for the part a tab draws.
- No CHANGELOG entry until the release, by the owner's word.

## Acceptance

1. An independent review at intake and of each fix round, and a confirm read of the last, with every required finding fixed.
2. The rounds' scoped checks green at each tip: `make web-check`, the graph browser checks, chan-server's fmt, clippy, rustdoc and tests, `cargo metadata --locked` in the root and in `gateway/`, and `make nix-hash-check`.
3. The integration gate green at the merged tip before the push.
4. The owner's macOS walk at the release (the section Open).

## Built on `feat/graph-review`, 2026-11-12

Eleven commits on `8ded1bda9`, 82 files:

- **A moved tab keeps its selection** (`621274e12`): a panel that mounts on a tab with a recorded selection hands it to the path a reload uses. `GraphPanel.move.test.ts` moves tabs between two real panes; 4 of its 5 tests failed before.
- **One graph, and a lens is a selection** (`06120498c`, `dd536332f`): `src/graph/selectionView.ts` holds the rules, and the panel, every opener, session restore, `chan://graph` links and the graph tuner follow them. A graph tab has no mode and no scope id, and `GraphPanel` lost about 940 lines (the filesystem node store, lazy child fetches, both depth probes, the language graph load); `scopeView.ts`, `lensClosure.ts` and `state/scope.ts` are gone. A saved tab or link of either old mode reads as the one graph, and links still write `s=workspace&m=s`, since v0.128.0's parser refuses a link without `s`. On the way: a node seeded below the pinned root no longer stays trapped under it, the untouched view refits on a canvas resize, the root's selection is saved and restored, and links carry the opened directories.
- **The workspace search walks what the graph reveals** (`435e7a535`): `Workspace::workspace_search`, behind `cs search`, `chan workspace search`, the MCP tool and `POST /api/search/workspace`, walks hops of links, tags and mentions in both directions from a file, tag, mention or contact, never `contains` and, except from a language, never `language`. `fixtures/workspace-search/expected.json` is generated from the app's rules and both sides are held to it; four of its 18 cases changed.
- **The view follows the layout until it rests**, under every framing (`cce2156e0`, found by check 218: a graph opened from Search ended with a node 8 px past the top edge). Tooltips and the status hint describe the one graph (`763f3212e`), and the graph checks read it (`f65072b72`): check 110 is `110-graph-selection`, and `rootedFailures` (a disc for each counted node, every disc inside the canvas, one on the root's seat) replaces the symmetric predicate.
- **Symlink and hardlink edges are their own kinds** (`2ad4b0733`), stroked cyan and lime, a dangling symlink's dashed, followed by a selection and hidden by no chip. Before, the spine drew them as tag and mention edges and the route as `link`, so one symlink was two edges in borrowed colours.
- **A window's graph tabs draw one copy of the graph** (`7242dfa3b`): `state/graphData.svelte.ts` is the window's copy, `graph/sharedGraph.ts` lays it over a tab's own filesystem spine, and a hidden tab takes nothing until shown; a hidden tab keeps only the part it draws (`c7af005c5`).
- **`/api/graph` gzips its answer** for a client that accepts it (`8dd159091`), through tower-http's compression layer on that route alone; the lock gains `async-compression`, `compression-codecs` and `compression-core`, and the Nix cargo pins were harvested again. The new route test found the stream bridge panicking when polled after its end, which the encoder does; it is fused now.

The branch's own measurements, one run each in a guest on a copy of this repository (a debug server, headless Chrome, the heap read after a forced collection), three tabs opened in turn, before and after the one copy: streams 2, 1 and 1 to 1, 0 and 0; bytes 5.8, 2.9 and 2.9 MiB to 2.9 MiB, 9 KiB and 9 KiB; load 3.6, 3.4 and 2.9 s to 2.5, 0.11 and 0.08 s; heap 35, 53 and 71 MiB to 14, 16 and 17 MiB, against 9 MiB before any tab. With one tab hidden across three file changes the heap went from 15.7 to 18.2 to 18.6 MiB before a hidden tab kept only its part, and stays at 15.1 to 15.7 MiB after. On an optimized server gzip takes the stream from 3,017,005 to 254,620 bytes and the plain answer from 2,687,191 to 219,212 bytes, 7 to 45 ms slower on a loaded host. No review repeated these.

The bounded load was assessed on that optimized server and not built: the whole graph stream of this repository is 0.46 s and 3.0 MB; a bounded tab needs a server answer for the part it draws, makes every selection, depth step and reload a round trip where today they are instant, needs new sources for the chips' and the status line's totals and the depth caps, and still streams the whole graph while an inspector that reads it is open. The owner chose the compression.

## Reviews and fixes, 2026-11-12 and 2026-11-13

At intake an independent review accepted the branch with fixes:

- High, confirmed by running: the gzip feature on the root workspace's tower-http entry reached chan-tunnel-server, which the gateway workspace compiles by path, so `gateway/` no longer resolved with `--locked`, which every gateway recipe and Gateway CI use. Fixed on the integration branch as `f5b9586ce`: the feature sits on chan-server's own line, and the root lock and the Nix pins are unchanged.
- A tag, mention or language selection opened or restored while the index rebuilt was dropped when the graph answered "gated".
- Opening directories was not written to the session.
- Plausible: every change refetched the spine across the whole tree.
- Smaller: lost tests, two manual sentences, and a spawn from a graph tab before it loads.

Its question, an old lens tab with another node selected reopening on that node, the owner closed as built, under no backwards compatibility. It found sound: old sessions and links map onto the model, v0.128.0 accepts the new links, every edge kind is handled and nothing outside the app consumes them, the new crates' licenses and Rust floor, and the gateway's proxy forwarding the encoding headers untouched.

The first fix round (`ebd4f74a2`, six commits) waits out a gated graph (`dd4a45e90`), saves the opened directories with the session, with check 224 reopening a window from it (`cee9ef934`), brings the lost tests back (`e9a3e5360`), fixes the spawn (`6e394dcde`) and the manual (`ebd4f74a2`), and patches the spine, so a change reads again only the directory that holds it (`8c74fa1b9`). Measured by the round on a Linux 6.12 tree (86,618 files; a debug server, headless Chrome) with one directory six levels down opened, a save cost 4 `/api/fs-graph` requests and 8.7 MB at `8ded1bda9`, 686 to 725 requests, 33 to 36 MB and 37 to 44 s at the intake, and 2 requests and 60 KB after. Its review accepted it with fixes: any git command put a `.git/` directory into the graph, since the watch forwards `.git/index` on purpose; a new draft's marked path made the route answer 500; `/api/fs-graph` listed `.git` and `.chan` for any caller; a patch dropped the `contains` edges below each subdirectory it read again; nothing bounded a patch; and eight smaller findings.

The second and third fix rounds (`fbd4d7abf`, thirteen commits): the route gzips each frame itself with a sync flush and sends an empty batch after 10 s of silence (`59eff76dd`, `79182761f`); measured by the rounds in a release build on the kernel tree, gzip's first line came at 26.8 to 37.8 s before, against the client's 30 s stall limit, and at 1 to 12 ms after, with the longest gap 7.8 to 9.0 s. A tab's first spine reads one level per opened directory (`a9f3cfe45`): before, 686 requests for 33.5 MB, the opened directory drawn 21.4 s in and the walk over at 133.5 s; after, 9 requests for 145 KB and the directory drawn 0.5 s in. The findings of the first round's review: a patch leaves out drafts and `.git`, `.hg` and `.chan` paths and reads only directories the spine holds (`05efe6f36`), and `/api/fs-graph` answers 404 for a scope the walk skips (`cbadd3ee2`); a patch keeps the edges it does not read again (`b72a2a0a7`); a patch as large as a whole fetch becomes one, and past 1,000 untaken paths a tab fetches whole (`fbd4d7abf`); a tab hidden within 250 ms of a change takes it when shown (`c07117f0d`); a selection waiting on a rebuild ends with its error (`85508349b`); checks 110 and 218 read what they compare at one moment, and check 112 waits for the server's graph to hold still (`4c680876a`); the manual says what a tab draws late (`d6a53e0ce`). The panel writes its tab through the tabs module, and the mounted tests fail on an ownership warning (`573855e0e`). Its review accepted the rounds with fixes: `/api/fs-graph` refused by the text of the path, so through a workspace symlink to `.git` it listed the repository (run in a guest), and on a case-insensitive filesystem `.CHAN` reached `.chan` (by reading); a patch could leave a deleted directory's files drawn; and a symlink into a directory the tab does not hold stayed stale (both shown by a probe test). It found the gzip stream and its negotiation, the tunnel and gateway paths, the lock files, the level reader, the session saves and the checks sound, and corrected one comparison: the rounds' "72 s to 13 s" of main-thread time for a branch switch on the kernel tree was not like for like. The comparable pair is 735 to 18 `/api/fs-graph` requests and 60 s to 24 s of main-thread time, with the longest task 558 ms before and 3,123 ms after, which the two bursts' sizes (37k and 82k watch frames) keep from being pinned on the change.

The fourth fix round (`0c4aae2d9`, four commits): `/api/fs-graph` refuses a scope by where it resolves, `.git` and `.chan` whatever their case, and refuses a page cursor that names a skipped place or a link; a listed link into a skipped place keeps its target text with no node or edge (`409d30e75`). A level node that takes a held directory's place and is no directory takes what was below it (`1a846b7d6`); the symlinks the spine holds are checked against every directory a change names (`253f193e3`); and the manual names the right example (`0c4aae2d9`). The review's confirm read reran its probes at the tip in a guest: the symlinks into `.git` and `node_modules` answer 404, both panel scenarios come out right, a workspace root under a `build/` symlink or a `.git`-named ancestor still answers 200, and a real resume cursor cannot be refused in the app's use. Merged as `7e1bc29c9`; at the merged tip `cargo metadata --locked --offline` resolves in the root and in `gateway/`, and of the manifests only `crates/chan-server/Cargo.toml` changed, flate2 moving to its dependencies.

The proofs at each tip are the rounds' own, in an isolated guest: `make web-check` (9,313 app tests at the last), the marketing check, chan-server's fmt, clippy, rustdoc and tests, and the graph browser checks (98, 110, 111, 112, 174, 218 and 224 at the third round's tip; 110, 111, 112, 163, 218 and 224 at the fourth's), with check 163 red once on timing beside two control passes. Nothing ran on a case-insensitive filesystem.

## Limits, as the manual records them

- The graph finds symlinks and hardlinks by reading the tree from disk: the first six levels below the workspace root, up to 10,000 entries, and each directory open when the tab loaded. A symlink or hardlink outside both can be drawn without its edge until Reload graph, and a file given a second name in another directory is joined to it once its own directory changes.
- A directory git ignores that the graph still draws, such as an ignored `out/`, is drawn as the tab last read it, until Reload graph or a read of the whole tree, since the workspace reports no change inside it. The directories the workspace excludes (`node_modules`, `build`, `dist` and `target` among them) are not drawn.
- A search traversal follows neither symlinks nor hardlinks; the graph does.

## Open

Follow-ups from the second review, not scheduled:

- On a kernel-sized tree with hundreds of directories opened, one spine level read can pass the client's 10 s request limit, which fails the whole first load: the graph shows dimmed with the error text across it until the next change or Reload graph. The base does the same; why the limit is passed is not established.
- The shared graph builds and publishes a whole view on every stream event (1,402 on the kernel tree), by reading the likely source of a 3.1 s main-thread task seen after a branch switch, which no profile has traced.
- A held directory whose name another directory takes in one change keeps its old children while the tab draws from its spine alone (older than this work); a link swapped between the scope check and the walk would be listed (low; the escape guard has the same window); the symlink check matches a link by its target's directory, so a change there reads again every held directory with a link into it (performance only).
- Check 163's 200 ms gap can race the index poller's reload, a load-sensitive red not caused by this work.

For the owner's macOS walk at the release, left unchanged by his word: a click on a node counts as taking the view, so the fit stops following what the selection reveals; the fit pads discs, not labels, so a label at the edge is cut; a selected directory lights only itself and its direct neighbours; symlink and hardlink edges are known only as deep as the walk above reads. From the second review, for the same walk: a graph tab on a large workspace fills in without the 30 s stall, since incremental gzip decoding in WKWebView has only been read; directories opened by double-click come back open after a quit; no `.git/` bubble, multi-second freeze or red timeout text over a dimmed graph after a commit, a branch switch or a restore; a file created in an opened directory is there after switching tabs within a quarter second.

Also open from the branch: two tabs on one directory carry the same title.
