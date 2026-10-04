# Roadmap

Active development scope for chan, organized by the release it targets. This is the roadmap front door: what has been accepted as work for an upcoming version, and where each item goes once it ships, is withdrawn, or slips. It is not a second release report; closed history lives in [`../release/`](../release/README.md), and the process that moves an idea from a problem to a shipped release is described in [`../README.md`](../README.md).

Each item is one Markdown file that names an observed behavior or need, the evidence for it, the desired contract, its implementation boundaries, and its acceptance checks. An item earns a place here only once it is accepted scope for a concrete target version; a raw draft in the gitignored `dev/` tree is not a roadmap item until it is copied in and accepted.

## Lifecycle

1. `vX.Y.Z/{item}.md` is accepted active scope for that target version.
2. Implementation and validation evidence accumulate in the proposal, its candidate report, or the round's artifacts, without replacing the proposal's original rationale.
3. At GA the item moves to `done/{item}.md` and gains a status line linking to `[vX.Y.Z](../../release/release-vX.Y.Z.md)`; the text says `shipped` only when the item actually shipped.
4. A withdrawn item also moves to `done/`, states plainly that it did not ship, and links to the release report that records the decision.
5. A deferred item moves to the next active version directory before GA. It is not marked done.
6. After the GA close commit the released version's directory is gone; every one of its items lives in `done/` or in a later active version.

## Layout rules

`done/` is intentionally flat, so item filenames must stay descriptive and repository-wide unique. If a future item would collide with a closed one, prefix that filename with its version when it is closed.

The Active table keeps to the 80-column table rule in [`.agents/writing-rules.md`](../../.agents/writing-rules.md), which is what the short cells and the reference-style links are for: state and next are a word or two, and everything else belongs in the item. That leaves a filename budget of roughly fifty characters before a row outgrows the width.

## Active

### v0.102.0

Opened 2026-09-27 to hold what the owner accepted for a version after v0.101.0, none of it part of v0.101.0: two items raised during v0.101.0 that need a root which moved under a symlink; four more raised during v0.101.0 and accepted the same day for a later version, each as the lead recommended: the deck's Hide and Close on another host's window, a rejected JSON body's refusal naming the request's Rust type, the terminal pruner's save under the chan home on a runtime worker, and a gate's refusal of a wrong method listing the route's methods; and the owner's own request of the same day, a survey of how other MCP servers answer a read of a file over their cap. On 2026-09-29 the owner closed v0.101.0's intake under one rule and accepted for a later version thirty-eight of the items then raised during v0.101.0, which move here with their rulings; fourteen of them wait on a shape that is not ruled, and the code map of one, a desktop recovery entry that ends with its run, may be taken in v0.101.0. Two items that the same rulings made join them: the concurrent selection race of a removal, accepted with its design on record as a source contract and executable tests of it stopped, and whether a window's close should save first, raised for a decision. On 2026-09-29 the owner added two items from use, each accepted with the report: `cs export` hanging where the same export from the UI completes, and a slide deck's PDF lacking the images the deck shows. On 2026-09-30 eleven findings that the round's records held with no item of their own were raised for a decision, and are held here since v0.101.0's intake is closed: four gaps outside the design of a removal's row claim, a window hidden on the connecting page in the desktop's memory alone, document and scene sync staying off after a first connection that closed before a frame, the launcher's off and `chan workspace forget` still acting on another workspace after the removal's repair, two written costs of the launcher's add and on, a root relinked while mounted that cannot be handed off, the stopping devserver's code that no client reads, four side findings of that order's report, a standalone Files write whose stale token equals the current one, the launcher's Focus and Open and the workspace app's deck taking a window for any record, and the pins of a case-only rename running in no gate. On 2026-10-02 one more was raised for a decision, the missing-file check that commits no waiting stroke: it is the third route of a v0.101.0 item whose other two routes are built, kept out of that version by a standing hold.

At the v0.101.0 GA on 2026-10-02 six items moved here from that version: four whose remaining work carries over, the dedup seams, the frontend comment pass, the frontend review remainder and a hung root's registration thread, and two still raised for a decision, a raw devserver's restart beside desktop windows and a desktop hide beside a waiting stroke.

On 2026-10-03 the owner raised one more from use and accepted it with the report: that no line chan prints opens a running devserver in a browser, which also asks that secret masking default on in a control terminal alone. The same day the owner's own PDF exports of a slide deck were read back pixel by pixel, which settles the causes of [a-slide-decks-pdf-lacks-the-images-it-shows][pdimg] and adds to it the width half of the one design box it already named: a deck's PDF breaks lines the deck keeps whole when it plays, and paints a scrollbar into the raster. Also that day the owner asked for, and accepted with the request, `muse` as a name `cs terminal write --submit` takes, encoded as gemini's is: [the-submit-agents-name-no-muse][smuse].

On 2026-10-03 the owner ruled, each as the lead recommended, the fifteen accepted rows whose shape was open, a choice inside five build rows, and thirteen of the fifteen raised rows: five are accepted for a build, four for a reading or a measurement first, one closes with its documents, one closes as written costs, one carries to a later version, and one stays as it is until [a-connected-record-does-not-say-whose-socket][sockw] lands. Two raised rows still wait on a reading only the owner can take: [a-raw-devserver-restart-may-close-desktop-windows][rrwin] and [a-host-side-hide-commits-no-waiting-stroke][hdnpg]. Each item records its ruling. The same day the first eight rows were built on the integration branch, each item recording what shipped, and one item was raised from a build: [a-reopened-broken-drawing-comes-back-clean][rbrk]. Later that day three more rows were built, a fourth was built in part and stays open, and a second item was raised from a build: [a-forget-finds-its-host-by-the-lock-record-alone][fglck]. The owner accepted both raised items that day, each as the lead recommended. Later that day two more rows were built and three were built in part, a reading was recorded for the owner, and four items were raised from the builds: [a-fence-in-view-decorates-every-row-of-its-block][fnc], [a-hardlink-pair-split-across-pages-is-not-joined][hlpg], [a-directory-seed-scans-the-catalog-per-node][dirsc] and [an-abandoned-open-recreates-removed-metadata][oprm]. The owner ruled on all four and on the reading that day, each as the lead recommended: the fence handler is measured first, the hardlink pairs, the search's last pass and the files token are accepted for a build, and the open's leftover stays a written cost. Four desktop rows followed that day: three were built, and the desktop's half of the upload's. Then six rows of the store and the scene's sync were built, the page's half of a live drawing's save among them, with two more rows of the frontend review remainder. A second web range that day built the repeated element id and the recovery entry's rule, and delivered the fence handler's measurement, the sync socket's reading and the recovery entry's code map, each recorded in its item for the owner. Three more items were raised from the day's builds: [a-keystroke-in-a-long-paragraph-takes-200-ms][lnpar], [the-browser-smoke-suite-is-red-at-the-base][smkrd] and [a-drawings-picture-waits-on-the-engine-in-a-pdf][pdfdr]. The host's block followed: an unreceived open result released off the runtime, the restore's registration under its permit and the barrier before an open, with the server's half of the deck's managed windows and the forget's one lookup. A third web range repaired the save's refused fallback and the unforced pane closes, and built the reopen of a discarded broken drawing, the required `writable` bit and the link pill's dropped kind. A server range followed: the reset's and the import's wait for a released workspace's lock in a bound of its own, the server's half of the standalone save's loaded hash and of the paged graph's link group, and a search's directories listed in one walk of the tree. A launcher range followed: the deck's half of the managed windows, four seams given one owner, the launcher's buttons folded into its own rules, and the desktop's page sheet pruned. Then the page's half of the paged graph's link group, in both of the graph's modes, with the request's half of the standalone save's hash and the page's half of the terminal masking default. A second host block repaired the unreceived open's release at a runtime's shutdown, the restore's registration of two spellings of one root and the keys the open's gate waits under, closed the forget's removal by a stale match, marked a snapshot's windows from one read, pinned the `Allow` header for every gate, and gave the launcher one answer to another process's lock. The launcher range's repair gave the desktop Focus on a visible window it does not manage and the Select toggle its accent under the pointer. Later still the owner ruled ten more, each as the lead recommended: a trace before any build for [a-keystroke-in-a-long-paragraph-takes-200-ms][lnpar], a diagnosis before any repair for [the-browser-smoke-suite-is-red-at-the-base][smkrd], the owner's own display reading before [a-drawings-picture-waits-on-the-engine-in-a-pdf][pdfdr], [a-fence-in-view-decorates-every-row-of-its-block][fnc] closed as measured, the latch dropped for [a-sync-socket-closed-before-a-frame-stays-off][syoff], one loopback port across launches for [a-desktop-recovery-entry-ends-with-its-run][rcorg], three choices of the masking default in [no-printed-line-opens-the-devserver-in-a-browser][dsurl], and the five unnamed launcher fixes of [the-frontend-review-remainder-has-no-owner][ferem] closed as unrecoverable. The survey of [how-mcp-servers-cap-a-read-is-unsurveyed][mcpsv] was written from six servers' sources at named versions, and raised [an-mcp-text-read-cannot-reach-past-its-cap][mcprg]. The code map that [the-desktop-probe-takes-a-gateway-404-as-ready][gwnfd] asks for first was read, and the lead ruled where the desktop's bound lives and its size. The server's and `cs`'s half of [cs-export-hangs-where-the-ui-export-completes][xhang] followed, with the library's id on a devserver's control sockets for [the-control-socket-identity-names-no-library][cslib]; both rows stay open for what their items name. A third host block followed: the release of an unreceived open that a stopping runtime refuses, the open gate's read of the registry after its first wait, the devserver's own answer to another process's lock, and the server's half of a backslash in an excluded directory's name. The trace of [a-keystroke-in-a-long-paragraph-takes-200-ms][lnpar] was taken, three whole parses of the paragraph for each key, and the owner ruled three more rows that evening, each as the lead recommended: its one-line cause is built, [an-mcp-text-read-cannot-reach-past-its-cap][mcprg] gains an offset in bytes, and [a-dirty-tabs-first-sync-attach-overwrites-what-changed-under-it][drtat], raised from the build of the sync latch, shows the conflict prompt. The repair of the export job followed, a commit that parks no worker and answers by its outcome, and with it the library's id in every `cs` resolver, which closes [the-control-socket-identity-names-no-library][cslib]. Then the session tasks of [a-reset-counts-a-reference-another-can-upgrade][rsupg], which look for the workspace without waiting on a worker and flush at a stop once it is back, with the server's half of the masking default: an unset `terminal.secret_masking`. That evening the owner revised one ruling, as the lead recommended, after the latch's drop was built and reviewed three times without becoming safe: [a-sync-socket-closed-before-a-frame-stays-off][syoff] keeps its latch and loses its triggers instead, and [a-dirty-tabs-first-sync-attach-overwrites-what-changed-under-it][drtat] moves to a later version with the transition it belongs to. With the code map read, the owner then ruled that item's build: the server sends a small first frame at once on a sync upgrade, so a large drawing's first dial no longer times out. The workspace app's branch then landed whole but for the latch's drop: one rule for a backslash in a typed or dropped name, a grid or background kept through a disconnect, Restore that merges on a live board, a masked control terminal on xterm, a standalone save that names the hash of what its tab loaded, and a walker that forces no parse it has in hand. The server's half of [a-connected-record-does-not-say-whose-socket][sockw] followed, a window's record listing the tags of the sockets that hold it, with the repair of the excluded directory's look and of the open gate's keys. The PDF export's images followed: a page's images are painted from their decoded bitmaps where the page shows them and a deck is laid out as play lays it out; [a-slide-decks-pdf-lacks-the-images-it-shows][pdimg] stays open for the owner's reading on a display, a run in WebKit and four rows a review left. Then the command's and the desktop's parts of the forget block, which close [chan-workspace-forget-ignores-the-hosts-answer][fgcli] and [forgetting-a-relinked-root-waits-four-lookups][sfgt]; [an-off-and-the-cli-forget-name-another-workspace][fgoth] keeps the launcher's off. The workspace app's next range followed: a queued push that keeps a collaborator's setting and its own keys, how long Overwrite's choice lasts at a save conflict, a Settings row for the masking a window's terminals start with, and a hint in the path prompt. Its builder raised [a-pick-made-before-a-board-adopts-the-scene-is-dropped][pkadp]. The server's half of the first frame followed, a small hello ahead of a sync socket's snapshot, with a reset or an import that writes unsaved edits itself when it ends busy at a stop; [a-sync-socket-closed-before-a-frame-stays-off][syoff] stays open for the page's pins, and its cost is raised as [after-the-hello-a-tab-waits-for-its-snapshot-without-a-bound][hlwt]. The smoke suite's diagnosis is in: nineteen of forty-seven checks fail, none on a fault a run assigns to the product, and [the-browser-smoke-suite-is-red-at-the-base][smkrd] waits for the owner's ruling on its repair. [chan-serve-falls-back-to-a-standalone-server-the-same-lock-refuses][svfb] is raised from the foreign lock's ruling. The workspace app's part of [a-connected-record-does-not-say-whose-socket][sockw] followed, a page that tags its socket and the windows it opens and a deck that repairs a popup by its own page's socket, with the excluded-directories control taking a name that holds a backslash. The desktop's next range followed: a gateway's 404 waited out for a window's first fifteen probes, one loopback port tried first at every launch, and a paged MCP text read, which closes [an-mcp-text-read-cannot-reach-past-its-cap][mcprg]. The workspace app then closed [a-stale-files-token-can-equal-the-current-one][eqtok], every end of a load ending Overwrite's choice, and [a-sync-socket-closed-before-a-frame-stays-off][syoff] with the page's guards for the hello, and gave the launcher's Open its refusal of a typed path that holds both a backslash and a `..`. The PDF export's four rows followed, each shown red first, so [a-slide-decks-pdf-lacks-the-images-it-shows][pdimg] waits on a WebKit run and the owner's reading alone. On 2026-10-04 the owner ruled the eighth file as the lead recommended: the registry undoes only its own append of a second row for one directory, two spellings of a hung root keep their own computations as a written cost, the hung root's gate is built for the devserver alone with [the-desktops-boot-restore-re-serves-its-rows-one-at-a-time][dboot] raised from it, no cut goes out with a turned image open, and [a-pick-made-before-a-board-adopts-the-scene-is-dropped][pkadp] is accepted for a build. The runtime's next range followed: an off that closes the row it names, the on route beside a second registry row, two more readers of the workspace cell off the workers, and the design sentence that closes [an-upload-cuts-a-name-at-its-backslash][bslup]. The launcher's part of [a-connected-record-does-not-say-whose-socket][sockw] followed: the launcher tags the windows it opens and repairs one by its own page's socket. The excluded-directories control then learned to keep its list equal to the server's set and to fold ASCII letters alone. The forget block's repair followed with a forget that asks its library's devserver, which closes [a-forget-finds-its-host-by-the-lock-record-alone][fglck] and [an-off-and-the-cli-forget-name-another-workspace][fgoth], and the gate's symlinked-temp arm runs the command's package. A bare WebKitGTK view then exported the three seeded documents with the readings Chrome gives, and a browser check opened a terminal through the launcher and found its tag among the window's holders. The excluded-directories control then learned to send the save that waited when its tab closed and to take no name before the stored list is read, a pick made before a drawing's first snapshot is kept, and the deck's Computers orb stays dark in a window with no library. On 2026-10-04 the owner ruled the ninth set of open rows: the browser smoke suite is repaired as its diagnosis proposes, the desktop's serial boot restore and the standalone server's wasted fallback are accepted for this version against the lead's advice to defer them, a page-side bound from the hello to the snapshot is accepted, and a launch URL's token is masked in the terminal, raised as [a-launch-urls-token-escapes-the-terminal-masker][lmask].

| item | state | next |
| --- | --- | --- |
| [forgetting-a-relinked-root-waits-four-lookups][sfgt] | accepted | cut |
| [a-relinked-off-row-outlives-a-devserver-restart][roff] | accepted | build |
| [the-deck-offers-close-on-another-hosts-window][dhost] | accepted | cut |
| [a-rejected-json-body-names-its-rust-struct][jrej] | accepted | cut |
| [the-terminal-pruner-saves-on-a-runtime-worker][prune] | accepted | build |
| [a-gate-refusal-lists-the-routes-methods][allow] | accepted | cut |
| [how-mcp-servers-cap-a-read-is-unsurveyed][mcpsv] | accepted | cut |
| [a-workspace-search-stops-only-between-seeds][sseed] | accepted | cut |
| [the-chan-crate-exports-a-test-only-module][tstmod] | accepted | cut |
| [a-repeated-element-id-gets-a-new-id-at-every-seed][rpid] | accepted | cut |
| [a-released-commands-success-paints-over-the-deck][rlsok] | accepted | cut |
| [the-desktop-probe-takes-a-gateway-404-as-ready][gwnfd] | accepted | build |
| [a-connected-record-does-not-say-whose-socket][sockw] | accepted | build |
| [a-draft-that-does-not-parse-cannot-be-discarded][drdsc] | accepted | cut |
| [a-control-socket-close-outlives-its-client][ctlcs] | accepted | build |
| [a-close-answers-before-the-writer-lock-is-free][clfre] | accepted | build |
| [an-unreceived-open-result-blocks-a-runtime-worker][unrc] | accepted | cut |
| [a-lock-probe-can-refuse-a-concurrent-acquire][prbhd] | accepted | build |
| [a-mounted-close-awaits-a-teardown-with-no-deadline][td] | accepted | build |
| [the-desktop-handoff-registration-has-no-bound][hdreg] | accepted | cut |
| [the-add-and-on-answer-a-foreign-lock-two-ways][lkfor] | accepted | build |
| [an-upload-cuts-a-name-at-its-backslash][bslup] | accepted | cut |
| [the-manifest-writer-asks-every-root-under-a-lock][mnfrt] | accepted | build |
| [two-registry-rows-can-name-one-directory][dupreg] | accepted | build |
| [the-fdstore-e2e-prints-the-devservers-token][tokpr] | accepted | cut |
| [typed-and-dropped-names-disagree-on-a-backslash][bstyp] | accepted | build |
| [the-desktop-cuts-a-download-name-at-its-backslash][bsd] | accepted | cut |
| [a-force-closed-draft-reopens-as-a-new-draft][freop] | accepted | cut |
| [a-reset-counts-a-reference-another-can-upgrade][rsupg] | accepted | build |
| [the-control-socket-identity-names-no-library][cslib] | accepted | cut |
| [the-desktops-menu-copies-a-window-outside-its-row][mnu] | accepted | cut |
| [the-workspace-deck-names-a-windows-root-whole][dkwin] | accepted | cut |
| [a-background-the-authority-never-took-turns-back][bgrv] | accepted | cut |
| [hybrid-nav-leaves-a-live-drawing-unsaved][hnsav] | accepted | cut |
| [a-save-fallback-writes-an-unseeded-boards-buffer][unsd] | accepted | cut |
| [a-live-drawing-save-answers-before-the-write][erlsv] | accepted | cut |
| [a-late-off-row-outlives-a-removal][offwin] | accepted | cut |
| [a-launcher-delete-leaves-a-devserver-record-on][ldrec] | accepted | cut |
| [a-forgets-tombstone-outlasts-its-answer][fgtomb] | accepted | cut |
| [chan-workspace-forget-ignores-the-hosts-answer][fgcli] | accepted | cut |
| [a-desktop-recovery-entry-ends-with-its-run][rcorg] | accepted | build |
| [any-later-write-retires-a-recovery-entry][rcstl] | accepted | cut |
| [restore-on-a-live-board-pushes-an-older-scene][rstlv] | accepted | cut |
| [the-decks-close-row-keeps-the-window-session][dkcls] | accepted | cut |
| [a-forced-pane-close-pushes-a-waiting-stroke][fclng] | accepted | cut |
| [a-removal-does-not-hold-the-row-it-selected][rmrace] | accepted | build |
| [a-window-close-does-not-save-first][wclsv] | accepted | cut |
| [cs-export-hangs-where-the-ui-export-completes][xhang] | accepted | build |
| [a-slide-decks-pdf-lacks-the-images-it-shows][pdimg] | accepted | build |
| [a-hung-root-keeps-restored-tenants-at-503][rgate] | accepted | build |
| [four-gaps-lie-outside-a-removals-row-claim][rmgap] | accepted | read |
| [a-connecting-page-hide-lives-in-memory-alone][hdmem] | accepted | build |
| [a-sync-socket-closed-before-a-frame-stays-off][syoff] | accepted | cut |
| [an-off-and-the-cli-forget-name-another-workspace][fgoth] | accepted | cut |
| [a-refused-add-registers-late-and-an-on-is-not-kept][adon] | withdrawn | GA |
| [a-root-relinked-while-mounted-cannot-be-handed-off][rlmt] | deferred | move |
| [no-client-reads-the-devserver-stopping-code][stprd] | accepted | measure |
| [a-stopping-devservers-report-left-four-findings][stp4] | accepted | cut |
| [a-stale-files-token-can-equal-the-current-one][eqtok] | accepted | cut |
| [focus-and-open-take-a-window-for-any-record][fcany] | raised | decide |
| [the-casefold-pins-run-in-no-gate][cfgat] | accepted | build |
| [a-missing-file-check-commits-no-waiting-stroke][mfchk] | accepted | cut |
| [one-question-is-answered-in-many-places][dedup] | accepted | build |
| [frontend-comments-narrate-history][cmts] | accepted | build |
| [the-frontend-review-remainder-has-no-owner][ferem] | accepted | build |
| [a-hung-root-takes-a-thread-per-expired-caller][rthrd] | accepted | build |
| [a-raw-devserver-restart-may-close-desktop-windows][rrwin] | raised | decide |
| [a-host-side-hide-commits-no-waiting-stroke][hdnpg] | raised | decide |
| [no-printed-line-opens-the-devserver-in-a-browser][dsurl] | accepted | build |
| [the-submit-agents-name-no-muse][smuse] | accepted | cut |
| [a-reopened-broken-drawing-comes-back-clean][rbrk] | accepted | cut |
| [a-forget-finds-its-host-by-the-lock-record-alone][fglck] | accepted | cut |
| [a-fence-in-view-decorates-every-row-of-its-block][fnc] | accepted | cut |
| [a-hardlink-pair-split-across-pages-is-not-joined][hlpg] | accepted | cut |
| [a-directory-seed-scans-the-catalog-per-node][dirsc] | accepted | cut |
| [an-abandoned-open-recreates-removed-metadata][oprm] | withdrawn | GA |
| [a-keystroke-in-a-long-paragraph-takes-200-ms][lnpar] | accepted | cut |
| [the-browser-smoke-suite-is-red-at-the-base][smkrd] | accepted | build |
| [a-drawings-picture-waits-on-the-engine-in-a-pdf][pdfdr] | raised | decide |
| [an-mcp-text-read-cannot-reach-past-its-cap][mcprg] | accepted | cut |
| [a-dirty-tabs-first-sync-attach-overwrites-what-changed-under-it][drtat] | deferred | move |
| [a-pick-made-before-a-board-adopts-the-scene-is-dropped][pkadp] | accepted | build |
| [the-decks-computers-orb-lights-during-each-poll][dkorb] | accepted | cut |
| [after-the-hello-a-tab-waits-for-its-snapshot-without-a-bound][hlwt] | accepted | build |
| [chan-serve-falls-back-to-a-standalone-server-the-same-lock-refuses][svfb] | accepted | build |
| [the-desktops-boot-restore-re-serves-its-rows-one-at-a-time][dboot] | accepted | build |
| [a-launch-urls-token-escapes-the-terminal-masker][lmask] | accepted | build |

[dedup]: v0.102.0/one-question-is-answered-in-many-places.md
[cmts]: v0.102.0/frontend-comments-narrate-history.md
[ferem]: v0.102.0/the-frontend-review-remainder-has-no-owner.md
[rthrd]: v0.102.0/a-hung-root-takes-a-thread-per-expired-caller.md
[rrwin]: v0.102.0/a-raw-devserver-restart-may-close-desktop-windows.md
[hdnpg]: v0.102.0/a-host-side-hide-commits-no-waiting-stroke.md
[sfgt]: v0.102.0/forgetting-a-relinked-root-waits-four-lookups.md
[roff]: v0.102.0/a-relinked-off-row-outlives-a-devserver-restart.md
[dhost]: v0.102.0/the-deck-offers-close-on-another-hosts-window.md
[jrej]: v0.102.0/a-rejected-json-body-names-its-rust-struct.md
[prune]: v0.102.0/the-terminal-pruner-saves-on-a-runtime-worker.md
[allow]: v0.102.0/a-gate-refusal-lists-the-routes-methods.md
[mcpsv]: v0.102.0/how-mcp-servers-cap-a-read-is-unsurveyed.md
[sseed]: v0.102.0/a-workspace-search-stops-only-between-seeds.md
[tstmod]: v0.102.0/the-chan-crate-exports-a-test-only-module.md
[rpid]: v0.102.0/a-repeated-element-id-gets-a-new-id-at-every-seed.md
[rlsok]: v0.102.0/a-released-commands-success-paints-over-the-deck.md
[gwnfd]: v0.102.0/the-desktop-probe-takes-a-gateway-404-as-ready.md
[sockw]: v0.102.0/a-connected-record-does-not-say-whose-socket.md
[drdsc]: v0.102.0/a-draft-that-does-not-parse-cannot-be-discarded.md
[ctlcs]: v0.102.0/a-control-socket-close-outlives-its-client.md
[clfre]: v0.102.0/a-close-answers-before-the-writer-lock-is-free.md
[unrc]: v0.102.0/an-unreceived-open-result-blocks-a-runtime-worker.md
[prbhd]: v0.102.0/a-lock-probe-can-refuse-a-concurrent-acquire.md
[td]: v0.102.0/a-mounted-close-awaits-a-teardown-with-no-deadline.md
[hdreg]: v0.102.0/the-desktop-handoff-registration-has-no-bound.md
[lkfor]: v0.102.0/the-add-and-on-answer-a-foreign-lock-two-ways.md
[bslup]: v0.102.0/an-upload-cuts-a-name-at-its-backslash.md
[mnfrt]: v0.102.0/the-manifest-writer-asks-every-root-under-a-lock.md
[dupreg]: v0.102.0/two-registry-rows-can-name-one-directory.md
[tokpr]: v0.102.0/the-fdstore-e2e-prints-the-devservers-token.md
[bstyp]: v0.102.0/typed-and-dropped-names-disagree-on-a-backslash.md
[bsd]: v0.102.0/the-desktop-cuts-a-download-name-at-its-backslash.md
[freop]: v0.102.0/a-force-closed-draft-reopens-as-a-new-draft.md
[rsupg]: v0.102.0/a-reset-counts-a-reference-another-can-upgrade.md
[cslib]: v0.102.0/the-control-socket-identity-names-no-library.md
[mnu]: v0.102.0/the-desktops-menu-copies-a-window-outside-its-row.md
[dkwin]: v0.102.0/the-workspace-deck-names-a-windows-root-whole.md
[bgrv]: v0.102.0/a-background-the-authority-never-took-turns-back.md
[hnsav]: v0.102.0/hybrid-nav-leaves-a-live-drawing-unsaved.md
[unsd]: v0.102.0/a-save-fallback-writes-an-unseeded-boards-buffer.md
[erlsv]: v0.102.0/a-live-drawing-save-answers-before-the-write.md
[offwin]: v0.102.0/a-late-off-row-outlives-a-removal.md
[ldrec]: v0.102.0/a-launcher-delete-leaves-a-devserver-record-on.md
[fgtomb]: v0.102.0/a-forgets-tombstone-outlasts-its-answer.md
[fgcli]: v0.102.0/chan-workspace-forget-ignores-the-hosts-answer.md
[rcorg]: v0.102.0/a-desktop-recovery-entry-ends-with-its-run.md
[rcstl]: v0.102.0/any-later-write-retires-a-recovery-entry.md
[rstlv]: v0.102.0/restore-on-a-live-board-pushes-an-older-scene.md
[dkcls]: v0.102.0/the-decks-close-row-keeps-the-window-session.md
[fclng]: v0.102.0/a-forced-pane-close-pushes-a-waiting-stroke.md
[rmrace]: v0.102.0/a-removal-does-not-hold-the-row-it-selected.md
[wclsv]: v0.102.0/a-window-close-does-not-save-first.md
[xhang]: v0.102.0/cs-export-hangs-where-the-ui-export-completes.md
[pdimg]: v0.102.0/a-slide-decks-pdf-lacks-the-images-it-shows.md
[rmgap]: v0.102.0/four-gaps-lie-outside-a-removals-row-claim.md
[hdmem]: v0.102.0/a-connecting-page-hide-lives-in-memory-alone.md
[syoff]: v0.102.0/a-sync-socket-closed-before-a-frame-stays-off.md
[fgoth]: v0.102.0/an-off-and-the-cli-forget-name-another-workspace.md
[adon]: v0.102.0/a-refused-add-registers-late-and-an-on-is-not-kept.md
[rlmt]: v0.102.0/a-root-relinked-while-mounted-cannot-be-handed-off.md
[stprd]: v0.102.0/no-client-reads-the-devserver-stopping-code.md
[stp4]: v0.102.0/a-stopping-devservers-report-left-four-findings.md
[eqtok]: v0.102.0/a-stale-files-token-can-equal-the-current-one.md
[fcany]: v0.102.0/focus-and-open-take-a-window-for-any-record.md
[cfgat]: v0.102.0/the-casefold-pins-run-in-no-gate.md
[mfchk]: v0.102.0/a-missing-file-check-commits-no-waiting-stroke.md
[rgate]: v0.102.0/a-hung-root-keeps-restored-tenants-at-503.md
[dsurl]: v0.102.0/no-printed-line-opens-the-devserver-in-a-browser.md
[smuse]: v0.102.0/the-submit-agents-name-no-muse.md
[rbrk]: v0.102.0/a-reopened-broken-drawing-comes-back-clean.md
[fglck]: v0.102.0/a-forget-finds-its-host-by-the-lock-record-alone.md
[fnc]: v0.102.0/a-fence-in-view-decorates-every-row-of-its-block.md
[hlpg]: v0.102.0/a-hardlink-pair-split-across-pages-is-not-joined.md
[dirsc]: v0.102.0/a-directory-seed-scans-the-catalog-per-node.md
[oprm]: v0.102.0/an-abandoned-open-recreates-removed-metadata.md
[lnpar]: v0.102.0/a-keystroke-in-a-long-paragraph-takes-200-ms.md
[smkrd]: v0.102.0/the-browser-smoke-suite-is-red-at-the-base.md
[pdfdr]: v0.102.0/a-drawings-picture-waits-on-the-engine-in-a-pdf.md
[mcprg]: v0.102.0/an-mcp-text-read-cannot-reach-past-its-cap.md
[drtat]: v0.102.0/a-dirty-tabs-first-sync-attach-overwrites-what-changed-under-it.md
[pkadp]: v0.102.0/a-pick-made-before-a-board-adopts-the-scene-is-dropped.md
[dkorb]: v0.102.0/the-decks-computers-orb-lights-during-each-poll.md
[hlwt]: v0.102.0/after-the-hello-a-tab-waits-for-its-snapshot-without-a-bound.md
[svfb]: v0.102.0/chan-serve-falls-back-to-a-standalone-server-the-same-lock-refuses.md
[dboot]: v0.102.0/the-desktops-boot-restore-re-serves-its-rows-one-at-a-time.md
[lmask]: v0.102.0/a-launch-urls-token-escapes-the-terminal-masker.md

## Completed

### v0.101.0

Shipped 2026-10-02; see [release-v0.101.0](../release/release-v0.101.0.md). Of its 142 items, 133 closed in [`done/`](done/) as shipped and three as withdrawn, and six moved to v0.102.0: four whose remaining work carries over and two still raised for a decision. Each closed item is named here by the behaviour it raised; what changed for a user is in the changelog:

- [a-backslash-in-a-name-reads-two-ways-on-the-wire](done/a-backslash-in-a-name-reads-two-ways-on-the-wire.md) - A backslash in a file name reads two ways on the wire.
- [a-blocking-pool-pin-passes-without-proof](done/a-blocking-pool-pin-passes-without-proof.md) - The blocking-pool pin passes for a handler that does its work on the runtime thread.
- [a-browser-show-opens-a-twin-of-a-native-window](done/a-browser-show-opens-a-twin-of-a-native-window.md) - A browser's Show opens a second window for a record that a desktop owns.
- [a-case-only-rename-leaves-a-phantom-row](done/a-case-only-rename-leaves-a-phantom-row.md) - A case-only rename leaves a phantom row on a case-insensitive volume.
- [a-click-beside-a-graph-node-clears-the-selection](done/a-click-beside-a-graph-node-clears-the-selection.md) - A click beside a graph node clears the selection.
- [a-closed-window-discards-a-connected-record](done/a-closed-window-discards-a-connected-record.md) - One window's close discards a record whose connection another window still holds.
- [a-connecting-page-close-discards-its-window](done/a-connecting-page-close-discards-its-window.md) - A close or a Disconnect on the connecting page discards a library window and reaps its terminals.
- [a-corrupt-devserver-config-re-mints-the-library-identity](done/a-corrupt-devserver-config-re-mints-the-library-identity.md) - A corrupt devserver config silently re-mints the library identity.
- [a-crash-restart-restores-a-stale-manifest](done/a-crash-restart-restores-a-stale-manifest.md) - A crash restart restores a stale sequence and tail from the manifest.
- [a-cut-paste-can-replace-the-first-moved-file](done/a-cut-paste-can-replace-the-first-moved-file.md) - A cut-paste can replace the first moved file.
- [a-destructive-confirm-focuses-its-confirm-button](done/a-destructive-confirm-focuses-its-confirm-button.md) - The shared confirm dialog focuses its confirm button, so Enter answers a destructive confirm.
- [a-draft-closed-during-its-load-is-trashed](done/a-draft-closed-during-its-load-is-trashed.md) - A draft closed before its content arrives is discarded to the trash.
- [a-drawing-library-crash-publishes-an-empty-scene](done/a-drawing-library-crash-publishes-an-empty-scene.md) - A drawing library that throws unmounts its board, and a seeded board then publishes an empty scene.
- [a-drawing-that-does-not-parse-loses-its-editor](done/a-drawing-that-does-not-parse-loses-its-editor.md) - A drawing in source mode whose buffer does not parse loses its editor.
- [a-dropped-indexers-driver-eats-recovery](done/a-dropped-indexers-driver-eats-recovery.md) - A dropped indexer's driver swallows a recovery wake.
- [a-failed-dial-makes-the-next-replay-from-zero](done/a-failed-dial-makes-the-next-replay-from-zero.md) - A failed dial makes the next terminal dial replay from zero.
- [a-failed-save-replaces-the-editor-with-its-error](done/a-failed-save-replaces-the-editor-with-its-error.md) - A save that fails replaces the file tab's editor with its message.
- [a-fresh-session-under-an-old-id-keeps-the-key-protocol](done/a-fresh-session-under-an-old-id-keeps-the-key-protocol.md) - A fresh session under an old tab id keeps the tab's key protocol.
- [a-graceful-restart-drops-output-past-its-snapshot](done/a-graceful-restart-drops-output-past-its-snapshot.md) - A graceful restart can drop output read after its last manifest write.
- [a-graceful-restarts-session-save-drops-the-terminals-session-id](done/a-graceful-restarts-session-save-drops-the-terminals-session-id.md) - A graceful restart's session save drops the terminal's session id.
- [a-hung-root-keeps-reading-running](done/a-hung-root-keeps-reading-running.md) - A mounted root that hangs, rather than errors, reads running for as long as it hangs.
- [a-hung-root-stalls-desktop-close-and-quit](done/a-hung-root-stalls-desktop-close-and-quit.md) - The desktop waits on every registered root to close a workspace, open a window or quit.
- [a-joining-snapshot-fails-during-reconcile](done/a-joining-snapshot-fails-during-reconcile.md) - A joining snapshot fails while a reconciliation runs.
- [a-kept-terminal-row-keeps-its-sessions-alive](done/a-kept-terminal-row-keeps-its-sessions-alive.md) - withdrawn, did not ship: A browser terminal window's kept row keeps its sessions alive until it is closed.
- [a-keychain-failure-freezes-a-connected-gateways-roster](done/a-keychain-failure-freezes-a-connected-gateways-roster.md) - A keychain failure freezes a connected gateway's roster without a trace.
- [a-late-fetch-after-teardown-reds-the-web-check](done/a-late-fetch-after-teardown-reds-the-web-check.md) - A late fetch after a test's teardown reds the web check.
- [a-late-http-mount-escapes-the-shutdown-sweep](done/a-late-http-mount-escapes-the-shutdown-sweep.md) - A management mount accepted just before stop can publish after the devserver's last shutdown sweep.
- [a-live-drawing-gains-appstate-keys-with-no-edit](done/a-live-drawing-gains-appstate-keys-with-no-edit.md) - A live drawing whose stored appState lacks the serializer's keys is written with no edit.
- [a-mirrored-value-focuses-an-unfocused-editor](done/a-mirrored-value-focuses-an-unfocused-editor.md) - A mirrored value focuses an unfocused editor.
- [a-mount-retry-test-races-a-wall-clock](done/a-mount-retry-test-races-a-wall-clock.md) - A mount-retry test races a five-second wall clock.
- [a-non-utf8-text-file-loses-its-backlinks](done/a-non-utf8-text-file-loses-its-backlinks.md) - A text file the workspace cannot decode loses its backlinks and is re-read on every reconcile.
- [a-pane-split-rebuilds-a-live-terminal-from-old-width-bytes](done/a-pane-split-rebuilds-a-live-terminal-from-old-width-bytes.md) - A pane split or tab move rebuilds a live terminal from bytes written at another width.
- [a-quit-can-hang-on-a-standalone-files-watch](done/a-quit-can-hang-on-a-standalone-files-watch.md) - A quit can still hang on a standalone Files window's watch.
- [a-reattach-replays-before-the-pty-takes-the-clients-size](done/a-reattach-replays-before-the-pty-takes-the-clients-size.md) - A reattach replays and redraws before the PTY takes the client's size.
- [a-redrawing-tui-never-lets-the-write-queue-drain](done/a-redrawing-tui-never-lets-the-write-queue-drain.md) - A TUI that redraws while idle never lets the write queue drain.
- [a-relinked-root-window-nests-outside-its-row](done/a-relinked-root-window-nests-outside-its-row.md) - A relinked root's handoff window nests outside its launcher row.
- [a-removal-unregisters-by-the-name-it-is-given](done/a-removal-unregisters-by-the-name-it-is-given.md) - The host's removal unregisters and purges by the name it is given, so no name reaches a restored row whose stored root resolves elsewhere.
- [a-resilience-transcript-is-dumped-before-its-readers-drain](done/a-resilience-transcript-is-dumped-before-its-readers-drain.md) - A resilience test dumps a child's transcript before its reader threads drain.
- [a-restart-replays-only-the-manifest-tail](done/a-restart-replays-only-the-manifest-tail.md) - A restart replays only the manifest's 128 KiB tail, so a fresh view reports missed bytes.
- [a-restored-terminals-close-signals-a-bare-pid](done/a-restored-terminals-close-signals-a-bare-pid.md) - The close of a restored terminal signals a process id and not the process its session started.
- [a-revocation-aborts-the-bridge-before-its-close](done/a-revocation-aborts-the-bridge-before-its-close.md) - A revocation aborts the bridge before its Close can go out.
- [a-save-after-the-shutdown-sweeps-turns-every-workspace-off](done/a-save-after-the-shutdown-sweeps-turns-every-workspace-off.md) - A save after the shutdown sweeps turns every other workspace off.
- [a-scene-snapshot-before-the-init-is-wiped](done/a-scene-snapshot-before-the-init-is-wiped.md) - A live drawing's scene snapshot applied before the drawing library's init is wiped.
- [a-scripted-reports-disable-exits-zero-having-changed-nothing](done/a-scripted-reports-disable-exits-zero-having-changed-nothing.md) - A scripted reports disable without --yes exits 0 having changed nothing.
- [a-sent-prompt-stays-editable-while-pending](done/a-sent-prompt-stays-editable-while-pending.md) - A sent prompt stays editable while it is pending.
- [a-service-spawned-extension-gets-a-bare-path](done/a-service-spawned-extension-gets-a-bare-path.md) - An extension spawned by the installed devserver gets a bare PATH, and the warning hides why it failed.
- [a-single-file-copy-skips-the-utf8-gate](done/a-single-file-copy-skips-the-utf8-gate.md) - A single-file copy skips the UTF-8 gate.
- [a-spawned-child-holds-a-lock-until-it-execs](done/a-spawned-child-holds-a-lock-until-it-execs.md) - A spawned child holds a duplicate of a workspace lock until it execs.
- [a-stalled-reader-parks-a-pool-thread](done/a-stalled-reader-parks-a-pool-thread.md) - A client that stops reading parks a blocking-pool thread.
- [a-started-mcp-tool-cannot-be-cancelled](done/a-started-mcp-tool-cannot-be-cancelled.md) - A started MCP tool cannot be cancelled and holds its root's writer lock until it returns.
- [a-stopping-devserver-says-it-is-restoring](done/a-stopping-devserver-says-it-is-restoring.md) - While a devserver stops, its startup gate answers every tenant request that it is restoring terminal sessions.
- [a-stroke-in-the-debounce-is-lost-to-a-load](done/a-stroke-in-the-debounce-is-lost-to-a-load.md) - A drawing's stroke still inside the canvas's debounce is lost when its tab loads again.
- [a-sweep-test-overran-its-ten-seconds-on-windows](done/a-sweep-test-overran-its-ten-seconds-on-windows.md) - A test of chan-library ran out its own ten-second bound once on a hosted Windows runner.
- [a-tab-copy-reseeds-over-a-first-stroke](done/a-tab-copy-reseeds-over-a-first-stroke.md) - A board reseeds when its tab is copied, and Hybrid Nav copies every tab with no commit first.
- [a-tab-list-duplicate-key-escapes-its-boundary](done/a-tab-list-duplicate-key-escapes-its-boundary.md) - A duplicate key in a tab list escapes the per-tab boundary.
- [a-test-reads-a-row-before-the-lock-is-released](done/a-test-reads-a-row-before-the-lock-is-released.md) - A devserver test reads a workspace's row before the lock that row probes is released.
- [a-test-waits-on-a-reference-and-not-on-the-lock](done/a-test-waits-on-a-reference-and-not-on-the-lock.md) - A test of the host waits on a reference and not on the lock's release.
- [a-watcher-loss-leaves-the-code-report-stale](done/a-watcher-loss-leaves-the-code-report-stale.md) - A watcher loss leaves the code report stale for the rest of the session.
- [an-admitted-tunnel-outlives-its-connection](done/an-admitted-tunnel-outlives-its-connection.md) - An ended tunnel keeps its connection, and a refused bridge tells the browser nothing.
- [an-adopted-sessions-recorded-size-can-lag-its-pty](done/an-adopted-sessions-recorded-size-can-lag-its-pty.md) - An adopted session's recorded size can lag its PTY after a restart.
- [an-attached-json-tab-skips-the-parse-check](done/an-attached-json-tab-skips-the-parse-check.md) - A JSON tab attached to a document session skips the save's parse check.
- [an-element-with-no-version-is-written-unedited](done/an-element-with-no-version-is-written-unedited.md) - A live drawing whose elements carry no version is written by a window that only opens it.
- [an-emptied-window-waits-without-a-bound](done/an-emptied-window-waits-without-a-bound.md) - An emptied window waits for its move-out without a bound.
- [an-expired-survey-cannot-be-dismissed](done/an-expired-survey-cannot-be-dismissed.md) - A survey whose request is gone cannot be dismissed.
- [an-inspector-effect-refetches-a-failing-graph-stream-without-bound](done/an-inspector-effect-refetches-a-failing-graph-stream-without-bound.md) - An inspector effect refetches a failing graph stream without bound.
- [an-mcp-read-loads-the-whole-file-before-its-cap](done/an-mcp-read-loads-the-whole-file-before-its-cap.md) - An MCP tool reads a whole file before its size cap applies.
- [an-open-with-no-bound-holds-a-hung-roots-lock](done/an-open-with-no-bound-holds-a-hung-roots-lock.md) - An open with no time limit of its own holds a hung root's lock, and a close of that root waits behind it.
- [an-unknown-window-kind-may-drop-every-window-row](done/an-unknown-window-kind-may-drop-every-window-row.md) - One unreadable window row may drop every window row.
- [co-viewers-of-a-window-keep-an-answered-survey](done/co-viewers-of-a-window-keep-an-answered-survey.md) - Co-viewers of one window keep an answered survey.
- [content-search-truncation-ignores-its-window](done/content-search-truncation-ignores-its-window.md) - Content search can report a truncated result as complete.
- [desktop-design-omits-the-root-health-probe](done/desktop-design-omits-the-root-health-probe.md) - The desktop design does not mention the root health probe.
- [devserver-root-probe-wiring-has-no-test](done/devserver-root-probe-wiring-has-no-test.md) - No test pins the devserver's root health probe.
- [four-tests-still-read-source-with-node-fs](done/four-tests-still-read-source-with-node-fs.md) - Four tests still read source with node:fs.
- [gateway-ci-misses-root-tunnel-crate-changes](done/gateway-ci-misses-root-tunnel-crate-changes.md) - Gateway CI does not run when the root tunnel crates change.
- [graph-bodies-have-no-mounted-test](done/graph-bodies-have-no-mounted-test.md) - Graph bodies have no mounted test.
- [hand-mirrored-contracts-have-no-gate](done/hand-mirrored-contracts-have-no-gate.md) - Contracts mirrored by hand across the seam have nothing checking the copies.
- [is-root-mounted-answers-from-the-first-tenant-the-key-finds](done/is-root-mounted-answers-from-the-first-tenant-the-key-finds.md) - The by-root mount query answers from the first tenant the key finds.
- [mcp-write-errors-follow-an-unpinned-display](done/mcp-write-errors-follow-an-unpinned-display.md) - Three MCP error texts follow an unpinned Display.
- [mounted-components-mutate-props-they-do-not-own](done/mounted-components-mutate-props-they-do-not-own.md) - Mounted components mutate props they do not own.
- [move-and-create-can-replace-a-new-file](done/move-and-create-can-replace-a-new-file.md) - A move or a create can replace a file created a moment earlier.
- [one-close-reason-covers-a-parked-and-a-killed-pty](done/one-close-reason-covers-a-parked-and-a-killed-pty.md) - One close reason covers a PTY parked for restore and a PTY that was killed.
- [one-hung-root-holds-up-the-whole-restore](done/one-hung-root-holds-up-the-whole-restore.md) - One hung root holds up every other restored workspace and the devserver's READY.
- [one-root-blocks-every-other-mount](done/one-root-blocks-every-other-mount.md) - One root's release budget blocks every other mount, close and remove.
- [page-break-scan-and-renderer-still-differ](done/page-break-scan-and-renderer-still-differ.md) - withdrawn, did not ship: Page-break line scan and renderer still differ on some inputs.
- [profile-workers-have-no-shutdown-owner](done/profile-workers-have-no-shutdown-owner.md) - Profile's background workers have no shutdown owner.
- [refusals-answer-in-four-shapes](done/refusals-answer-in-four-shapes.md) - A refusal answers in one of four shapes, and only one of them is the convention.
- [signing-has-no-early-credential-probe](done/signing-has-no-early-credential-probe.md) - Windows signing has no early credential probe.
- [source-text-tests-pin-spelling-not-behaviour](done/source-text-tests-pin-spelling-not-behaviour.md) - Two hundred frontend tests pin spelling, not behaviour.
- [stale-sentences-outlive-their-code](done/stale-sentences-outlive-their-code.md) - Five families of sentences still describe code that changed under them.
- [terminal-env-overrides-are-silently-dropped](done/terminal-env-overrides-are-silently-dropped.md) - Terminal env overrides for TERM, HOME, NO_COLOR and CI are silently dropped.
- [tests-signal-a-process-they-did-not-start](done/tests-signal-a-process-they-did-not-start.md) - Two tests of chan-library signal a process they did not start, and one of chan-server kills by command line.
- [the-apps-wake-path-outlives-its-mount](done/the-apps-wake-path-outlives-its-mount.md) - The app's wake path outlives its mount and a failed resume rejects unhandled.
- [the-attach-prelude-order-has-no-rust-test](done/the-attach-prelude-order-has-no-rust-test.md) - The terminal attach prelude order has no Rust test.
- [the-aur-check-could-ship-a-test-only-feature](done/the-aur-check-could-ship-a-test-only-feature.md) - Nothing pins the one packaging recipe whose shape could ship a test-only feature.
- [the-aur-check-is-killed-with-its-hosted-runner](done/the-aur-check-is-killed-with-its-hosted-runner.md) - The AUR check's release test build is killed with its hosted runner.
- [the-bulk-skip-note-calls-unknown-locked](done/the-bulk-skip-note-calls-unknown-locked.md) - The bulk-skip note calls an unknown row locked.
- [the-canonical-key-query-counts-the-terminal-tenant](done/the-canonical-key-query-counts-the-terminal-tenant.md) - The canonical-key mount query counts the terminal tenant as a workspace.
- [the-chan-cli-crate-is-one-13k-line-file](done/the-chan-cli-crate-is-one-13k-line-file.md) - The chan CLI crate is one 13,736-line file.
- [the-chan-home-fallback-trusts-var-tmp](done/the-chan-home-fallback-trusts-var-tmp.md) - The chan home fallback trusts a path under /var/tmp.
- [the-control-sockets-directory-is-believed-as-found](done/the-control-sockets-directory-is-believed-as-found.md) - The control socket's directory is believed as found, by the server that binds in it and by every client.
- [the-desktop-decodes-a-window-feed-all-or-nothing](done/the-desktop-decodes-a-window-feed-all-or-nothing.md) - The desktop decodes a devserver's window feed all or nothing.
- [the-desktop-handoff-keys-an-absent-root](done/the-desktop-handoff-keys-an-absent-root.md) - The desktop handoff keys an absent root before it creates it.
- [the-desktop-takes-ctrl-right-bracket-from-a-shell](done/the-desktop-takes-ctrl-right-bracket-from-a-shell.md) - The desktop takes Ctrl+] from a focused shell.
- [the-detached-daemon-keeps-the-launching-shells-directory](done/the-detached-daemon-keeps-the-launching-shells-directory.md) - The detached devserver daemon keeps the launching shell's directory.
- [the-devserver-stop-refuses-mounts-before-the-host](done/the-devserver-stop-refuses-mounts-before-the-host.md) - A stopping devserver refuses a new mount with a config error before its host is asked.
- [the-email-fold-merges-distinct-characters](done/the-email-fold-merges-distinct-characters.md) - withdrawn, did not ship: The grant-claim email fold merges distinct characters.
- [the-extension-proxy-forwards-to-an-exited-port](done/the-extension-proxy-forwards-to-an-exited-port.md) - The extension proxy forwards to an exited extension's port with the extension's token.
- [the-fdstore-manifest-splits-seq-and-tail](done/the-fdstore-manifest-splits-seq-and-tail.md) - The fd-store manifest reads the sequence apart from its replay tail.
- [the-gate-container-runs-as-root](done/the-gate-container-runs-as-root.md) - The build container runs the gate as root, so a fault that needs a user who is not root shows in no gate.
- [the-graph-indexer-drops-renames-and-lingers](done/the-graph-indexer-drops-renames-and-lingers.md) - The graph indexer drops a rename's destination and outlives its drop.
- [the-launcher-build-hint-cannot-run](done/the-launcher-build-hint-cannot-run.md) - The launcher-not-built hint names a command that cannot run.
- [the-launcher-says-off-beside-running](done/the-launcher-says-off-beside-running.md) - The launcher says Off beside a running status.
- [the-launchers-add-and-on-skip-the-stop-check](done/the-launchers-add-and-on-skip-the-stop-check.md) - The launcher's own add and on never ask a stopping devserver's coordinator.
- [the-linux-gate-has-no-windows-target-check](done/the-linux-gate-has-no-windows-target-check.md) - The Linux gate has no Windows-target check for the crates the Windows arm compiles.
- [the-linux-gate-runs-tests-under-a-canonical-tmpdir](done/the-linux-gate-runs-tests-under-a-canonical-tmpdir.md) - The Linux gate runs every test under a canonical temp directory.
- [the-memfd-ring-mirror-doubles-the-terminals-memory](done/the-memfd-ring-mirror-doubles-the-terminals-memory.md) - The memfd ring mirror doubles a terminal's memory and costs peak write throughput.
- [the-move-out-spare-covers-the-whole-window](done/the-move-out-spare-covers-the-whole-window.md) - The move-out spare covers the whole window.
- [the-nsis-uninstaller-stub-ships-unsigned](done/the-nsis-uninstaller-stub-ships-unsigned.md) - The NSIS uninstaller stub ships unsigned.
- [the-quit-drain-can-hang-on-a-recovery-pass](done/the-quit-drain-can-hang-on-a-recovery-pass.md) - The quit drain can hang on a mounted root's recovery pass.
- [the-root-stall-names-a-step-by-symbols](done/the-root-stall-names-a-step-by-symbols.md) - The root stall holds a named step only in a build that keeps its symbols.
- [the-scripted-team-drops-member-env](done/the-scripted-team-drops-member-env.md) - The scripted team form drops every member's env.
- [the-served-index-forgets-a-lone-rename](done/the-served-index-forgets-a-lone-rename.md) - The served index forgets the destination of a lone rename.
- [the-settings-date-format-never-saves](done/the-settings-date-format-never-saves.md) - The Settings date format never saves.
- [the-side-effect-and-error-lows-are-unread](done/the-side-effect-and-error-lows-are-unread.md) - The side-effect and error-handling lows were never read.
- [the-site-carries-a-workspace-mock-nobody-ships](done/the-site-carries-a-workspace-mock-nobody-ships.md) - The site carries a workspace mock nobody ships, and the graph tuner a fixture nobody uses.
- [the-team-poke-names-a-path-it-does-not-anchor](done/the-team-poke-names-a-path-it-does-not-anchor.md) - The team identity poke names a relative path and never says what it is relative to.
- [the-terminal-tenant-answers-for-a-home-workspace](done/the-terminal-tenant-answers-for-a-home-workspace.md) - The terminal tenant answers for a registered home workspace.
- [the-test-util-comments-omit-the-attach-seam](done/the-test-util-comments-omit-the-attach-seam.md) - The test-util comments do not name the attach seam.
- [the-web-bundles-still-build-on-node-20](done/the-web-bundles-still-build-on-node-20.md) - The web bundles still build on node 20 everywhere but Nix.
- [the-writer-lock-probe-waits-on-a-hung-root](done/the-writer-lock-probe-waits-on-a-hung-root.md) - The writer-lock probe resolves a root another process holds, so a hung one stalls the workspace lists.
- [three-inputs-have-no-size-cap](done/three-inputs-have-no-size-cap.md) - Three inputs have no size cap.
- [tower-sessions-lags-and-axum-has-a-dead-feature](done/tower-sessions-lags-and-axum-has-a-dead-feature.md) - tower-sessions is held a release behind, and axum carries a feature nothing uses.
- [two-closes-still-drop-a-drawings-last-stroke](done/two-closes-still-drop-a-drawings-last-stroke.md) - A pane close from the control client, and a window's close, can still drop a drawing's last stroke.
- [two-copies-to-one-free-name-can-collide](done/two-copies-to-one-free-name-can-collide.md) - Two copies to one free name can still collide.
- [two-exact-pins-hold-back-web-upgrades](done/two-exact-pins-hold-back-web-upgrades.md) - Two exact version pins hold back routine web upgrades.
- [two-warning-capture-tests-race-a-callsite-cache](done/two-warning-capture-tests-race-a-callsite-cache.md) - Two tests of chan-library that capture warnings fail now and then.

### v0.100.0

Shipped 2026-09-23; see [release-v0.100.0](../release/release-v0.100.0.md). All forty items closed in [`done/`](done/), and the carry-overs this round raised are under v0.101.0:

- [a-canvas-edit-made-during-an-outage-can-be-lost](done/a-canvas-edit-made-during-an-outage-can-be-lost.md) - a canvas change counts as sent only when it was sent, every session kind registers all five contract members, and a degraded session has exactly one writer.
- [a-checkbox-click-writes-a-read-only-document](done/a-checkbox-click-writes-a-read-only-document.md) - one predicate decides whether a widget may write, checking the read-only state and the editable facet, so a checkbox cannot write to a read-only document.
- [a-close-after-a-prompt-can-remove-the-wrong-tab](done/a-close-after-a-prompt-can-remove-the-wrong-tab.md) - a close identifies its tab by id after the last await and is a no-op if the tab is gone, so a prompt can no longer make it remove a neighbour.
- [a-dropped-indexer-strands-the-recovery-slot](done/a-dropped-indexer-strands-the-recovery-slot.md) - a coordinator that goes away mid-pass requeues its recovery claim, and a recovery action that keeps failing waits a cooldown between attempts.
- [a-duplicate-list-key-kills-its-panel](done/a-duplicate-list-key-kills-its-panel.md) - list keys are unique for every shape the server may send, and a render throw in a pane, an inspector section or the launcher's deck is contained with a retry.
- [a-failed-load-is-retried-forever](done/a-failed-load-is-retried-forever.md) - a failed load shows where the content would have been and is not retried until something that could make it succeed changes.
- [a-failed-revoke-looks-like-a-revoke](done/a-failed-revoke-looks-like-a-revoke.md) - a failed revoke says so next to what was not revoked, the token and grant lists stay current, and revocation is confirmed through the app's own modal.
- [a-file-tab-moved-mid-load-shows-loading-for-good](done/a-file-tab-moved-mid-load-shows-loading-for-good.md) - a load that stops leaves no tab claiming to be loading, and a tab that moved mid-load finishes or restarts its load where it now is.
- [a-move-onto-an-occupied-name-behaves-two-ways](done/a-move-onto-an-occupied-name-behaves-two-ways.md) - every move gesture refuses a collision and names the occupied path, and the overwrite confirm the server never honoured is gone.
- [a-prerelease-deb-is-spelled-with-a-dot](done/a-prerelease-deb-is-spelled-with-a-dot.md) - `requiredAssets` names the Debian form cargo-deb writes, and the rc2 and rc3 dry runs' downloaded artifacts matched it 25 of 25 with the gateway debs spelled with a tilde.
- [a-rejected-settings-write-looks-saved](done/a-rejected-settings-write-looks-saved.md) - a rejected settings write shows on its field, which returns to the server's value, and every settings write reports through one `SaveStatus` vocabulary.
- [a-replaced-root-still-reads-running-on-the-desktop](done/a-replaced-root-still-reads-running-on-the-desktop.md) - the root health probe is one function both embedders start, so the desktop reads a gone or replaced root as `unavailable` within one probe period and clears it when the directory returns.
- [a-restored-transfer-id-collides-with-a-new-one](done/a-restored-transfer-id-collides-with-a-new-one.md) - transfer ids are unique among every record the window holds, restored or new.
- [a-tab-reorder-drops-live-tab-state](done/a-tab-reorder-drops-live-tab-state.md) - cloning a tab keeps every field unless the code names it as a deliberate drop, with a test that fails when a new field is undecided.
- [a-terminal-chunk-arrives-twice-on-attach](done/a-terminal-chunk-arrives-twice-on-attach.md) - recording output and attaching take the ring under one lock, so a chunk that races an attach arrives once and a reconnect resumes from the true end of what was sent.
- [a-terminal-moved-to-another-window-loses-its-tab-state](done/a-terminal-moved-to-another-window-loses-its-tab-state.md) - a terminal moved to another window arrives with the state a reload would restore, and a payload from an older build still reattaches the shell.
- [a-timed-out-mount-closes-a-tenant-it-did-not-open](done/a-timed-out-mount-closes-a-tenant-it-did-not-open.md) - a devserver mount attempt whose bound expires compensates only for what it may have created, so a tenant something else mounted keeps its sessions and its row.
- [browser-smoke-reports-results-it-did-not-measure](done/browser-smoke-reports-results-it-did-not-measure.md) - the e2e harnesses fail or skip for a named reason when they cannot evaluate a check, record measured values, and always end with a verdict file.
- [bubble-triggers-fire-inside-existing-syntax](done/bubble-triggers-fire-inside-existing-syntax.md) - editor triggers stay out of existing images, links, heading markers and fenced code blocks.
- [chan-open-is-gone-and-forget-is-a-second-verb](done/chan-open-is-gone-and-forget-is-a-second-verb.md) - `chan open` is a spelling of `chan serve` and `chan close --forget` a spelling of `chan workspace forget`, with the same arguments, refusals and reach.
- [cs-terminal-close-acks-a-close-that-did-not-happen](done/cs-terminal-close-acks-a-close-that-did-not-happen.md) - `cs terminal close` waits within a shared deadline for every closed session's child to end and fails naming each survivor instead of acknowledging a close that did not happen.
- [document-pdf-export-measures-before-images-load](done/document-pdf-export-measures-before-images-load.md) - document PDF export measures only after every image has loaded or failed, inlines images once per export, and exports an embed as a printable link.
- [dump-skill-prints-more-than-an-agent-can-read](done/dump-skill-prints-more-than-an-agent-can-read.md) - `chan dump-skill` prints an index by default, topic pages split into indexed parts under an 8 KiB budget, and `--full` is the explicit unbounded export.
- [escape-closes-the-overlay-under-an-open-menu](done/escape-closes-the-overlay-under-an-open-menu.md) - the first Escape closes an open menu and nothing else, and focus returns to the control that opened it.
- [four-detectors-disagree-about-page-breaks](done/four-detectors-disagree-about-page-breaks.md) - `<hr class="chan-page-break">` is the one page break every surface detects, with near misses normalized on write and `@pagebreak` kept as an authoring macro.
- [frontend-gate-holes-let-broken-bundles-ship](done/frontend-gate-holes-let-broken-bundles-ship.md) - everything that ships or renders a verdict runs under a `make ci-*` target, and a release job that builds a bundle by hand asserts the bundle exists before compiling it in.
- [full-window-covers-do-not-block-input](done/full-window-covers-do-not-block-input.md) - every full-window cover blocks keyboard chords, the Ctrl+D capture and host commands through one registration, and the screensaver lock is a real boundary for its window.
- [image-actions-die-after-an-edit-above-the-image](done/image-actions-die-after-an-edit-above-the-image.md) - an image action resolves its source range from the live syntax tree when it runs, and its document listeners leave with their view.
- [no-test-pins-the-unavailable-mint-contract](done/no-test-pins-the-unavailable-mint-contract.md) - a test now pins that a registration for a mounted but degraded workspace mounts, mints one window and succeeds, with the degraded state on the window and the launcher row.
- [one-on-route-still-answers-204](done/one-on-route-still-answers-204.md) - every turn-on verb answers 200 with the workspace's launcher row, the connected-devserver route included, and refusals keep their codes and bodies.
- [rich-copy-puts-the-session-token-on-the-clipboard](done/rich-copy-puts-the-session-token-on-the-clipboard.md) - rich copy writes image URLs without the `t=` bearer, so the session token never leaves the app on the clipboard.
- [rich-prompt-submit-throws-on-plain-http](done/rich-prompt-submit-throws-on-plain-http.md) - ids are minted through one helper that works in every context chan is served in, so Rich Prompt submits on a devserver reached over plain http.
- [shortcuts-ignore-the-keyboard-layout](done/shortcuts-ignore-the-keyboard-layout.md) - letter and punctuation shortcuts follow the active keyboard layout on every surface, and the extension keyboard relay moved to v2 across chan, mobile-chat and Doom; the macOS Colemak, Dvorak and Option checks are pending for the contributor.
- [terminal-chords-run-twice-or-not-at-all](done/terminal-chords-run-twice-or-not-at-all.md) - each chord the terminal claims produces exactly one action through one rule all four dispatch points consult.
- [the-connecting-window-offers-retry-before-it-tried](done/the-connecting-window-offers-retry-before-it-tried.md) - the connecting window offers Retry only after the connection has failed or timed out, and announces state changes rather than the clock.
- [the-copr-probe-window-is-shorter-than-its-builds](done/the-copr-probe-window-is-shorter-than-its-builds.md) - the COPR publication probe waits 7,200 seconds, sized from the measured worst normal release, with trigger and verify as separate jobs.
- [the-desktop-reads-any-409-as-live-terminals](done/the-desktop-reads-any-409-as-live-terminals.md) - the desktop recognizes a live-terminals refusal by its `live_terminals` discriminator and shows any other 409 with its own message.
- [the-dl-pipeline-fails-open](done/the-dl-pipeline-fails-open.md) - the `/dl` pipeline errors on a missing tag, spells asset names once, and requires a signature for every updater payload it can publish.
- [the-rust-review-lows-were-never-triaged](done/the-rust-review-lows-were-never-triaged.md) - every one of the 116 defect-shaped Rust review lows ends in a disposition with a re-checked line, 21 of them fixed in this round, 11 refuted and the rest carried with a stated reason.
- [two-live-samples-of-one-lock-disagree](done/two-live-samples-of-one-lock-disagree.md) - the foreign-holder lock probe is three-state, so a transient open failure reads as `unknown` with its reason instead of another process holding the lock.

### v0.99.0

Shipped 2026-09-19; see [release-v0.99.0](../release/release-v0.99.0.md). No roadmap item closed and three carried to v0.100.0: the release was a thirty-cycle fix loop over a code review, run outside this roadmap, and its three raised items (the page-break detectors, the unavailable-mint contract, the COPR probe window) were not part of it. The release report and the changelog are the record of what shipped; items for that work may still be added to [`done/`](done/) from the round's archive.

### v0.98.0

Shipped 2026-08-25; see [release-v0.98.0](../release/release-v0.98.0.md). Closed items in [`done/`](done/):

- [an-empty-table-cell-breaks-the-editor-grid](done/an-empty-table-cell-breaks-the-editor-grid.md) - the editor's grid keeps the columns the source has, reading each row from its `TableDelimiter` positions so an empty cell is a cell, with the per-row text pinned against `renderMarkdown` so the editor and the export cannot drift apart again.
- [chan-serve-does-not-always-open-a-window](done/chan-serve-does-not-always-open-a-window.md) - `chan serve PATH` ends with a window on every route, minting after restore on an explicit open while boot restore still mints nothing, with devserver registration made conjunctive; the desktop focus checks need a display host and were not observed.
- [the-cs-link-bubble-outlived-its-automation](done/the-cs-link-bubble-outlived-its-automation.md) - the `cs` card, its route, its snapshot fields and its persisted preference are gone now that every supported install creates the alias; a real first open with no card was not observed on a display host.
- [a-new-deck-does-not-say-how-to-add-a-slide](done/a-new-deck-does-not-say-how-to-add-a-slide.md) - a new deck seeds the page-break instruction under its first heading, pinned by exact equality on both the frontmatter and the body.

Four items closed and none carried. The round also folded in a merged branch that keeps a workspace on a flapping network mount openable, and fixed the two defects that branch brought with it: an e2e script that failed `make shell-check`, and a transport-error classifier that made `chan-workspace` fail to compile for Windows. The second was caught by the mandatory Windows cross-check with the tag still unpushed, which four green full-tree gates could not see because the gate is Linux-only. Two follow-ups were raised into v0.99.0, one of them from checking a claim the deck item made about its own regex.

### v0.97.0

Shipped 2026-08-24; see [release-v0.97.0](../release/release-v0.97.0.md). Closed items in [`done/`](done/):

- [the-fd-budget-disengages-where-it-cannot-measure](done/the-fd-budget-disengages-where-it-cannot-measure.md) - FreeBSD reads the current process's descriptor count through `KERN_PROC_NFDS` without opening a probe descriptor, so pressure policy stays engaged on stock systems without `fdescfs`; the kernel path and live count were exercised on FreeBSD 15 arm64.
- [the-reindex-pacing-loop-can-wait-forever](done/the-reindex-pacing-loop-can-wait-forever.md) - the reserve scales to a quarter of small descriptor tables and every pacing call has a half-second backstop, so indexing degrades under pressure rather than waiting for impossible headroom; limits 64 through 256 completed on FreeBSD and macOS.
- [the-windows-cli-ships-but-is-unreachable](done/the-windows-cli-ships-but-is-unreachable.md) - the standalone x64 Windows CLI has a SHA-verified PowerShell installer, published metadata and self-upgrade, while a desktop companion still routes to NSIS; native Windows CI installs, refuses unsafe cases and completes a real self-replacement.
- [freebsd-devserver-has-no-default-service](done/freebsd-devserver-has-no-default-service.md) - `chan devserver start|status|stop|join` defaults to chan's portable daemon on FreeBSD while unknown systems still refuse; the no-flag lifecycle ran on a real FreeBSD box.

Four items closed and none carried. The round also fixed the remaining absent frontend build-stamp invalidation, serialized FreeBSD's process-global `openpty` allocation, and removed a wall-clock race from both disk-echo TTL tests. The Windows stable-URL fetch is post-tag acceptance because the endpoint cannot serve v0.97.0 before publication.

### v0.96.0

Shipped 2026-08-23; see [release-v0.96.0](../release/release-v0.96.0.md). Closed items in [`done/`](done/):

- [freebsd-is-not-a-published-target](done/freebsd-is-not-a-published-target.md) - chan publishes static FreeBSD amd64 and arm64 tarballs, `install.sh` selects both and falls back to base-system `fetch`, and `chan upgrade` resolves either; the port's build-side fixes ship with it, and the four defects intake found in the FreeBSD-only code were fixed in the round. arm64 was scoped out and added back at the close after a probe proved nightly `-Z build-std` builds the tier-3 target. No FreeBSD code in the release has been executed on either architecture, and the stock-host checks remain owner acceptance.
- [the-release-pipeline-builds-cold-and-serially](done/the-release-pipeline-builds-cold-and-serially.md) - release jobs restore the caches `main`'s CI writes and start from `release context` rather than behind validation, the validate jobs stop compiling `tauri-cli`, and the build scripts stop marking unchanged trees stale; acceptance 3 holds for the model bundle only and acceptance 4 cannot be observed until the first `main` run after this GA.
- [a-terminal-can-lose-keyboard-focus-after-macos-wake](done/a-terminal-can-lose-keyboard-focus-after-macos-wake.md) - a focused terminal accepts keyboard input after macOS wake without a tab switch, guarded so no overlay or external DOM owner is stolen from; the real WKWebView sleep/wake smoke remains owner acceptance.

Three items closed and none carried. All three arrived as finished branches and were taken through intake; the FreeBSD intake found four defects that four green dispatches had not, because the code is `#[cfg(target_os = "freebsd")]` and no test in the round could reach it, and the round's gate then found two more that review had not.

### v0.95.0

Shipped 2026-08-21; see [release-v0.95.0](../release/release-v0.95.0.md). Closed items in [`done/`](done/):

- [a-workspace-on-a-remote-devserver-cannot-be-managed-from-the-cli](done/a-workspace-on-a-remote-devserver-cannot-be-managed-from-the-cli.md) - `chan workspace serve|close|forget WS --on TARGET` (and the elevated spellings) manage a workspace on a registered, connected devserver through the desktop handoff, with refusal over guessing at every step and `--on` distinct from `--devserver`; proven against real processes under Xvfb, with the ssh control-terminal connect, the gateway arm, and real Windows pipes named as unproven.
- [the-linux-appimage-does-not-self-upgrade](done/the-linux-appimage-does-not-self-upgrade.md) - the AppImage self-upgrades on launch and from `chan upgrade`, with both drivers serialized; every release signs both AppImages and the `/dl` manifest carries the Linux updater entries.
- [the-windows-install-does-not-self-upgrade](done/the-windows-install-does-not-self-upgrade.md) - the NSIS install stages a verified installer on launch and installs it on restart or from `chan upgrade` through the companion `chan.exe`, with the passive reinstall unproven on real Windows 11 (the named gap).
- [the-chan-tree-does-not-speak-the-cs-prefix-grammar](done/the-chan-tree-does-not-speak-the-cs-prefix-grammar.md) - every level of `chan` resolves an unambiguous prefix and refuses an ambiguous one, pinned structurally.
- [the-appimage-cli-resolves-relative-paths-inside-the-mount](done/the-appimage-cli-resolves-relative-paths-inside-the-mount.md) - the AppImage shims restore the caller's directory, and the standalone transfer leg signals a lexically clean path that keeps a symlinked name.

Five items closed and none carried. Two arrived as pre-built branches taken through intake and three were raised or finished in the round; the round's close review over every commit since v0.94.0 landed its findings as fixes before the cut, and the Windows verbatim-prefix leak the owner remembered was found and fixed in the same pass.

### v0.94.0

Shipped 2026-08-19; see [release-v0.94.0](../release/release-v0.94.0.md). Closed items in [`done/`](done/):

- [cli-grammar-noun-families](done/cli-grammar-noun-families.md) - the CLI speaks noun families: `chan workspace serve|close|forget`, a pinned top-level serve/close elevation, and a devserver noun with server-side and new client-side verbs over the desktop handoff socket; no aliases and no deprecation cycle, with the remote workspace arms deferred pending an owner ruling.
- [a-standalone-window-cannot-create-drafts](done/a-standalone-window-cannot-create-drafts.md) - drafts and Rich Prompt work in standalone windows over a per-library `DraftStore` with a working flat trash, including the companion repair that makes a discarded workspace draft a restorable trash entry; workspace windows byte-identical.
- [host-minted-gateway-pats-bypass-the-app-layer](done/host-minted-gateway-pats-bypass-the-app-layer.md) - operator PAT mint and revoke ride the app layer with default expiry, audit-truthful `revoked_via_admin`, revoke parity with the owner's immediate cut, and the CLI 202 fix; the prod-host wrapper install and PAT rotation remain the host's deploy actions.
- [extensions-are-undiscoverable-and-have-no-authoring-guide](done/extensions-are-undiscoverable-and-have-no-authoring-guide.md) - `docs/extensions.md` is the extensions front door (design, bridge table, authoring walkthrough, the codified `chan-ext-*` packaging convention), linked from a new README Guides section beside the previously orphaned config reference.
- [the-api-files-alias-outlives-its-documented-removal](done/the-api-files-alias-outlives-its-documented-removal.md) - the alias is removed on the release its deprecation named, with live 404 refusal pins in both routers, refusal classifiers in the desktop and gateway, and a mount-literal source pin.
- [the-tunnel-namespace-says-usr-instead-of-proxy](done/the-tunnel-namespace-says-usr-instead-of-proxy.md) - the proxy plane speaks `proxy.{domain}` in every live document, fixture, and shipped configuration; history keeps the names it shipped with, and the live cutover is the operator's chan-prod-setup rollout.

Six items closed and none carried. Three arrived as pre-built branches taken through intake, three were raised and implemented in the round itself; the round's gate burned down five reds, two of them dynamically-built alias consumers invisible to a literal grep and three of them fallout the rename sweep could not see (mixed-case fixtures, rustfmt width).

### v0.93.0

Shipped 2026-08-18; see [release-v0.93.0](../release/release-v0.93.0.md). Closed items in [`done/`](done/):

- [one-filesystem-namespace-and-a-workspace-window-that-can-reach-it](done/one-filesystem-namespace-and-a-workspace-window-that-can-reach-it.md) - file content and transfers serve from one `/api/fs` namespace rooted at the serving tenant's capability root, `cs download` and `cs upload` behave identically in every window kind, and `/api/files` stays as an alias documented for removal in v0.94.0; the migration was 243 live references across 73 files against an item that estimated five.
- [the-linux-desktop-still-refuses-webgl-after-its-blocker-was-fixed](done/the-linux-desktop-still-refuses-webgl-after-its-blocker-was-fixed.md) - the renderer follows the desktop's own dma-buf decision instead of the operating system, delivered for the AppImage only, and the lane caught a shipping blocker in its own change that the lead had already cleared; all three pixel readings are unmeasured and named as a gap.
- [the-desktop-liveness-probe-test-is-load-sensitive-and-unexplained](done/the-desktop-liveness-probe-test-is-load-sensitive-and-unexplained.md) - the mechanism is fork-time descriptor inheritance, close-on-exec acting at exec rather than at fork, proven outside the flaky test and repaired structurally; the rig measured 0 red in 15 on unmodified code, so the acceptance is a deterministic 20-of-20 forced race rather than a rate.

Three items closed and none carried. The round also produced work no item asked for: a package-parameterised one-CPU reproduction rig, the first measured flake rates this project holds for that population (3 in 15 and 1 in 15 for two unrelated tests), a pre-existing transfer-ceiling disagreement between the browser-smoke checks and the product on unmodified code, and a bounded production reach for the liveness mechanism that `try_handoff` contains. Its two genuine gate reds were both in places a scoped check cannot see: the separate gateway workspace, which the root formatter never reaches, and stale in-tree guards that only the full `web-check` and `--all-targets` runs exercise.

### v0.92.0

Shipped 2026-08-17; see [release-v0.92.0](../release/release-v0.92.0.md). Closed items in [`done/`](done/):

- [the-gateway-has-no-canonical-desktop-to-devserver-design](done/the-gateway-has-no-canonical-desktop-to-devserver-design.md) - the gateway has one cross-component design with four parsed Mermaid diagrams, and the documentation set was checked against the live implementation rather than against its own stale claims.
- [a-terminal-renderer-can-cache-glyphs-before-its-font-loads](done/a-terminal-renderer-can-cache-glyphs-before-its-font-loads.md) - renderer construction waits for the selected bundled face and uses a stable fallback chain when it cannot load; the automated gates passed, while a separate cold-cache pixel reading was not recorded.
- [graph-from-here-on-a-directory-comes-up-without-its-files](done/graph-from-here-on-a-directory-comes-up-without-its-files.md) - a directory scope opens at the shallowest depth that contains a file, proven red then green in a browser check over the actual graph payload.
- [the-about-widget-bottom-row-touches-the-window-edge](done/the-about-widget-bottom-row-touches-the-window-edge.md) - the browser surface measured equal margins and the native window was confirmed on WKWebView; WebKitGTK was not exercised and remains a named evidence gap.
- [an-external-edit-intermittently-never-reaches-a-dirty-editor](done/an-external-edit-intermittently-never-reaches-a-dirty-editor.md) - closed without a behavior change after the non-converging arm was characterized as a correct retained conflict rather than a reconcile that never ran.

Five items closed and three carried into v0.93.0: the filesystem namespace remains `/api/files`, the desktop liveness probe still lacks a mechanism for its stale-socket false positive, and the Linux desktop still refuses WebGL by default.

### v0.90.0

Shipped 2026-08-14; see [release-v0.90.0](../release/release-v0.90.0.md). Closed items in [`done/`](done/):

- [windows-team-work-terminals-can-deadlock-on-a-startup-dsr](done/windows-team-work-terminals-can-deadlock-on-a-startup-dsr.md) - reproduced deterministically on real Windows 11 with the mechanism corrected: the `\x1b[6n` is ConPTY's own startup handshake gating every server-spawned Windows shell, not a pwsh prompt racing the SPA's reattach cursor; the library answers it on the controller's 25 ms tick after a grace an attached frontend's own report wins, the natural-exit tests are un-gated on the Windows arm, and the no-double-CPR acceptance is verified live against a frontend-silent control.
- [the-standalone-windows-cli-ships-untested](done/the-standalone-windows-cli-ships-untested.md) - chan.exe is executed by CI for the first time: a smoke on the Windows arm drives `--version`, the `DETACHED_PROCESS` daemon spawn, and named-pipe discovery plus an Identify round trip through `chan ps`, proven able to fail against a known-broken binary.
- [a-held-lock-hides-its-own-holder-record-on-windows](done/a-held-lock-hides-its-own-holder-record-on-windows.md) - the holder record is readable while the lock is held via a `writer.json` sidecar the body-first read order keeps honest, restoring `chan ps`/`chan close` holder resolution and the same-process idempotent reopen on Windows; found and fixed in the round that wrote the smoke, then amended at intake so a crash leftover can neither shadow a live holder nor authorize a steal.

Three items closed and four carried into v0.91.0: the external-edit stale read still deferred on its precondition, the WebGL present stall reframed and untouched, the frame-rate acceptance guards with no code shipped, and AUR publication still blocked upstream, re-checked unmet on 2026-08-14. The era's fixes without items entered from live use: the AppImage terminal environment reconstruction, the reverse tunnel surviving fd-pressure accept errors, and the darwin transient openpty retry. Writing the CLI smoke surfaced two defects its item had not predicted, the held-lock record and the debug-profile stack overflow, both fixed in the same round; the branch's intake review then caught the sidecar repair's own crash-leftover hole before it merged.

### v0.89.0

Shipped 2026-08-12; see [release-v0.89.0](../release/release-v0.89.0.md). Closed items in [`done/`](done/):

- [the-deck-chords-are-invisible-to-the-shortcut-registry](done/the-deck-chords-are-invisible-to-the-shortcut-registry.md) - the deck's present and preview chords become registry commands, rebindable while the shipped defaults stay, and the capture handler is gated on `builtInChordSuperseded` rather than widened to match by resolved chord.
- [assigning-an-already-held-chord-has-no-swap-path](done/assigning-an-already-held-chord-has-no-swap-path.md) - the assign dialog offers to swap a held chord, and the close review then narrowed the offer to a single-holder candidate whose holder dispatches through the override layer, after it was found to ship a fresh collision otherwise.
- [the-graph-palette-has-never-been-configurable](done/the-graph-palette-has-never-been-configurable.md) - the graph node hues are settable per colour scheme across SPA, Rust and CLI, the override rides the graph subtree rather than the document root, and a hand-edited invalid hue is dropped rather than poisoning the write.
- [settings-is-organised-by-concern-not-by-app](done/settings-is-organised-by-concern-not-by-app.md) - the overlay derives its sections from the command registry's own surface grouping, so each app's controls sit together, rebuilt on shared settings-field primitives.
- [ctrl-shift-w-closes-the-window-not-the-tab](done/ctrl-shift-w-closes-the-window-not-the-tab.md) - off macOS the chord closes the tab through the same `app.tab.close` path every window kind takes, window close moves to `Ctrl+Alt+W`, and an AltGr keydown falls through the key bridge so international character entry is not swallowed.
- [agy-submit-agent](done/agy-submit-agent.md) - Google Antigravity's `agy` CLI is a first-class submit agent across Rust and the Team Work TypeScript mirror, live-probed with a bracketed-paste-plus-CR chord; gemini stays supported and is marked for a later deprecation.
- [canonicalize-failure-has-four-answers-on-the-path-sandbox](done/canonicalize-failure-has-four-answers-on-the-path-sandbox.md) - the path sandbox fails closed on an uncanonicalizable path, the four inconsistent answers become one, and the symlink-blind lexical fallback is consolidated behind one method whose root comes from the walker; the server half stayed open after the headline repair and was closed after reading the acceptance against the tree.
- [a-failed-reset-wedges-the-workspace-behind-a-retryable-error](done/a-failed-reset-wedges-the-workspace-behind-a-retryable-error.md) - the workspace cell is restored on every fallible reset arm, so a failed reset leaves the previous workspace reachable rather than answering a permanent state as a retryable 503 forever; reproduced in-process against the unrepaired flow before any code changed.
- [chan-home-collapses-to-the-working-directory](done/chan-home-collapses-to-the-working-directory.md) - an absent OS home resolves to a named absolute path through a test seam rather than a relative one, so a process whose home does not resolve no longer writes the registry and every workspace's metadata into its working directory.
- [chan-home-is-mutated-process-globally-during-a-parallel-suite](done/chan-home-is-mutated-process-globally-during-a-parallel-suite.md) - the three named windows where tests mutated `CHAN_HOME` process-globally are closed, and an isolated library opened at an injected config path no longer sends its metadata to the ambient home.
- [watch-registration-lifecycle-test-is-load-sensitive](done/watch-registration-lifecycle-test-is-load-sensitive.md) - the process-global injection slot four tests clobbered is now a path-keyed map, and the two ignored-subtree tests inspect their own counter before accepting `Healthy`, making the registration claim positive rather than vacuous; measured 14/20 and 19/20 red before, 0/20 after, on the checked-in 1-CPU rig.
- [the-1-cpu-reproduction-rig-has-no-checked-in-form](done/the-1-cpu-reproduction-rig-has-no-checked-in-form.md) - the load-sensitive-failure reproducer every timing item had rebuilt from prose gets a checked-in form that fails closed when it cannot confirm the CPU cap from the host, reproduced cold by a second operator who had never built it.
- [indexer-timing-sites-have-no-lexical-signature](done/indexer-timing-sites-have-no-lexical-signature.md) - the three timing sites a shipped classification kept were reopened, examined, and kept on an evidence-led ruling, a conforming outcome recorded as such rather than as a failure to change anything; that half of the commit is comments only.
- [the-sdme-build-drivers-are-uncapped-and-mount-a-live-worktree](done/the-sdme-build-drivers-are-uncapped-and-mount-a-live-worktree.md) - the sdme build drivers are capped and stopped mounting the live worktree, merged from three drafts into one lane, with the storage half widened by ruling into a standing rule that every sdme container this repository creates uses the btrfs backend.
- [release-artifacts-are-labelled-gnu-and-contain-musl](done/release-artifacts-are-labelled-gnu-and-contain-musl.md) - the two sites that named the wrong libc on the Linux CLI artifacts are corrected, so a musl binary is no longer labelled gnu.

Fifteen items closed and four carried into v0.90.0: the external-edit stale read still deferred on its precondition, the WebGL present stall reframed after measurement, the frame-rate acceptance guard with no code yet, and AUR publication still blocked upstream. The round also produced a fable/ultracode close review that caught three defects the round itself introduced before they shipped (the chord-swap collision, the metadata-import 500, and the graph-palette silent write failure), and a Windows CI investigation that scoped the arm to chan-library and chan-desktop and surfaced two follow-ups now promoted into v0.90.0: a candidate ConPTY startup-DSR deadlock and the untested standalone Windows CLI.

### v0.88.0

Shipped 2026-08-10; see [release-v0.88.0](../release/release-v0.88.0.md). Closed items in [`done/`](done/):

- [browser-smoke-is-unrunnable-and-rate-based](done/browser-smoke-is-unrunnable-and-rate-based.md) - the suite runs from a clean project container through `make browser-smoke-deps` and 23 network-idle waits across 19 checks wait on the property each check consumes, so the editor is exercised in a browser at all; four of five acceptance lines met, the fifth reported unmet rather than rounded up, because `56-external-edit-matrix` reached nine of ten runs and was stopped by two defects this work uncovered.
- [chan-ps-cannot-answer-what-a-workspace-is-doing](done/chan-ps-cannot-answer-what-a-workspace-is-doing.md) - readiness, generation, required action, indexer status and queue depth are surfaced from the same values `/api/health` and `/api/index/status` already served, so the command cannot report a different truth than they do and a diagnosis that took a shell, two tokens and hand-read JSON is a five-second read; one acceptance line is only partly met because the stall it was to be demonstrated against is unreachable at this commit.
- [the-boot-overlay-locks-the-workspace-behind-its-own-index-rebuild](done/the-boot-overlay-locks-the-workspace-behind-its-own-index-rebuild.md) - a recovery or index pass that is progressing reports itself instead of locking the workspace, with `locked: false` under `readiness.state: recovering` in 80 of 80 samples on a 25,000-file workspace and content search saying it is paused rather than returning an empty result set; structurally correct and merged green but not validated by experiment, because the rig built for it does not reach the defect.
- [desktop-build-id-is-unknown-in-the-nix-package](done/desktop-build-id-is-unknown-in-the-nix-package.md) - the flake threads its guarded build id into both surfaces the package ships, `chan-desktop` itself and the `chan` binary symlinked at `bin/chan`, `chan-desktop --version` makes the app's own id readable without a display, and the assertion lives in the package smoke rather than in one eyeballed run.
- [release-dry-run-does-not-predict-the-tagged-run](done/release-dry-run-does-not-predict-the-tagged-run.md) - `DMG_VENV` and `TAURI_CLI_ROOT` move out of the cached `target/` tree into `.build-tools/`, so a step's behaviour can no longer depend on what a cache handed it, closing the class behind the v0.87.0 tag failing a job its dry run had passed on the identical tree; the audit also falsified the item's own premise, and the DMG path needs macOS so it is first exercised by the next dry run.
- [devserver-restart-destroys-the-tunnel-registration](done/devserver-restart-destroys-the-tunnel-registration.md) - the endpoint requirement no longer fires ahead of the code that recovers the endpoint from the installed unit, so `--restart` stops refusing a shell that holds the token and stops silently rewriting a tunnelled service as a local one, which destroyed the only copy of the PAT; exercised in both directions against a live supervised unit.
- [terminal-font-and-block-glyph-parity](done/terminal-font-and-block-glyph-parity.md) - **partial**: the bundled `@font-face` src is no longer absolute so the face decodes under a tenant slug instead of hiding behind a lookalike system font, and ghostty draws block elements from cell geometry; the xterm DOM renderer the Linux desktop ships still bands rules and blocks at 96.0% rule continuity and 95.2% block coverage, independently reproduced on a second machine, and the WebGL present stall that keeps that renderer in place stayed unmeasured for want of a GPU host with an Xorg session, so both residuals carry forward.
- [canvas-animations-are-software-rasterized-on-linux](done/canvas-animations-are-software-rasterized-on-linux.md) - the whole animation family, point cloud host included, paints through WebGL2 rather than the 2D canvas paths Linux software-rasterizes, and frames allocate nothing; closed on the owner's observation of the named animations running correctly on real Linux, Windows and macOS hardware, which is an observation and not a frame-rate measurement.
- [terminal-restart-env-test-is-load-sensitive](done/terminal-restart-env-test-is-load-sensitive.md) - one harness defect explains all three clustered tests: `collect_until` drained only `handle.rx` and never `handle.replay`, so the collector was missing half a contract production honours, with 5 of 8 cluster-red before the repair and 0 of 13 after under condition-matched arms on a calibrated cgroup rig.
- [control-socket-takeover-test-races-a-fixed-sleep](done/control-socket-takeover-test-races-a-fixed-sleep.md) - the fixed 25ms sleep is removed rather than lengthened and the holder's release is observable through a test seam, reproduced at 3 red in 30 runs under a 1-CPU rig and 0 in 30 after, with the repaired assertion proven able to go red.
- [doc-sessions-tests-stage-external-edits-on-the-filesystem-clock](done/doc-sessions-tests-stage-external-edits-on-the-filesystem-clock.md) - the hand-rolled 20ms sleep is gone and fourteen staging sites route through the settled `scene_sessions` construction, repaired as a structural hazard on the strength of the sleep and the precedent; the item states that no `doc_sessions` test was ever observed failing from the mtime collision in 60 rig runs, which is what it predicted of itself.
- [audit-the-workarounds-nobody-followed-up](done/audit-the-workarounds-nobody-followed-up.md) - 53 sites marked across `crates/chan-workspace/src/` with the sites found clean recorded alongside the rest so the pass carries a denominator, the fail-open specimen repaired, seven findings recorded and eight candidates registered; complete over the time-shaped signature population it declared and explicitly not over the fallback-on-failure axis those signatures cannot see.
- [one-stalled-workspace-may-block-the-others](done/one-stalled-workspace-may-block-the-others.md) - the unverified lead was falsified rather than built against: closes do not serialize, do not exhaust the runtime and are bounded, so no code changed, and the observation remains unexplained with two candidate mechanisms ruled out and a third named and uninvestigated.

Nothing reached this release without an item, but three of the thirteen were done unplanned and off the roadmap and registered after the fact so the release carries them as accepted scope rather than as unattributed lines: the canvas animation family, the `chan devserver --restart` tunnel-registration repair, and the terminal face and block glyph work. The release's other result has no item here at all, because it is a defect rather than a delivery: the browser smokes, runnable for the first time, found an intermittent stale read on the editor's external-edit convergence path on their first properly runnable execution, carried forward with a preserved reproducer rather than repaired here as [an-external-edit-intermittently-never-reaches-a-dirty-editor](done/an-external-edit-intermittently-never-reaches-a-dirty-editor.md); the v0.87.0 mtime CAS is not implicated and nothing is silently lost. Of the fourteen items in scope, thirteen shipped and one deferred: [aur-publication-is-suspended](done/aur-publication-is-suspended.md), still blocked upstream. The partial terminal item's residual carries forward as [the-webgl-present-stall-is-unmeasured-and-costs-linux-the-grid](done/the-webgl-present-stall-is-unmeasured-and-costs-linux-the-grid.md), and what the canvas item exposed about writing a frame-rate acceptance that a software stack can satisfy carries forward as [a-frame-rate-acceptance-needs-guards-that-can-fire](done/a-frame-rate-acceptance-needs-guards-that-can-fire.md). The seventeen drafts the round also produced were triaged on 2026-08-11 and their disposition is recorded in the v0.89.0 release report.

### v0.87.0

Shipped 2026-08-09; see [release-v0.87.0](../release/release-v0.87.0.md). Closed items in [`done/`](done/):

- [mtime-cas-silently-overwrites-external-edits](done/mtime-cas-silently-overwrites-external-edits.md) - the write CAS verifies the bytes the caller last saw instead of trusting a timestamp that does not always advance, closing a silent-overwrite data-loss path, with four limitations named.
- [scene-conflict-test-is-load-sensitive](done/scene-conflict-test-is-load-sensitive.md) - the mechanism named and demonstrated; the item was filed as a test defect and exposed the production data-loss path above.
- [gitignore-write-strands-the-workspace-in-recovering](done/gitignore-write-strands-the-workspace-in-recovering.md) - a watcher-requested reconcile has a driver, so a `.gitignore` write stops parking the workspace behind a boot overlay no worker would ever clear.
- [desktop-authorize-strands-the-browser-off-origin](done/desktop-authorize-strands-the-browser-off-origin.md) - the authorized browser lands on the gateway profile page instead of a dead-end loopback page, with the listener's neutrality invariant intact.
- [devserver-build-identity](done/devserver-build-identity.md) - `chan --version` and the health surface carry a build id, the server-side sibling of the desktop identity from v0.86.0.
- [submit-cannot-override-a-wrong-derivation](done/submit-cannot-override-a-wrong-derivation.md) - the agent named in `cs terminal write --submit` selects the chord, so an agent started by hand inside a shell session is reachable at all.
- [tab-commands-are-launcher-search-only](done/tab-commands-are-launcher-search-only.md) - a chosen launcher scope lists completely, the focused application's commands lead its Tab scope, and four unreachable actions are commands again.
- [window-list-is-verb-first](done/window-list-is-verb-first.md) - one Windows branch replaces the Focus/Hide/Show/Close quartet, listing each window once with the actions it can actually take.
- [load-sensitive-tests-keep-recurring-after-three-sweeps](done/load-sensitive-tests-keep-recurring-after-three-sweeps.md) - **partial**: all 49 chan-server timing sites classified with per-site justification, verified by set comparison; the repairs the same item asks for did not ship and the item says so.

The release also carried the WebKitGTK flip-face fix, which had no roadmap item: WebKitGTK ignores `backface-visibility` while Chrome honours it, so a hidden card face covered the entire window in the shipped app while every Chrome-driven check passed. Ten items were deferred to v0.88.0 above, none of them started.

### v0.86.0

Shipped 2026-08-08; see [release-v0.86.0](../release/release-v0.86.0.md). Closed items in [`done/`](done/):

- [extensions-unreachable-through-the-gateway](done/extensions-unreachable-through-the-gateway.md) - the gateway admits the exact extension capability path shape, so cookieless sandboxed-iframe fetches reach the devserver whose per-process capability check authorizes them; extensions boot through the gateway for the first time.
- [extension-errors-are-cors-masked](done/extension-errors-are-cors-masked.md) - every response leaving the extension namespace on both binaries carries the response policy, and the capability segment is redacted from both binaries' trace spans.
- [extension-capability-staleness-across-restart](done/extension-capability-staleness-across-restart.md) - extension tabs converge after a devserver restart via catalog re-resolution and frame reconciliation, proven live in a headless browser with the fix withheld and restored.
- [cs-terminal-new-cannot-spawn-an-agent-session](done/cs-terminal-new-cannot-spawn-an-agent-session.md) - cs terminal new and restart carry --command and --env on shared plumbing, so a single terminal derives an agent and a live shell tab can be repaired.
- [gateway-window-skew-presents-as-a-code-defect](done/gateway-window-skew-presents-as-a-code-defect.md) - a chan-desktop build is identifiable at runtime and advertises its native vocabulary to remotely-served pages.
- [editor-widget-tests-are-nondeterministic](done/editor-widget-tests-are-nondeterministic.md) - the fold walker refreshes on tree identity, closing a production staleness path behind three flaky tests, now deterministic.
- [large-transfer-ceiling-refinements](done/large-transfer-ceiling-refinements.md) - archives bounded by the ceiling on both arms with refuse-before-first-byte semantics; the Range and recovery gaps closed by ruling.
- [source-pins-bound-on-sibling-string-literals](done/source-pins-bound-on-sibling-string-literals.md) - all 24 dead end-bounds on unique definition-form needles, with a committed mutation probe.
- [gateway-tests-do-not-run-off-main](done/gateway-tests-do-not-run-off-main.md) - the gate executes the database-free gateway suites and states execute versus compile per step.
- [web-lock-check-destroys-node-modules](done/web-lock-check-destroys-node-modules.md) - environment-fixed with an npm >= 10 floor; the destructive premise was falsified in re-verification.

The release also carried the owner's team-config pane layout, the empty-pane mark flash, and two cross-branch composition fixups. The web-marketing-onboarding item was withdrawn to the chan-mkt repository during preparation ([done/web-marketing-onboarding.md](done/web-marketing-onboarding.md)), and aur-publication-is-suspended deferred to v0.87.0 still blocked upstream.

### v0.85.0

Shipped 2026-08-06; see [release-v0.85.0](../release/release-v0.85.0.md). Closed items in [`done/`](done/):

- [large-transfer-capability](done/large-transfer-capability.md) - the 50 MiB compiled-in write limit replaced by a configuration ceiling, with every transfer path on a process-wide admission lane and a queue bound that refuses before reading a body.
- [desktop-library-window-open-unavailable](done/desktop-library-window-open-unavailable.md) - chan-desktop opens and focuses library windows through capability-gated native commands, resolving the target library from the invoking window's own label.
- [standalone-terminal-appearance-settings](done/standalone-terminal-appearance-settings.md) - standalone terminals fetch preferences and receive live changes, so the full terminal preference set applies rather than only defaults.
- [hybrid-nav-mouse-split-affordances](done/hybrid-nav-mouse-split-affordances.md) - dragging a pane onto an edge zone previews and stages a 50/50 split, refusing an edge whose result would fall below the minimum pane size.
- [file-browser-context-menu-inspector-actions](done/file-browser-context-menu-inspector-actions.md) - one capability-driven classifier behind both surfaces, so they cannot drift apart by construction.
- [ghostty-live-output-scroll-stability](done/ghostty-live-output-scroll-stability.md) - ghostty writes and pixel-wheel input route through one viewport controller, with anchored output preserving its position.
- [ghostty-macos-trackpad-scroll-parity](done/ghostty-macos-trackpad-scroll-parity.md) - synchronous primary-screen trackpad scrolling with the xterm parity factor, pinned by test and calibrated by the owner.
- [settings-checked-checkbox-pill-border](done/settings-checked-checkbox-pill-border.md) - selected checkbox and radio pills keep the neutral border and are distinguished by background alone.
- [cs-terminal-list-queue-depth](done/cs-terminal-list-queue-depth.md) - a queue column reporting messages still waiting, with an unreported value rendering as `-` rather than `0`.
- [chan-config-key-coverage](done/chan-config-key-coverage.md) - the reader, writer, and dump derive from one key set, so a serialized field cannot reach the dump without reaching `get` and `set`.

The release also carried the ghostty overlay scrollbar correction and the withheld-native-command message, neither of which had its own roadmap item: the first entered as an owner acceptance finding and the second from diagnosing one. The gateway acceptance failure that reopened the round was version skew rather than a defect, and is registered forward as [gateway-window-skew-presents-as-a-code-defect](done/gateway-window-skew-presents-as-a-code-defect.md), which shipped in v0.86.0.

### v0.84.1

Shipped 2026-08-05; see [release-v0.84.1](../release/release-v0.84.1.md). Closed items in [`done/`](done/):

- [graph-large-workspace-render-cost](done/graph-large-workspace-render-cost.md) - a selection click no longer re-heats the layout and a settled graph paints nothing, with the selection-derived paint inputs memoised and the viewport culled.

The release also carried five fixes that entered from live use without their own roadmap items: live-only BM25 path enumeration, a pane split surviving a mid-teardown layout read, terminal chrome following a custom background, a devserver join detaching on non-TTY stdin EOF, and an honest chan-desktop window-open message with its refusal diagnostics. The desktop library-window repair behind that last one was deferred to v0.85.0 as [desktop-library-window-open-unavailable](done/desktop-library-window-open-unavailable.md).

### v0.84.0

Shipped 2026-08-05; see [release-v0.84.0](../release/release-v0.84.0.md). Closed items in [`done/`](done/):

- [cs-open-non-text-reveal-and-audio](done/cs-open-non-text-reveal-and-audio.md) - `cs open` reveals existing non-text files in the File Browser, and supported audio files gain inline and dedicated native players.
- [hybrid-nav-staged-editor-bubble](done/hybrid-nav-staged-editor-bubble.md) - queued draft and diagram intents render as removable chips, while shared structural layout changes make the transaction stale and fail closed.
- [terminal-tab-rename-reaches-inventory](done/terminal-tab-rename-reaches-inventory.md) - terminal name and group settle on the server and converge through the tab strip, session inventory, roster, selectors, and fdstore provenance.
- [terminal-editor-appearance-settings](done/terminal-editor-appearance-settings.md) - terminal font size and colours persist through server configuration, while editor font size persists in user preferences and updates live.
- [release-platform-verification](done/release-platform-verification.md) - a disposable Ubuntu sdme guest provides the mandatory Windows release cross-check alongside the macOS-capable workflow dry run.
- [graph-inspector-language-node-detail](done/graph-inspector-language-node-detail.md) - language nodes show delivery estimates and ranked directory detail, with direct navigation into a selected directory scope.
- [tests-inherit-ambient-chan-env](done/tests-inherit-ambient-chan-env.md) - tests clear ambient `CHAN_*` state, use isolated homes, and avoid rendering inherited credentials in failures.
- [rich-prompt-submit-button](done/rich-prompt-submit-button.md) - the Rich Prompt hint is a control strip whose primary action switches between submit and cancel while retaining the existing keymap behavior.
- [terminal-secret-masking-default-off](done/terminal-secret-masking-default-off.md) - secret masking defaults off for usable large scrollback replay, while explicit configuration and the existing ephemeral per-tab switch remain available.
- [sdme-ubuntu-nix-build](done/sdme-ubuntu-nix-build.md) - Nix evaluation, package builds, and smokes run from a tracked-source snapshot in a disposable Ubuntu guest rather than the host filesystem.
- [hybrid-nav-staged-destructive-actions](done/hybrid-nav-staged-destructive-actions.md) - withdrawn before implementation; destructive actions keep the established immediate action and confirmation flow.

### v0.83.4

Shipped 2026-08-04; see [release-v0.83.4](../release/release-v0.83.4.md). Closed items in [`done/`](done/):

- [gateway-served-surface-failures](done/gateway-served-surface-failures.md) - desktop windows served through the gateway read the CSRF token from an origin-scoped Tauri command instead of a cookie WebKit never exposes to JavaScript, and session re-mints publish fresh cookies into open windows, so every mutating surface works again.
- [desktop-window-outage-lifecycle](done/desktop-window-outage-lifecycle.md) - a close during a remote outage settles as closed instead of boomeranging, the connecting probe classifies responses instead of accepting any status, and the close prompt raises its own window instead of stranding behind newer ones.
- [terminal-reattach-replay-storm](done/terminal-reattach-replay-storm.md) - the reattach replay was one full-ring stream paying a per-chunk masker scan; replay writes now batch behind a single whole-buffer scan, taking a 2.1 MiB reattach from over 180 s to 2.8 s.
- [v0.83.4-bug-fixes](done/v0.83.4-bug-fixes.md) - the Rich Prompt recovers from a failed draft create with a visible error and retry, and keyboard paste is no longer suppressed on the Ghostty backend.

### v0.83.3

Shipped 2026-08-03; see [release-v0.83.3](../release/release-v0.83.3.md). Closed items in [`done/`](done/):

- [timing-test-virtual-clock](done/timing-test-virtual-clock.md) - the shutdown-grace test runs on tokio's paused clock and the indexer recovery waits ride one 30 s convergence budget, so a contended host cannot fail the gate.

### v0.83.0

Shipped 2026-08-03; see [release-v0.83.0](../release/release-v0.83.0.md). Closed items in [`done/`](done/):

- [unified-command-launcher](done/unified-command-launcher.md) - one searchable command deck rendered inline by the SPA that owns the focused window, with authority following the rendering SPA and no Tauri overlay window.
- [extensions-v1](done/extensions-v1.md) - TOML-declared extensions run as supervised subprocesses behind an iframe tab, with host capabilities and declared commands.
- [gateway-security-review](done/gateway-security-review.md) - entry-path failures made registry-independent, the identity SPA policy corrected to admit the provider avatar it renders, and strict audit-IP parsing.
- [terminal-secret-masking](done/terminal-secret-masking.md) - secret-shaped values masked in the terminal, with a malformed suffix no longer able to overwrite the user's server.toml.
- [kimi-submit-agent](done/kimi-submit-agent.md) - Kimi as a named submit agent with its own measured chord, command derivation, batching, and SPA mirror.
- [team-spawn-poke-tui-readiness](done/team-spawn-poke-tui-readiness.md) - the identity poke gates on DECSET 2004 with a bounded, named failure instead of a fixed grace.
- [cs-tunnel-single-port-shorthand](done/cs-tunnel-single-port-shorthand.md) - `cs tunnel <port>` as shorthand for `<port>:<port>`.

### v0.82.0

Shipped 2026-08-01; see [release-v0.82.0](../release/release-v0.82.0.md). Closed items in [`done/`](done/):

- [whole-file-read-elimination](done/whole-file-read-elimination.md) - every HTTP read path bounded, the indexer off the workspace lock, and range support on downloads.
- [cs-tunnel-eof-truncation](done/cs-tunnel-eof-truncation.md) - forwarded connections drain already-read bytes before closing; the item's size-threshold model was disproved by measurement.
- [parallel-suite-flake-hygiene](done/parallel-suite-flake-hygiene.md) - a poisoned lock no longer aborts the process, and the gateway idle assertion is anchored rather than padded.
- [retire-devserver-windows-endpoint](done/retire-devserver-windows-endpoint.md) - the legacy window adapter, route, wire type, and its tests are gone.
- [terminal-backend-visibility](done/terminal-backend-visibility.md) - terminals export their engine, the context menu names the live renderer, and the launcher toggles it.

### v0.80.0

Shipped 2026-07-29; see [release-v0.80.0](../release/release-v0.80.0.md). Closed items in [`done/`](done/):

- [chan-desktop-reverse-tunnel](done/chan-desktop-reverse-tunnel.md) - delivered in part: `cs tunnel` forwards TCP from the connected desktop to the devserver over direct and gateway paths with owner gating and foreground-lifetime teardown; UDP remains an explicit refusal and the broader desktop-window-command request did not ship as part of this item.
- [terminal-submit-suffix](done/terminal-submit-suffix.md) - every non-empty agent submit carries exactly one trailing newline ahead of its server-owned chord, raw writes remain byte-identical, and all logical writes refuse above 4,096 UTF-8 bytes.
- [video-preview-and-range-serving](done/video-preview-and-range-serving.md) - MP4/WebM/MOV inline and fullscreen video preview backed by bounded single-range HTTP serving; MP3 has range/content-type support while audio UI, mixed-media viewer navigation, and resumable downloads remain follow-ups.

### v0.79.0

Shipped 2026-07-26; see [release-v0.79.0](../release/release-v0.79.0.md). Closed items in [`done/`](done/):

- [gw-ctrl-plane](done/gw-ctrl-plane.md) - the gateway is administrable as a product boundary without database access: explicit user access states, a durable per-user connected-devserver limit across the proxy fleet, session and tunnel inspection and revocation, an idempotent admin API for an external account service, and account credentials separated from database roles.
- [desktop-launcher-only-menubar](done/desktop-launcher-only-menubar.md) - off macOS only the Chan Launcher window carries a native menubar; the chords the retired per-window-kind bars owned move into the per-window key bridge, and macOS routing is unchanged.
- [ghostty-terminal-backend](done/ghostty-terminal-backend.md) - ghostty-web available as an opt-in terminal backend behind `terminal.ghostty`, default off and never the default.
- [tab-rotation-across-sides](done/tab-rotation-across-sides.md) - next and previous rotate a pane's whole tab set across both Hybrid sides, and the close shortcut on an empty visible side flips to the populated side rather than only flashing the toggle.
- [wall-clock-test-flakiness](done/wall-clock-test-flakiness.md) - the self-write tests take a caller-supplied instant instead of reading the wall clock, browser check 62 asserts a load-monotone structural cap instead of a rate ceiling, and check 60 skips on an absent precondition instead of failing.

### v0.78.0

Shipped 2026-07-26; see [release-v0.78.0](../release/release-v0.78.0.md). Closed items in [`done/`](done/):

- [editor-filesystem-edit-convergence](done/editor-filesystem-edit-convergence.md) - disk-echo ring entries carry an origin, so read bytes no longer inherit the 60s protection meant for written bytes; an external restore reaches the editor in 28ms rather than 58.6s and a truncation in 407ms rather than not at all. Closes the root cause the v0.76.0 fix had only bounded.
- [desktop-linux-clipboard-and-supervisor-entry](done/desktop-linux-clipboard-and-supervisor-entry.md) - native clipboard operations run off the Tauri invoke thread, Linux holds one process-wide clipboard handle so a copy outlives the operation, and the systemd/launchd writers select a `chan`-named entry point instead of persisting the desktop binary.

### v0.77.0

Shipped 2026-07-25; see [release-v0.77.0](../release/release-v0.77.0.md). Closed items in [`done/`](done/):

- [wave3-review-deferred-lows](done/wave3-review-deferred-lows.md) - six LOW findings closed: recovery sidecars off push acknowledgements, resolved recovery collapse, typed systemd desired units plus inherited-AppImage trust, window-owned generated-download cleanup and stale reaping, the documented and pinned client-cooperative 64 KiB chunk contract, and escaped-literal gitignore pruning.

### v0.76.0

Shipped 2026-07-25; see [release-v0.76.0](../release/release-v0.76.0.md). Closed items in [`done/`](done/):

- [devserver-rebuild-storm-and-livelock](done/devserver-rebuild-storm-and-livelock.md) - the rebuild-storm class closed: one `IndexScopePolicy` across walk/index/watch/report, the rebuild generation coordinator, `.gitignore` honoring, and the storm harness green including overflow injection and post-restart convergence.
- [workspace-open-reconcile-off-mount-path](done/workspace-open-reconcile-off-mount-path.md) - `Workspace::open`'s reconcile moved onto a supervised, cancellable recovery worker off the mount path.
- [gitignore-aware-exclusions](done/gitignore-aware-exclusions.md) - `.gitignore` (nested, anchored, negation) honored as the base scope layer beneath `index_excluded_dirs`.
- [devserver-startup-journal-branch-rework](done/devserver-startup-journal-branch-rework.md) - reworked as the devserver startup state machine: `starting` rows before spawn, persisted intent + generation, supervised restore, fdstore ahead of serving terminals, no premature READY.
- [editor-external-restore-echo-swallow](done/editor-external-restore-echo-swallow.md) - the echo ring re-checks after its TTL instead of clearing the observation; browser smoke check 57 ungated.
- [upload-download-budgets](done/upload-download-budgets.md) - bounded streaming transfers (server byte stream, terminal download, desktop native) and bounded 2-download/1-upload concurrency.

### v0.75.0

Shipped 2026-07-24; see [release-v0.75.0](../release/release-v0.75.0.md). Closed items in [`done/`](done/):

- [loopback-redirect-desktop-signin](done/loopback-redirect-desktop-signin.md) - RFC 8252 loopback redirect + PKCE replaced the `chan://` scheme, fixing desktop sign-in on Linux and Windows.
- [windows-deeplink-second-instance](done/windows-deeplink-second-instance.md) - closed as subsumed: the `chan://` scheme and deep-link plugin were removed outright.
- [drop-self-built-desktop-packages](done/drop-self-built-desktop-packages.md) - the unmaintained self-built Tauri `.deb`/`.rpm` are gone; COPR/PPA/AUR is the desktop package channel.
- [terminal-mouse-toggle](done/terminal-mouse-toggle.md) - per-terminal `terminal.mouse_capture` toggle.
- [bug-reports](done/bug-reports.md) / [bug-fixes](done/bug-fixes.md) - the v0.75.0 editor/slides/devserver/terminal bug-fix round and its report bucket.
- [cleanups](done/cleanups.md) - survey `[F]` reduced to a pure will-follow-up signal; browser-smoke CHAN_HOME sandboxing.

### v0.74.0

Shipped 2026-07-22; see [release-v0.74.0](../release/release-v0.74.0.md). Closed items in [`done/`](done/):

- [distributed-proxy-control-plane](done/distributed-proxy-control-plane.md) - the gateway coordinates devserver-proxies through one authenticated control service, replacing uncoordinated singletons.
- [distributed-proxy-control-plane-hardening](done/distributed-proxy-control-plane-hardening.md) - the accepted security hardening (Ed25519 admission leases, opaque sessions, durable revocation) shipped with it.
- [distributed-proxy-control-plane-implementation-security-review](done/distributed-proxy-control-plane-implementation-security-review.md) - the independent adversarial re-review that cleared the hardening to merge.
- [open-routing-multiple-local-instances](done/open-routing-multiple-local-instances.md) - `chan open` routes deterministically when several local instances run.
- [terminal-submit-chord-authority](done/terminal-submit-chord-authority.md) - the server owns the submit chord and `cs terminal list` shows each session's derived agent.
- [control-terminal-wake-rerun](done/control-terminal-wake-rerun.md) - a macOS wake no longer re-runs the devserver connect script on the control terminal.
- [devserver-token-rotation](done/devserver-token-rotation.md) - the devserver bearer token rotates by verb and by age, and stays out of WebView snapshots.
- [markdown-heading-detection-in-fences](done/markdown-heading-detection-in-fences.md) - fold chevrons no longer appear beside `#` comments in fenced code; headings come from the syntax tree.
- [release-asset-verification-coverage](done/release-asset-verification-coverage.md) - the release-asset verifier single-sources the required list and requires the Windows artifacts.
- [aur-publish-verification-race](done/aur-publish-verification-race.md) - the AUR post-push RPC check is advisory, not a false red.
- [copr-build-provenance](done/copr-build-provenance.md) - a frozen-main window plus a publication-provenance probe for COPR.
- [aur-aarch64-publication-gate](done/aur-aarch64-publication-gate.md) - withdrawn: aarch64 AUR CI validation was removed rather than made a gate; the aarch64 PKGBUILD still ships.

### v0.73.0

Shipped 2026-07-20; see [release-v0.73.0](../release/release-v0.73.0.md). Closed items in [`done/`](done/):

- [launcher-flip-pane](done/launcher-flip-pane.md) - the Command Launcher's dead "Flip pane" row works; the overlay stack reconciles at close.
- [terminal-queue-drain-gemini-opencode](done/terminal-queue-drain-gemini-opencode.md) - OpenCode batches its queued terminal notifications; Gemini measured and deliberately kept a boundary.
- [packaging-aarch64-validation](done/packaging-aarch64-validation.md) - delivered in part: the COPR aarch64 evidence is harvested and the item's original premise retired; the AUR gating remainder carries forward.



### v0.72.0

Shipped 2026-07-20; see [release-v0.72.0](../release/release-v0.72.0.md). Closed items in [`done/`](done/):

- [terminal-write-queue-drain](done/terminal-write-queue-drain.md) - queued terminal notifications reconcile in one agent turn, with a reported queue depth.
- [hyperscale-support](done/hyperscale-support.md) - CentOS Stream COPR packaging for `chan` and `chan-desktop`.
- [aur-support](done/aur-support.md) - Arch AUR packaging for `chan` and `chan-desktop`.
- [dump-skill](done/dump-skill.md) - `chan dump-skill` prints an agent-facing manual of chan's whole surface.
- [packaged-desktop-upgrade-refusal](done/packaged-desktop-upgrade-refusal.md) - a distro-packaged build refuses self-upgrade in every personality.

### v0.71.0

Shipped 2026-07-19; see [release-v0.71.0](../release/release-v0.71.0.md). Closed items in [`done/`](done/):

- [terminal-gemini-opencode](done/terminal-gemini-opencode.md) - OpenCode as a first-class terminal agent.
- [tauri-permission](done/tauri-permission.md) - authenticated exact-origin desktop native trust.
- [chan-workspace-graph-fix](done/chan-workspace-graph-fix.md) - unified workspace search and graph traversal.
- [chan-upgrade-release-history-fix](done/chan-upgrade-release-history-fix.md) - `chan upgrade --version` resolves the last five GA releases.
- [cosmetics](done/cosmetics.md) - editor light-codeblock and dark-selection fixes.
- [release-flow](done/release-flow.md) - the team/roadmap + team/release process migration.

## See also

- [`../README.md`](../README.md) - how chan is developed: proposing, teaming, and shipping an item.
- [`../release/README.md`](../release/README.md) - the release history and its conventions.
- [`../../.agents/skills/release/SKILL.md`](../../.agents/skills/release/SKILL.md) - the executable release procedure.
- [`../../.agents/playbook.md`](../../.agents/playbook.md) - operational lessons distilled across the project.
