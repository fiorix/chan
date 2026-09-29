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

### v0.101.0

Opened 2026-09-20 to hold what was phased out of v0.100.0, and what that round raises for the version after it. The owner added ten the same day, with a ruling on each: one from an issue report, one from a defect the owner hit on v0.99.0, and eight from a re-read of the development archive's backlog. One item was accepted that day: the write queue's idle signal, which the owner asked for, had built and measured, and accepted with its build kept on a branch as the reference. On 2026-09-24 the owner decided the thirty-two items then raised for a decision: thirty accepted for v0.101.0 and two withdrawn, with each ruling recorded in its item. On 2026-09-25 the owner accepted all twenty-three items then neither landed, withdrawn nor being built, each as the lead recommended, and those rulings are recorded the same way. On 2026-09-26 the owner accepted the seven items the landing before had raised, with no deferral, and the lane and shape rulings the lead made under that word are recorded in each item. The same day the owner gave the four rulings the frontend review remainder waited on and closed the ring mirror's throughput cost as measured; one test-harness race from landing 15's CI is raised for a decision. Later that day the owner accepted the seven items then awaiting a decision, each as the lead recommended, with the shape and lane rulings recorded in their files. Five more, raised that day by reviews and reports of the work in hand, were accepted the same evening, each as the lead recommended, and a sixth found the same way landed with its fix. On 2026-09-27 eight items landed, among them a live terminal that keeps its renderer across a pane split, the desktop's close and quit beside a hung root, and one found and fixed while those were built, a save during shutdown that turned every other workspace off; the refusal envelope's first part landed too, with its item still open. The two items a review raised on 2026-09-26, the terminal tenant answering for a home workspace and a quit drain that can hang on a recovery pass, enter as accepted with the owner's rulings of that day, and three more found in that work are raised for a decision. Later on 2026-09-27 the owner ruled that every accepted item lands before the first candidate, with the comment pass, the low-severity rows of the frontend review remainder, the dedup seams and the CLI crate split last. Then three items landed: the terminal tenant answering for a home workspace, with the two narrower items it absorbed. The refusal envelope's second part landed too, the refusals a tenant's own handlers write, the devserver's own and the extension proxy's, with the owner's two rulings on it and its item still open, and two of the frontend review remainder's editor defects were fixed. One more item, a JSON tab attached to a document session skipping the save's parse check, is raised for a decision. The same day the owner decided the four items then raised for a decision, each as the lead recommended: a stopping devserver that refuses a mount before its host is asked and the JSON tab skipping the parse check are accepted for this version, the second with the shape of its fix still to be ruled, and the two that need a relinked root, a forget that waits on a hung root at each registry lookup and an off row that outlives a devserver restart, are accepted for a later version and move to v0.102.0. Two items raised that day were accepted for this version with the owner's rulings: the desktop taking Ctrl+] from a focused shell, which the owner met leaving a container session, and a quit that can still hang on a standalone Files window's watch, which the review of the quit drain found. The owner also ruled that a version's first release candidate is rc0. Then the quit drain that could hang on a recovery pass landed, with a quit's wait on each workspace's teardown now bounded; the refusal envelope's third part landed too, the launcher's shared refusal gates, with its item still open; and thirteen more of the frontend review remainder's defects were fixed, four in the editor and nine in the app shell, the panes and the file tree. The owner then ruled that the desktop frees Ctrl+Q on macOS as well; it joins the Ctrl+] item, and the wider keyboard rule on macOS stays open. Then the Linux gate's two items landed, two steps `make ci-linux` runs after `make pre-push`: the chan-library and chan-server suites under a symlinked temp directory, with five path assertions made exact, and a check of the Windows arm's test crates for the Windows target; and two more of the frontend review remainder's editor defects were fixed, the JSON tree's size and depth limits and the keyboard's return to the editor when the find bar closes. Main CI's first run of those two steps was red: both suites passed under the symlinked temp directory, but on a runner whose user is not root the step's cleanup could not remove two directories that tests had left without write permission, and the Windows-target check did not run. Then three items landed: the desktop leaving Ctrl+[, Ctrl+] and Ctrl+/ to a focused terminal, with the terminal sending 0x1F for Ctrl+/ on every client and Ctrl+Q left to the page on macOS; a stopping devserver refusing a mount before it registers the root; and a quit's wait on a standalone Files window's watch, now bounded. With them landed the fix for that red step, whose cleanup no longer decides its verdict, with the tests putting their modes back; the refusal envelope's fourth part, the launcher handlers' own refusals, after which no launcher route is exempt from the check, with the web clients' first readers of a refusal's code and the extension catalog's `running` field, its item still open; and five more of the frontend review remainder's defects, the style toolbar's four and a drawing's last stroke, with two older ways to lose a drawing found and still open. Ten items found in that work are raised for a decision: a close on the connecting page that discards a library window, the launcher's add and on skipping a stopping devserver's check, the startup gate's sentence while a devserver stops, the extension proxy forwarding to an exited extension's port, a race in two tests that capture warnings, the deck's Hide and Close on another host's window, two closes that still drop a drawing's last stroke, a rejected JSON body's refusal naming the request's Rust type, the gate's container running as root, and the terminal pruner's save under the chan home on a runtime worker. Main CI's run for that landing was green in all nine jobs, the first green run of the Linux gate's two steps on a runner: the suites under the symlinked temp directory passed in 2 minutes 56 seconds, with the cleanup leaving nothing behind, and the Windows-target check passed in 2 minutes 39 seconds. Then the refusal envelope's fifth part landed, the crate's own extractors, whose rejection answers the framework's status and sentence in the envelope, with the devserver's own handlers moved to them, and the CLI's two readers of a devserver's refusal, its item still open; and more of the frontend review remainder's defects were fixed: three in the editor's widgets, the shared deck's handling of a command that rejects, the launcher's dialog focus and its poll, and a drawing on disk becoming a scene nobody drew, which closes the two older ways to lose a drawing, with two more found by its review and still open. Three items found in that work are raised for a decision: a live drawing's scene snapshot that the drawing library's init wipes, a draft closed before its content arrives going to the trash, and a gate's refusal of a wrong method listing the route's methods. Then the refusal envelope's sixth part landed, the framework's own refusals in the workspace and terminal tenants and on the devserver's management routes: their extractors' rejections, the two draft-create routes among them after a fix round, and a wrong method's 405 answer in the envelope, with each gate still answering a wrong method before the 405, its item still open; and three more of the frontend review remainder's defects were fixed, in the file editor's hosts: a slide deck's Mod+Enter taken ahead of the rendered editor's own actions, the editor's body menu opened in the JSON tree and the CSV table, and a CSV cell only the mouse could edit. The texts of three items were brought up to this code: a gate's refusal listing the route's methods, which the landed code now pins, the JSON tab skipping the parse check, whose reading now covers what the server writes and when, and a scene snapshot wiped by the drawing library's init, with how its order is reached. Three items found in that work are raised for a decision: an MCP tool's read that takes a whole file before its size cap, an open with no time limit of its own holding a hung root's lock ahead of a close, and a live drawing written with no edit because its stored appState lacks the serializer's keys. Later on 2026-09-27 the owner accepted in one answer every recommendation the lead had put to them that day. Nine of the items then raised for a decision are accepted for this version: a close on the connecting page that discards a library window, the launcher's add and on skipping a stopping devserver's check, built with the startup gate's sentence while a devserver stops, the extension proxy forwarding to an exited extension's port, the race in two tests that capture warnings, two closes that still drop a drawing's last stroke, the gate's container running as root, a scene snapshot that the drawing library's init wipes, and a draft closed during its load going to the trash. Four are accepted for a later version and move to v0.102.0: the deck's Hide and Close on another host's window, a rejected JSON body naming the request's Rust type, the terminal pruner's save on a runtime worker, and a gate's refusal listing the route's methods. The same answer revised three rulings of items already accepted, each recorded in its item: a spawned child's hold on a lock ends with an unlock after the probe, a relinked root widens to one row per workspace, and a hung root's caller keeps its lock while the blocking call holds a permit of its own. The JSON tab's contract is rewritten to the owner's ruling, the save's check dropped for `.json` and kept for a drawing. In a second answer the same day, question by question, the owner accepted the three items then raised for a decision, the MCP read's bound as a stat before the read with the documents saying so, the open with no bound of its own and the live drawing's write with no edit, and a fourth raised and accepted at once, a drawing in source mode that loses its editor when its buffer does not parse; confirmed that on macOS the desktop leaves Ctrl+Q to the page and ruled nothing wider; and asked for a survey, in the next version, of how other MCP servers answer a read of a file over their cap. The AUR check's item, landed on 2026-09-26, is open again: two test dependencies added after it make the AUR package of `chan` install a binary that its test build wrote with a test-only feature, which its pin, reading only the recipes, did not see. In a third answer the owner accepted the lead's fix of it, in the AUR recipes, and two rulings on the launcher's browser windows that wait for their page. Then the cancellation of a started MCP tool landed: a cancelled request, or a close of its root, stops a running file listing or report scan at its next entry or file and a workspace search at its next seed, with a search's stop inside a seed and a whole file's read still open. Three more of the frontend review remainder's rows were fixed with it: a shortcut that could be Shift with a key alone, a cleared search box that a late answer filled again, and a recalled prompt that gave its text back before the server had answered, with a fault the lead's reading found in that fix mended before it landed. Three items found in that work are raised for a decision: a graceful restart of a raw devserver that may close desktop windows it should keep, a workspace search that stops between seeds and not inside one, and the `chan` crate exporting a module that only tests call. The development box ran out of memory on the night of 2026-09-27 and was rebooted, with no commit lost, so that landing and the next are dated 2026-09-28. That day the owner ruled that the launcher's browser windows that wait for their page and the workspace app's capability popup, whose two reviews had asked that they land with a fix round, land with that round's first order, and that its three other orders follow as ranges of their own. So the refusal envelope's client half landed its first part, its item still open: a window that the launcher or the workspace app's deck opens in a browser waits for its page before it navigates, and the shared deck shows a failed command's error on its card only while it is open on the draft that ran the command and the run still owns the card, and otherwise hands the error to its host once. What that leaves open on `main` is written in the item as costs: an Open that no longer repairs a window showing a refusal page or an engine's own error page, until the order on when a window is on its page lands; the mark of a navigation in flight, with no bound in time; two mechanisms that remember a navigation; a caller that takes another page's wait for a navigation; and a tab the user moved before the create answered. With them landed a drawing's board seeded only from the whole of a finished load, with a fix round for the appState a seed hands the board, which closes the two ways to lose a drawing that the review of the earlier fix had found; and the JSON tab's item, a `.json` file saved as typed in every window, while a drawing edited as source is still refused when it does not parse. Four items are raised for a decision: an element whose id repeats getting a new id at every seed, a drawing library that throws leaving a seeded board to publish an empty scene, a released command whose success paints over what the deck shows by then, and the AUR build of `chan` killed with its hosted runner in its release test compile. Later on 2026-09-28 five ranges landed together. A hung root's blocking calls landed, their item still open: the caller keeps its root's lock, and the blocking open with its root check, and a mounted root's revalidation, each hold a permit of their own for the root, so a root that stops answering holds one thread for each kind of call however many callers give up; a later open waits about two seconds at most for a permit that abandoned work holds, and an open of a mounted root beside a revalidation whose caller left returns the mount without a check. The registration and a close's and a removal's own hops still take a thread for each caller that gives up, and a caller that still waits on a call that never returns holds a close and a removal behind it, which is the item of an open with no bound. The AUR check's item landed again: both AUR recipes install the binary that `build()` set aside, the checker pins it, and a package built by each recipe showed by four hashes that the test build of `chan` writes another file and that the package installs the one `build()` made. The rule of when a browser window is on its page landed, its item still open with the rule's fix round to come: an Open, a Focus or a Show decides by the window's record and not by what the window shows, which closes the regression the landing before left on `main`, a browser's Show repairs before it un-hides, and the launcher keeps the row of a browser window it holds no handle for, as the owner ruled. The desktop's half of the refusal clients landed too: a new window waits out a loopback devserver's startup refusal, an open window waits for a restarting devserver in place, retargeted by its watcher alone, and the desktop's readers print a refusal's sentence, the workspace add through a gateway among them. And a probe of a workspace's lock now unlocks before it closes its file, which lands the item of a spawned child holding a lock until it execs. Twelve items found in that work are raised for a decision: the desktop's probe taking a gateway's 404 as ready, a window's record that says a socket is live and not whose, a browser's Show that opens a second window for a record a desktop owns, a kept browser terminal row that keeps its sessions alive, the shared confirm dialog focusing its confirm button, a failed save that replaces the editor with its error, whether a draft drawing that does not parse may be discarded from its own dialog, a close over the control socket that runs to its end whatever its client does, a close or a removal that answers before the workspace is let go, an open's result that nobody received blocking a runtime worker, a test that reads a row before the lock is released, and a lock probe whose own hold can refuse a concurrent acquire; and a second reading, a raw devserver killed and restarted, joins the item on its graceful restart. Then five more ranges landed the same day. An MCP tool's read of one file is bounded by its cap, which lands its item: `read_media` refuses a file over its cap from the size its open handle reports, having read none of it, and `read_file` reads at most its 256 KiB cap and takes the file's size from that stat; by the lead's ruling, which the owner has not answered, a text file over the cap whose bytes past it are not UTF-8 is answered with its text up to the cap, where it was refused. A relinked root's server half landed with its fix round, its item still open: the devserver's handoff and the launcher's window route and command action mint a workspace window at the root its runtime was opened at, and the devserver lists such a workspace once, under its registry row, with the record whose prefix the host serves, and answers its on route with that row. The devserver can still hold two records for one relinked workspace, a relinked root's public path can change across a restart, the desktop's half is not ordered yet, and one record per workspace, in the shape the lead ruled, the owner's to overrule, which changes the prefix of a workspace served through an alias of another name, is built and under review in the development tree and is not in this landing. A drawing edited as source whose text does not parse keeps its editor at a refused save and says that it was not saved, a close of it asks whether to keep editing, and the refused text takes no live session until a write of it lands, which lands its item, with four checks on a display owed at rc0. Three small fixes landed, each with its item: a scripted team passes each member's env, the extension proxy sends nothing to an extension whose supervisor saw it exit, and a capture of warnings in chan-library's tests sees a warning whose callsite another thread registered first. The rule of when a browser window is on its page got its fix round, the refusal envelope's item still open: a window's record is read again before the window is navigated, a browser's Show takes a window only for a record of a browser's origin, and a popup the browser blocks is reported; the mark of a navigation with no bound in time, the two mechanisms that remember a navigation and a caller that takes another page's wait for its own are left to the order on the wait, in hand. One item is raised for a decision: a close of a mounted root that awaits its teardown with no deadline. Then three more ranges landed the same day. An open of a root that stops answering gives the root back, which lands its item: the launcher's add and on and the desktop's embedded open each stop at the devserver mount's bound of sixty seconds, the launcher's counted from the request's start and the desktop's from its call, and answer that the root did not answer, the launcher with a 503 and no `Retry-After`, so a close and a removal of that root get through after them. By two rulings of the lead's, which the owner has not answered, a root that this process is still releasing is answered by the launcher's add and on with a 503, `Retry-After: 1` and the words its row reads, where they answered 400 and 500, while the desktop says the row's words and keeps its sentence about another chan process for another process's lock; and an add refused at the bound can still register its workspace once the root answers, which is written as a cost. A file whose name holds a backslash reads as itself, the Rust half, its item still open for the web app's copies of `basename` and `parentDir`: the item's premise is corrected, since on Unix the rewrite of `\` to `/` made such a file unreachable through every store derived from the walk rather than giving it two spellings, and one function now spells a relative path on every surface, which also closes three faults beside a real `a/b.md`. And the waiting windows' wait landed, the refusal envelope's item still open: a navigation's mark runs out, after sixty seconds for a wait and ten after a navigation, one function reads it, a caller that finds another page's wait follows it before it answers, a refused repair closes only a blank that its own gesture opened, a wait gives back the mark it replaced, and the launcher discards no window while an Open of it is pending; by the lead's ruling, which the owner has not answered, a user's own close of a window still discards its record. A tab its user moved before the create answered, a record the workspace app minted that no failure path discards, and the pins of the refusal readers are still to build. Five items found in that work are raised for a decision: one window's close discarding a record whose connection another window still holds, the desktop's `chan serve` handoff registering a path with no time limit, the launcher's add and on answering another process's lock with two statuses and two sentences, an upload that cuts a file's name at its backslash with the desktop refusing an upload into a directory whose name holds one, and the restart manifest's writer asking every workspace root's filesystem under the host's routing lock. Later on 2026-09-28 four ranges landed together. One devserver record per workspace landed with its fix round, the relinked root's item still open for the desktop's half: every devserver record is keyed by the root its registry row stores and served at the prefix derived from that root, whether the serve handoff, the open route or the on route made it, the launcher's add mounts at the same prefix, and a restore makes one record of the overlay rows that an earlier build or the host's close wrote under either of a workspace's keys, on when any of them is on, at their highest generation and at least 1, so a relinked root is one record at one prefix across restarts. By two rulings of the lead's, which the owner has not answered, a workspace served through an alias of another name is served at its registered prefix, and a workspace turned off from its row after a failed restore and a `chan serve` comes back on once, at the first restart under this build. That restart moves the prefix of a workspace served at one this build no longer derives, and an address a client kept for it stops answering; a terminal such a workspace parked is now restored in the tenant its window is shown under, where it was ended, though `cs` in it fails until an order in hand lands, and one whose window an earlier build stored under an alias's spelling is still ended. Written as costs: a launcher mount over a devserver record that is off, which reads off and after a save on with no token, and an add or a launcher's on alone, which leaves no devserver record. The code of this landing does what the item on a relinked off row that outlives a devserver restart asks, accepted for v0.102.0 and its state the owner's, and narrows the reading that a root relinked while mounted cannot be handed off to a root with no devserver record that reads mounted. The refusal envelope's client half landed its fifth part, its item still open: a new window's tab that its user took elsewhere before the create answered is left to them and its record discarded, with a sentence that says so, the workspace app's create discards the record it minted wherever no window shows it, and the refusal readers are pinned as they are. The launcher's removal answering another process's lock with a 500 joins the item on the add's and the on's two answers, and the AUR build of `chan` was red twice more on landing 31's commit, killed in its release test compile and then lost with its runner. Five items are raised for a decision: two tests of chan-library that signal a process they did not start, with one of chan-server that kills by command line, two registry rows that can name one directory, the fd-store e2e suite printing the devserver's token, a test of chan-library that ran out its ten seconds once on a hosted Windows runner, and the root stall, which holds a named step only in a build that keeps its symbols, so that two tests of chan-desktop fail in the AUR recipe's release build and main CI is red at that job since the landing that added them. Later on 2026-09-28 two ranges of the web app landed together, and each lands its item. A file whose name holds a backslash reads as itself in the web app, the item's web half: the workspace app's `basename` and `parentDir` cut a workspace path at `/` alone, so the inspector's title and image text and the PDF export's status line and file name call such a file by its whole name, where they named it by the part after its last `\`; eight copies written as functions and sixteen written in place are folded onto the two, three that answer an edge input differently and the file classifier, which a check compiles by itself, keep a cut of their own at `/`, and the launcher's copy, which is handed a host's root, is renamed `rootName` and keeps its cut; the path prompt still refuses a typed `\` and says that a name cannot hold one. By rulings of the lead's, which the owner has not answered, the Clients lane built the fold that the owner's ruling gave to the frontend lane, the cuts written in place were folded too, and the editor's inline Name field and a drop are not changed. A draft closed before its content arrives is kept: a single close that is not forced leaves the draft's file as it is while its load runs, or while its last read failed and nothing was typed over what had arrived, with no notice by a ruling of the lead's that the owner has not answered, and the reopen opens that draft by its path and loads it again, in a workspace window and a standalone one alike; a reading on a display is owed at rc0. Four items are raised for a decision, three found in that work, the surfaces that take a typed or dropped name disagreeing on a backslash, the excluded-directories control among them, chan-desktop saving a download under the part of its name after the last backslash, and a draft reopened after a forced or a bulk close coming back as a new draft, and one found by the order on the tests that signal a process they did not start, the close of a restored terminal signalling a process id and not the process its session started; and the demo's stand-in server taking an entry's parent from the client's own function joins the frontend review remainder. Two more are raised by the lead: the control socket's directory, which the server and every client believe as found where the handoff's sockets refuse a directory that is not the user's own, and a test of the host that waits on a reference and not on the lock's release, which failed once in main CI on the landing before this one. Later on 2026-09-28 a test's repair and two ranges landed together, each range with its fix round. The test of the host waits for the lock's release, which lands its item: its builder reproduced the race with a delay in the lock's drop, and the file's two tests with that wait call the host's own wait for no reference and a free lock and assert the lock free after it. No test of chan-library or chan-server signals a process it did not start, which lands its item: the two tests that imported a session with a made-up pid import a child of their own, and the test of chan-server kills the child it read through a pidfd. `cs` in a terminal whose devserver tenant moved reaches it: when its stable socket is gone, `cs` asks the devserver's other stable sockets in the same directory, only where neither the group nor the world can write that directory, and uses the one tenant that serves the terminal's workspace, saying so on stderr only to a terminal. By two rulings of the lead's, which the owner has not answered, the directory's mode is the rule and its owner is not checked, and only `cs`'s own resolvers can start the search; the costs are written in the relinked root's item, among them a directory put in the place of a runtime directory that has gone away, which the search believes without the socket's name, and a terminal whose workspace folder does not answer, which waits. And the desktop's half of a relinked root landed, its item still open: the desktop keys a workspace by the root its registry row stores, asks its host whether a workspace is served, and mints the windows of its handoff, `serve::start` and `cs window new` under that root, so a relinked root's window nests under its row, `cs window new` opens a window of a workspace the launcher turned on, a `chan serve` after the launcher's off turns the workspace on, and a user's open that loses the race to publish still opens its window, which closes the case of a `chan serve` that starts the desktop for a workspace left on and opened none. It lands the item of a handoff that keyed a root before the root existed. By a ruling of the lead's, which the owner has not answered, the desktop's forget names the stored root only while it still resolves to the canonical root of the runtime it found, and that canonical root otherwise, so a forget of a workspace whose stored root was pointed at another workspace's folder while it was open no longer forgets that other workspace, and the workspace asked stays registered and off, which is written as a cost. What that leaves open is the two menu commands that copy a window's path, left out by a ruling of the lead's, the host's removal, which unregisters by the name it is given, and a root relinked while it is mounted, which the devserver cannot hand off when none of its records reads mounted. Five items are raised for a decision: the reset and the import taking their own reference's drop for the lock's release, a library id in the control socket's identity and a terminal's environment, the host's removal unregistering and purging by the name it is given, the desktop's two menu commands copying a window outside its row, and the workspace app's deck naming a window on a Windows host by its whole root. The texts of three items are brought up to this code: the control socket's directory, which the search now believes by its mode, the stale sentences, which gain five comments these ranges left stale in other files, and a draft reopened after a forced close, whose user's bulk closes refuse a pane that holds a draft; and the relinked root's item says that for one of its three kinds of restored session `cs` reaches another tenant than the one that holds it. On 2026-09-29 the live drawing landed, forty-three commits in the workspace app and the changelog in two ranges and two fix rounds, and with it the builds of both its items, each accepted until a reading on a display at rc0, the last point of its acceptance. A live drawing's appState is written only when someone changes it: an adopt takes the authority's appState as the drawing library keeps it, hands the board that and no other key, and makes it at once what the next push offers and what the authority is known to hold, and the push compares the two as values, so a window that only opens a drawing whose appState is `{}`, carries keys the library drops or lists them in another order pushes nothing, and a push made before the library shows an adopt sends nothing older. While a window's own appState push stands an update's appState is withheld, and a drawing that a peer edited reads as saved and closes. A live board binds to its session once it has taken its first seed, so a snapshot or an update that lands before the library's init waits in the session's scene and is on the board after it; that scene holds the window's own pushes, a snapshot belongs to the socket it came on, a board that has not seeded pushes nothing, a roster frame no longer replays the scene, and a snapshot fanned on the same socket at a conflict's resolution keeps the window's pushes claimed, its fold deciding a tie of versions as the authority does. The withheld appState, the saved mark, the claims kept across a fanned snapshot and a push that waits for its socket's snapshot, under which a grid or background picked before that snapshot gives way to it, are rulings of the lead's, which the owner has not answered. Written as costs: a grid or background change that the authority never took turns back at a reattach, now also on a drawing whose stored appState lacks the key, where the release kept it; a key the library drops leaves the file at the first real change; a discrete event's render can still drop a handed appState early; and a reseed from a buffer older than the authority pushes that buffer's appState over a peer's. Six items are raised for a decision: a grid or background change that the authority never took turning back at a reattach, which the lead's notes on the first range's review mark for the owner, a Hybrid Nav commit leaving a live drawing that a peer edited reading unsaved, an element with no version written by a window that only opens its drawing, a save's fallback writing the buffer of a board that never seeded over a peer's edit, a save of a live drawing answering before the authority writes the file, and a stroke still inside the canvas's debounce lost when its tab loads again, which the report of the order on two closes found. The text of a draft closed during its load is brought up to this code: the stroke that one of its costs names is lost by the seed at the load's end, and not in the buffer.

**Frontend review, phased from v0.100.0**

| item | state | next |
| --- | --- | --- |
| [source-text-tests-pin-spelling-not-behaviour][rawt] | landed | GA |
| [one-question-is-answered-in-many-places][dedup] | accepted | after rawt |
| [frontend-comments-narrate-history][cmts] | accepted | build |
| [hand-mirrored-contracts-have-no-gate][mirr] | landed | GA |
| [the-frontend-review-remainder-has-no-owner][ferem] | accepted | build |

**From the v0.99.0 follow-ups**

| item | state | next |
| --- | --- | --- |
| [an-admitted-tunnel-outlives-its-connection][tunl] | landed | GA |
| [a-stalled-reader-parks-a-pool-thread][stall] | landed | GA |
| [one-root-blocks-every-other-mount][rlock] | landed | GA |
| [a-non-utf8-text-file-loses-its-backlinks][nutf] | landed | GA |
| [two-copies-to-one-free-name-can-collide][copy2] | landed | GA |
| [a-blocking-pool-pin-passes-without-proof][bpin] | landed | GA |
| [stale-sentences-outlive-their-code][prose] | accepted | build |
| [a-service-spawned-extension-gets-a-bare-path][extp] | landed | GA |
| [the-aur-check-could-ship-a-test-only-feature][aurc] | landed | GA |

**Raised during v0.100.0**

| item | state | next |
| --- | --- | --- |
| [refusals-answer-in-four-shapes][refus] | accepted | build |
| [the-team-poke-names-a-path-it-does-not-anchor][poke] | landed | GA |
| [a-redrawing-tui-never-lets-the-write-queue-drain][rdrw] | landed | GA |
| [an-expired-survey-cannot-be-dismissed][surv] | landed | GA |
| [the-test-util-comments-omit-the-attach-seam][tutil] | landed | GA |
| [the-fdstore-manifest-splits-seq-and-tail][fdsq] | landed | GA |
| [a-mount-retry-test-races-a-wall-clock][mwclk] | landed | GA |
| [desktop-design-omits-the-root-health-probe][dhp] | landed | GA |
| [a-dropped-indexers-driver-eats-recovery][drvr] | landed | GA |
| [the-bulk-skip-note-calls-unknown-locked][bskip] | landed | GA |
| [mcp-write-errors-follow-an-unpinned-display][mcpd] | landed | GA |
| [a-joining-snapshot-fails-during-reconcile][join] | landed | GA |
| [profile-workers-have-no-shutdown-owner][pwork] | landed | GA |
| [the-email-fold-merges-distinct-characters][fold] | withdrawn | GA |
| [the-move-out-spare-covers-the-whole-window][spare] | landed | GA |
| [an-emptied-window-waits-without-a-bound][ewait] | landed | GA |
| [the-chan-home-fallback-trusts-var-tmp][vtmp] | landed | GA |
| [three-inputs-have-no-size-cap][caps] | landed | GA |
| [content-search-truncation-ignores-its-window][trunc] | landed | GA |
| [move-and-create-can-replace-a-new-file][clob] | landed | GA |
| [the-graph-indexer-drops-renames-and-lingers][gidx] | landed | GA |
| [the-side-effect-and-error-lows-are-unread][unread] | landed | GA |
| [the-launcher-says-off-beside-running][offrn] | landed | GA |
| [devserver-root-probe-wiring-has-no-test][rprob] | landed | GA |
| [page-break-scan-and-renderer-still-differ][pgres] | withdrawn | GA |
| [a-tab-list-duplicate-key-escapes-its-boundary][tkey] | landed | GA |
| [graph-bodies-have-no-mounted-test][gmnt] | accepted | after rawt |
| [the-nsis-uninstaller-stub-ships-unsigned][nsis] | accepted | rc0 |
| [signing-has-no-early-credential-probe][cprb] | landed | GA |

**From the development archive's backlog**

| item | state | next |
| --- | --- | --- |
| [the-chan-cli-crate-is-one-13k-line-file][clib] | accepted | analyze |
| [two-exact-pins-hold-back-web-upgrades][pins] | accepted | build |
| [tower-sessions-lags-and-axum-has-a-dead-feature][tses] | accepted | build |
| [gateway-ci-misses-root-tunnel-crate-changes][gwci] | landed | GA |
| [the-web-bundles-still-build-on-node-20][nd22] | landed | GA |
| [the-launcher-build-hint-cannot-run][hint] | landed | GA |
| [the-site-carries-a-workspace-mock-nobody-ships][mock] | landed | GA |
| [an-unknown-window-kind-may-drop-every-window-row][wkind] | landed | GA |

**Raised during v0.101.0**

| item | state | next |
| --- | --- | --- |
| [a-revocation-aborts-the-bridge-before-its-close][revab] | landed | GA |
| [a-late-fetch-after-teardown-reds-the-web-check][lfetch] | landed | GA |
| [the-desktop-decodes-a-window-feed-all-or-nothing][wfeed] | landed | GA |
| [a-restart-replays-only-the-manifest-tail][rtail] | landed | GA |
| [a-crash-restart-restores-a-stale-manifest][crash] | landed | GA |
| [a-graceful-restart-drops-output-past-its-snapshot][gdrop] | landed | GA |
| [a-failed-dial-makes-the-next-replay-from-zero][fdial] | landed | GA |
| [the-served-index-forgets-a-lone-rename][srename] | landed | GA |
| [a-case-only-rename-leaves-a-phantom-row][casef] | landed | GA |
| [the-apps-wake-path-outlives-its-mount][wgap] | landed | GA |
| [a-watcher-loss-leaves-the-code-report-stale][wrep] | landed | GA |
| [terminal-env-overrides-are-silently-dropped][tenv] | landed | GA |
| [a-corrupt-devserver-config-re-mints-the-library-identity][dscfg] | landed | GA |
| [the-detached-daemon-keeps-the-launching-shells-directory][dcwd] | landed | GA |
| [a-scripted-reports-disable-exits-zero-having-changed-nothing][rsyes] | landed | GA |
| [a-keychain-failure-freezes-a-connected-gateways-roster][kring] | landed | GA |
| [a-graceful-restarts-session-save-drops-the-terminals-session-id][resave] | landed | GA |
| [a-single-file-copy-skips-the-utf8-gate][cpsk] | landed | GA |
| [a-cut-paste-can-replace-the-first-moved-file][mvrep] | landed | GA |
| [the-settings-date-format-never-saves][dfmt] | landed | GA |
| [four-tests-still-read-source-with-node-fs][fsrd] | landed | GA |
| [the-attach-prelude-order-has-no-rust-test][prel] | landed | GA |
| [mounted-components-mutate-props-they-do-not-own][ownw] | landed | GA |
| [a-sent-prompt-stays-editable-while-pending][rpro] | landed | GA |
| [a-click-beside-a-graph-node-clears-the-selection][gring] | landed | GA |
| [a-mirrored-value-focuses-an-unfocused-editor][afoc] | landed | GA |
| [a-started-mcp-tool-cannot-be-cancelled][mcan] | landed | GA |
| [the-writer-lock-probe-waits-on-a-hung-root][wlock] | landed | GA |
| [a-hung-root-stalls-desktop-close-and-quit][dquit] | landed | GA |
| [one-hung-root-holds-up-the-whole-restore][rseq] | accepted | build |
| [a-hung-root-takes-a-thread-per-expired-caller][rthrd] | accepted | build |
| [a-hung-root-keeps-reading-running][hrun] | landed | GA |
| [a-late-http-mount-escapes-the-shutdown-sweep][lsweep] | landed | GA |
| [the-linux-gate-runs-tests-under-a-canonical-tmpdir][ctmp] | landed | GA |
| [a-relinked-root-window-nests-outside-its-row][rnest] | accepted | build |
| [the-desktop-handoff-keys-an-absent-root][hkey] | landed | GA |
| [one-close-reason-covers-a-parked-and-a-killed-pty][pkill] | accepted | build |
| [a-fresh-session-under-an-old-id-keeps-the-key-protocol][kproto] | landed | GA |
| [the-scripted-team-drops-member-env][senv] | landed | GA |
| [the-memfd-ring-mirror-doubles-the-terminals-memory][mmap] | landed | GA |
| [a-reattach-replays-before-the-pty-takes-the-clients-size][rsz] | landed | GA |
| [a-pane-split-rebuilds-a-live-terminal-from-old-width-bytes][psplit] | landed | GA |
| [a-backslash-in-a-name-reads-two-ways-on-the-wire][bslash] | landed | GA |
| [a-spawned-child-holds-a-lock-until-it-execs][lockdup] | landed | GA |
| [a-resilience-transcript-is-dumped-before-its-readers-drain][tdump] | landed | GA |
| [co-viewers-of-a-window-keep-an-answered-survey][coview] | landed | GA |
| [an-adopted-sessions-recorded-size-can-lag-its-pty][adsz] | landed | GA |
| [is-root-mounted-answers-from-the-first-tenant-the-key-finds][rmfirst] | landed | GA |
| [the-canonical-key-query-counts-the-terminal-tenant][ckterm] | landed | GA |
| [the-linux-gate-has-no-windows-target-check][wingate] | landed | GA |
| [an-inspector-effect-refetches-a-failing-graph-stream-without-bound][insp] | landed | GA |
| [a-save-after-the-shutdown-sweeps-turns-every-workspace-off][ssave] | landed | GA |
| [the-terminal-tenant-answers-for-a-home-workspace][tterm] | landed | GA |
| [the-quit-drain-can-hang-on-a-recovery-pass][qdrain] | landed | GA |
| [the-devserver-stop-refuses-mounts-before-the-host][dstp] | landed | GA |
| [an-attached-json-tab-skips-the-parse-check][jsave] | landed | GA |
| [the-desktop-takes-ctrl-right-bracket-from-a-shell][rbrk] | landed | GA |
| [a-quit-can-hang-on-a-standalone-files-watch][fwatch] | landed | GA |
| [a-connecting-page-close-discards-its-window][cdisc] | accepted | build |
| [the-launchers-add-and-on-skip-the-stop-check][lstop] | accepted | build |
| [a-stopping-devserver-says-it-is-restoring][sgate] | accepted | build |
| [the-extension-proxy-forwards-to-an-exited-port][xport] | landed | GA |
| [two-warning-capture-tests-race-a-callsite-cache][wcap] | landed | GA |
| [two-closes-still-drop-a-drawings-last-stroke][sclose] | accepted | build |
| [the-gate-container-runs-as-root][groot] | accepted | build |
| [a-scene-snapshot-before-the-init-is-wiped][swipe] | accepted | rc0 |
| [a-draft-closed-during-its-load-is-trashed][dtrash] | landed | GA |
| [an-mcp-read-loads-the-whole-file-before-its-cap][rdcap] | landed | GA |
| [an-open-with-no-bound-holds-a-hung-roots-lock][hrwait] | landed | GA |
| [a-live-drawing-gains-appstate-keys-with-no-edit][aswrt] | accepted | rc0 |
| [a-drawing-that-does-not-parse-loses-its-editor][drwed] | landed | GA |
| [a-raw-devserver-restart-may-close-desktop-windows][rrwin] | raised | decide |
| [a-workspace-search-stops-only-between-seeds][sseed] | raised | decide |
| [the-chan-crate-exports-a-test-only-module][tstmod] | raised | decide |
| [a-repeated-element-id-gets-a-new-id-at-every-seed][rpid] | raised | decide |
| [a-drawing-library-crash-publishes-an-empty-scene][unmt] | raised | decide |
| [a-released-commands-success-paints-over-the-deck][rlsok] | raised | decide |
| [the-aur-check-is-killed-with-its-hosted-runner][aurkl] | raised | decide |
| [the-desktop-probe-takes-a-gateway-404-as-ready][gwnfd] | raised | decide |
| [a-connected-record-does-not-say-whose-socket][sockw] | raised | decide |
| [a-browser-show-opens-a-twin-of-a-native-window][natsh] | raised | decide |
| [a-kept-terminal-row-keeps-its-sessions-alive][ktrow] | raised | decide |
| [a-destructive-confirm-focuses-its-confirm-button][cfoc] | raised | decide |
| [a-failed-save-replaces-the-editor-with-its-error][svfal] | raised | decide |
| [a-draft-that-does-not-parse-cannot-be-discarded][drdsc] | raised | decide |
| [a-control-socket-close-outlives-its-client][ctlcs] | raised | decide |
| [a-close-answers-before-the-writer-lock-is-free][clfre] | raised | decide |
| [an-unreceived-open-result-blocks-a-runtime-worker][unrcv] | raised | decide |
| [a-test-reads-a-row-before-the-lock-is-released][rowrc] | raised | decide |
| [a-lock-probe-can-refuse-a-concurrent-acquire][prbhd] | raised | decide |
| [a-mounted-close-awaits-a-teardown-with-no-deadline][tdcl] | raised | decide |
| [a-closed-window-discards-a-connected-record][clwdc] | raised | decide |
| [the-desktop-handoff-registration-has-no-bound][hdreg] | raised | decide |
| [the-add-and-on-answer-a-foreign-lock-two-ways][lkfor] | raised | decide |
| [an-upload-cuts-a-name-at-its-backslash][bslup] | raised | decide |
| [the-manifest-writer-asks-every-root-under-a-lock][mnfrt] | raised | decide |
| [tests-signal-a-process-they-did-not-start][fkpid] | landed | GA |
| [two-registry-rows-can-name-one-directory][dupreg] | raised | decide |
| [the-fdstore-e2e-prints-the-devservers-token][tokpr] | raised | decide |
| [a-sweep-test-overran-its-ten-seconds-on-windows][wintmo] | raised | decide |
| [the-root-stall-names-a-step-by-symbols][stsym] | raised | decide |
| [typed-and-dropped-names-disagree-on-a-backslash][bstyp] | raised | decide |
| [the-desktop-cuts-a-download-name-at-its-backslash][bsdwn] | raised | decide |
| [a-force-closed-draft-reopens-as-a-new-draft][freop] | raised | decide |
| [a-restored-terminals-close-signals-a-bare-pid][impid] | raised | decide |
| [the-control-sockets-directory-is-believed-as-found][sokdr] | raised | decide |
| [a-test-waits-on-a-reference-and-not-on-the-lock][wkref] | landed | GA |
| [a-reset-counts-a-reference-another-can-upgrade][rsupg] | raised | decide |
| [the-control-socket-identity-names-no-library][cslib] | raised | decide |
| [a-removal-unregisters-by-the-name-it-is-given][rmnam] | raised | decide |
| [the-desktops-menu-copies-a-window-outside-its-row][mnucp] | raised | decide |
| [the-workspace-deck-names-a-windows-root-whole][dkwin] | raised | decide |
| [a-background-the-authority-never-took-turns-back][bgrev] | raised | decide |
| [hybrid-nav-leaves-a-live-drawing-unsaved][hnsav] | raised | decide |
| [an-element-with-no-version-is-written-unedited][nvers] | raised | decide |
| [a-save-fallback-writes-an-unseeded-boards-buffer][unsdw] | raised | decide |
| [a-live-drawing-save-answers-before-the-write][erlsv] | raised | decide |
| [a-stroke-in-the-debounce-is-lost-to-a-load][ldstk] | raised | decide |

### v0.102.0

Opened 2026-09-27 to hold what the owner accepted for a version after v0.101.0, none of it part of v0.101.0: two items raised during v0.101.0 that need a root which moved under a symlink; four more raised during v0.101.0 and accepted the same day for a later version, each as the lead recommended: the deck's Hide and Close on another host's window, a rejected JSON body's refusal naming the request's Rust type, the terminal pruner's save under the chan home on a runtime worker, and a gate's refusal of a wrong method listing the route's methods; and the owner's own request of the same day, a survey of how other MCP servers answer a read of a file over their cap.

| item | state | next |
| --- | --- | --- |
| [forgetting-a-relinked-root-waits-four-lookups][sfgt] | accepted | build |
| [a-relinked-off-row-outlives-a-devserver-restart][roff] | accepted | build |
| [the-deck-offers-close-on-another-hosts-window][dhost] | accepted | build |
| [a-rejected-json-body-names-its-rust-struct][jrej] | accepted | build |
| [the-terminal-pruner-saves-on-a-runtime-worker][prune] | accepted | build |
| [a-gate-refusal-lists-the-routes-methods][allow] | accepted | build |
| [how-mcp-servers-cap-a-read-is-unsurveyed][mcpsv] | accepted | build |

[rawt]: v0.101.0/source-text-tests-pin-spelling-not-behaviour.md
[dedup]: v0.101.0/one-question-is-answered-in-many-places.md
[cmts]: v0.101.0/frontend-comments-narrate-history.md
[mirr]: v0.101.0/hand-mirrored-contracts-have-no-gate.md
[ferem]: v0.101.0/the-frontend-review-remainder-has-no-owner.md
[tunl]: v0.101.0/an-admitted-tunnel-outlives-its-connection.md
[stall]: v0.101.0/a-stalled-reader-parks-a-pool-thread.md
[rlock]: v0.101.0/one-root-blocks-every-other-mount.md
[nutf]: v0.101.0/a-non-utf8-text-file-loses-its-backlinks.md
[copy2]: v0.101.0/two-copies-to-one-free-name-can-collide.md
[bpin]: v0.101.0/a-blocking-pool-pin-passes-without-proof.md
[prose]: v0.101.0/stale-sentences-outlive-their-code.md
[extp]: v0.101.0/a-service-spawned-extension-gets-a-bare-path.md
[aurc]: v0.101.0/the-aur-check-could-ship-a-test-only-feature.md
[refus]: v0.101.0/refusals-answer-in-four-shapes.md
[poke]: v0.101.0/the-team-poke-names-a-path-it-does-not-anchor.md
[rdrw]: v0.101.0/a-redrawing-tui-never-lets-the-write-queue-drain.md
[surv]: v0.101.0/an-expired-survey-cannot-be-dismissed.md
[clib]: v0.101.0/the-chan-cli-crate-is-one-13k-line-file.md
[pins]: v0.101.0/two-exact-pins-hold-back-web-upgrades.md
[tses]: v0.101.0/tower-sessions-lags-and-axum-has-a-dead-feature.md
[gwci]: v0.101.0/gateway-ci-misses-root-tunnel-crate-changes.md
[nd22]: v0.101.0/the-web-bundles-still-build-on-node-20.md
[hint]: v0.101.0/the-launcher-build-hint-cannot-run.md
[mock]: v0.101.0/the-site-carries-a-workspace-mock-nobody-ships.md
[wkind]: v0.101.0/an-unknown-window-kind-may-drop-every-window-row.md
[tutil]: v0.101.0/the-test-util-comments-omit-the-attach-seam.md
[fdsq]: v0.101.0/the-fdstore-manifest-splits-seq-and-tail.md
[mwclk]: v0.101.0/a-mount-retry-test-races-a-wall-clock.md
[dhp]: v0.101.0/desktop-design-omits-the-root-health-probe.md
[drvr]: v0.101.0/a-dropped-indexers-driver-eats-recovery.md
[bskip]: v0.101.0/the-bulk-skip-note-calls-unknown-locked.md
[mcpd]: v0.101.0/mcp-write-errors-follow-an-unpinned-display.md
[join]: v0.101.0/a-joining-snapshot-fails-during-reconcile.md
[pwork]: v0.101.0/profile-workers-have-no-shutdown-owner.md
[fold]: v0.101.0/the-email-fold-merges-distinct-characters.md
[spare]: v0.101.0/the-move-out-spare-covers-the-whole-window.md
[ewait]: v0.101.0/an-emptied-window-waits-without-a-bound.md
[vtmp]: v0.101.0/the-chan-home-fallback-trusts-var-tmp.md
[caps]: v0.101.0/three-inputs-have-no-size-cap.md
[trunc]: v0.101.0/content-search-truncation-ignores-its-window.md
[clob]: v0.101.0/move-and-create-can-replace-a-new-file.md
[gidx]: v0.101.0/the-graph-indexer-drops-renames-and-lingers.md
[unread]: v0.101.0/the-side-effect-and-error-lows-are-unread.md
[offrn]: v0.101.0/the-launcher-says-off-beside-running.md
[rprob]: v0.101.0/devserver-root-probe-wiring-has-no-test.md
[pgres]: v0.101.0/page-break-scan-and-renderer-still-differ.md
[tkey]: v0.101.0/a-tab-list-duplicate-key-escapes-its-boundary.md
[gmnt]: v0.101.0/graph-bodies-have-no-mounted-test.md
[nsis]: v0.101.0/the-nsis-uninstaller-stub-ships-unsigned.md
[cprb]: v0.101.0/signing-has-no-early-credential-probe.md
[revab]: v0.101.0/a-revocation-aborts-the-bridge-before-its-close.md
[lfetch]: v0.101.0/a-late-fetch-after-teardown-reds-the-web-check.md
[wfeed]: v0.101.0/the-desktop-decodes-a-window-feed-all-or-nothing.md
[rtail]: v0.101.0/a-restart-replays-only-the-manifest-tail.md
[crash]: v0.101.0/a-crash-restart-restores-a-stale-manifest.md
[gdrop]: v0.101.0/a-graceful-restart-drops-output-past-its-snapshot.md
[fdial]: v0.101.0/a-failed-dial-makes-the-next-replay-from-zero.md
[srename]: v0.101.0/the-served-index-forgets-a-lone-rename.md
[casef]: v0.101.0/a-case-only-rename-leaves-a-phantom-row.md
[wgap]: v0.101.0/the-apps-wake-path-outlives-its-mount.md
[wrep]: v0.101.0/a-watcher-loss-leaves-the-code-report-stale.md
[tenv]: v0.101.0/terminal-env-overrides-are-silently-dropped.md
[dscfg]: v0.101.0/a-corrupt-devserver-config-re-mints-the-library-identity.md
[dcwd]: v0.101.0/the-detached-daemon-keeps-the-launching-shells-directory.md
[rsyes]: v0.101.0/a-scripted-reports-disable-exits-zero-having-changed-nothing.md
[kring]: v0.101.0/a-keychain-failure-freezes-a-connected-gateways-roster.md
[resave]: v0.101.0/a-graceful-restarts-session-save-drops-the-terminals-session-id.md
[cpsk]: v0.101.0/a-single-file-copy-skips-the-utf8-gate.md
[mvrep]: v0.101.0/a-cut-paste-can-replace-the-first-moved-file.md
[dfmt]: v0.101.0/the-settings-date-format-never-saves.md
[fsrd]: v0.101.0/four-tests-still-read-source-with-node-fs.md
[prel]: v0.101.0/the-attach-prelude-order-has-no-rust-test.md
[ownw]: v0.101.0/mounted-components-mutate-props-they-do-not-own.md
[rpro]: v0.101.0/a-sent-prompt-stays-editable-while-pending.md
[gring]: v0.101.0/a-click-beside-a-graph-node-clears-the-selection.md
[afoc]: v0.101.0/a-mirrored-value-focuses-an-unfocused-editor.md
[mcan]: v0.101.0/a-started-mcp-tool-cannot-be-cancelled.md
[wlock]: v0.101.0/the-writer-lock-probe-waits-on-a-hung-root.md
[dquit]: v0.101.0/a-hung-root-stalls-desktop-close-and-quit.md
[rseq]: v0.101.0/one-hung-root-holds-up-the-whole-restore.md
[rthrd]: v0.101.0/a-hung-root-takes-a-thread-per-expired-caller.md
[hrun]: v0.101.0/a-hung-root-keeps-reading-running.md
[lsweep]: v0.101.0/a-late-http-mount-escapes-the-shutdown-sweep.md
[ctmp]: v0.101.0/the-linux-gate-runs-tests-under-a-canonical-tmpdir.md
[rnest]: v0.101.0/a-relinked-root-window-nests-outside-its-row.md
[hkey]: v0.101.0/the-desktop-handoff-keys-an-absent-root.md
[pkill]: v0.101.0/one-close-reason-covers-a-parked-and-a-killed-pty.md
[kproto]: v0.101.0/a-fresh-session-under-an-old-id-keeps-the-key-protocol.md
[senv]: v0.101.0/the-scripted-team-drops-member-env.md
[mmap]: v0.101.0/the-memfd-ring-mirror-doubles-the-terminals-memory.md
[rsz]: v0.101.0/a-reattach-replays-before-the-pty-takes-the-clients-size.md
[psplit]: v0.101.0/a-pane-split-rebuilds-a-live-terminal-from-old-width-bytes.md
[bslash]: v0.101.0/a-backslash-in-a-name-reads-two-ways-on-the-wire.md
[lockdup]: v0.101.0/a-spawned-child-holds-a-lock-until-it-execs.md
[tdump]: v0.101.0/a-resilience-transcript-is-dumped-before-its-readers-drain.md
[coview]: v0.101.0/co-viewers-of-a-window-keep-an-answered-survey.md
[adsz]: v0.101.0/an-adopted-sessions-recorded-size-can-lag-its-pty.md
[rmfirst]: v0.101.0/is-root-mounted-answers-from-the-first-tenant-the-key-finds.md
[ckterm]: v0.101.0/the-canonical-key-query-counts-the-terminal-tenant.md
[wingate]: v0.101.0/the-linux-gate-has-no-windows-target-check.md
[insp]: v0.101.0/an-inspector-effect-refetches-a-failing-graph-stream-without-bound.md
[ssave]: v0.101.0/a-save-after-the-shutdown-sweeps-turns-every-workspace-off.md
[tterm]: v0.101.0/the-terminal-tenant-answers-for-a-home-workspace.md
[qdrain]: v0.101.0/the-quit-drain-can-hang-on-a-recovery-pass.md
[dstp]: v0.101.0/the-devserver-stop-refuses-mounts-before-the-host.md
[jsave]: v0.101.0/an-attached-json-tab-skips-the-parse-check.md
[rbrk]: v0.101.0/the-desktop-takes-ctrl-right-bracket-from-a-shell.md
[fwatch]: v0.101.0/a-quit-can-hang-on-a-standalone-files-watch.md
[cdisc]: v0.101.0/a-connecting-page-close-discards-its-window.md
[lstop]: v0.101.0/the-launchers-add-and-on-skip-the-stop-check.md
[sgate]: v0.101.0/a-stopping-devserver-says-it-is-restoring.md
[xport]: v0.101.0/the-extension-proxy-forwards-to-an-exited-port.md
[wcap]: v0.101.0/two-warning-capture-tests-race-a-callsite-cache.md
[sclose]: v0.101.0/two-closes-still-drop-a-drawings-last-stroke.md
[groot]: v0.101.0/the-gate-container-runs-as-root.md
[swipe]: v0.101.0/a-scene-snapshot-before-the-init-is-wiped.md
[dtrash]: v0.101.0/a-draft-closed-during-its-load-is-trashed.md
[rdcap]: v0.101.0/an-mcp-read-loads-the-whole-file-before-its-cap.md
[hrwait]: v0.101.0/an-open-with-no-bound-holds-a-hung-roots-lock.md
[aswrt]: v0.101.0/a-live-drawing-gains-appstate-keys-with-no-edit.md
[drwed]: v0.101.0/a-drawing-that-does-not-parse-loses-its-editor.md
[rrwin]: v0.101.0/a-raw-devserver-restart-may-close-desktop-windows.md
[sseed]: v0.101.0/a-workspace-search-stops-only-between-seeds.md
[tstmod]: v0.101.0/the-chan-crate-exports-a-test-only-module.md
[rpid]: v0.101.0/a-repeated-element-id-gets-a-new-id-at-every-seed.md
[unmt]: v0.101.0/a-drawing-library-crash-publishes-an-empty-scene.md
[rlsok]: v0.101.0/a-released-commands-success-paints-over-the-deck.md
[aurkl]: v0.101.0/the-aur-check-is-killed-with-its-hosted-runner.md
[gwnfd]: v0.101.0/the-desktop-probe-takes-a-gateway-404-as-ready.md
[sockw]: v0.101.0/a-connected-record-does-not-say-whose-socket.md
[natsh]: v0.101.0/a-browser-show-opens-a-twin-of-a-native-window.md
[ktrow]: v0.101.0/a-kept-terminal-row-keeps-its-sessions-alive.md
[cfoc]: v0.101.0/a-destructive-confirm-focuses-its-confirm-button.md
[svfal]: v0.101.0/a-failed-save-replaces-the-editor-with-its-error.md
[drdsc]: v0.101.0/a-draft-that-does-not-parse-cannot-be-discarded.md
[ctlcs]: v0.101.0/a-control-socket-close-outlives-its-client.md
[clfre]: v0.101.0/a-close-answers-before-the-writer-lock-is-free.md
[unrcv]: v0.101.0/an-unreceived-open-result-blocks-a-runtime-worker.md
[rowrc]: v0.101.0/a-test-reads-a-row-before-the-lock-is-released.md
[prbhd]: v0.101.0/a-lock-probe-can-refuse-a-concurrent-acquire.md
[tdcl]: v0.101.0/a-mounted-close-awaits-a-teardown-with-no-deadline.md
[clwdc]: v0.101.0/a-closed-window-discards-a-connected-record.md
[hdreg]: v0.101.0/the-desktop-handoff-registration-has-no-bound.md
[lkfor]: v0.101.0/the-add-and-on-answer-a-foreign-lock-two-ways.md
[bslup]: v0.101.0/an-upload-cuts-a-name-at-its-backslash.md
[mnfrt]: v0.101.0/the-manifest-writer-asks-every-root-under-a-lock.md
[fkpid]: v0.101.0/tests-signal-a-process-they-did-not-start.md
[dupreg]: v0.101.0/two-registry-rows-can-name-one-directory.md
[tokpr]: v0.101.0/the-fdstore-e2e-prints-the-devservers-token.md
[wintmo]: v0.101.0/a-sweep-test-overran-its-ten-seconds-on-windows.md
[stsym]: v0.101.0/the-root-stall-names-a-step-by-symbols.md
[bstyp]: v0.101.0/typed-and-dropped-names-disagree-on-a-backslash.md
[bsdwn]: v0.101.0/the-desktop-cuts-a-download-name-at-its-backslash.md
[freop]: v0.101.0/a-force-closed-draft-reopens-as-a-new-draft.md
[impid]: v0.101.0/a-restored-terminals-close-signals-a-bare-pid.md
[sokdr]: v0.101.0/the-control-sockets-directory-is-believed-as-found.md
[wkref]: v0.101.0/a-test-waits-on-a-reference-and-not-on-the-lock.md
[rsupg]: v0.101.0/a-reset-counts-a-reference-another-can-upgrade.md
[cslib]: v0.101.0/the-control-socket-identity-names-no-library.md
[rmnam]: v0.101.0/a-removal-unregisters-by-the-name-it-is-given.md
[mnucp]: v0.101.0/the-desktops-menu-copies-a-window-outside-its-row.md
[dkwin]: v0.101.0/the-workspace-deck-names-a-windows-root-whole.md
[bgrev]: v0.101.0/a-background-the-authority-never-took-turns-back.md
[hnsav]: v0.101.0/hybrid-nav-leaves-a-live-drawing-unsaved.md
[nvers]: v0.101.0/an-element-with-no-version-is-written-unedited.md
[unsdw]: v0.101.0/a-save-fallback-writes-an-unseeded-boards-buffer.md
[erlsv]: v0.101.0/a-live-drawing-save-answers-before-the-write.md
[ldstk]: v0.101.0/a-stroke-in-the-debounce-is-lost-to-a-load.md
[sfgt]: v0.102.0/forgetting-a-relinked-root-waits-four-lookups.md
[roff]: v0.102.0/a-relinked-off-row-outlives-a-devserver-restart.md
[dhost]: v0.102.0/the-deck-offers-close-on-another-hosts-window.md
[jrej]: v0.102.0/a-rejected-json-body-names-its-rust-struct.md
[prune]: v0.102.0/the-terminal-pruner-saves-on-a-runtime-worker.md
[allow]: v0.102.0/a-gate-refusal-lists-the-routes-methods.md
[mcpsv]: v0.102.0/how-mcp-servers-cap-a-read-is-unsurveyed.md

## Completed

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
