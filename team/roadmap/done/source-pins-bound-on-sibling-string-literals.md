# String-index source pins in `main.rs` bound their slices on each other's string literals

Status: SHIPPED in [v0.86.0](../release/release-v0.86.0.md). All 24 dead end-bounds fixed on unique definition-form needles with a committed mutation probe.

## What

Several tests in `desktop/src-tauri/src/main.rs` pin control-flow invariants that no type or unit test can observe, by slicing the file's own source with `include_str!` and asserting on positions within the slice. The technique is sound and the invariants are real. The current instances carry two independent defects, and they are worth registering as two, because fixing only the first leaves the second untouched at every site.

**Defect one: an end assertion that can never fire.** At `main.rs:7714` and `:7798` the slice is bounded with:

```rust
.split("async fn connect_devserver_impl_inner")
.next()
.expect("<message>")
```

`Split::next` always yields `Some`, so the `expect` never fires and its message states something nothing checks. If the two functions were ever reordered, the slice would silently widen to the end of the file and the assertions would search the remainder of `main.rs`.

**Defect two: the needles are not unique.** `async fn connect_devserver_impl_inner` occurs four times in `main.rs`: the definition at `:2622`, and string literals at `:7714`, `:7798`, and `:8512`. Those literals belong to the pins themselves, so the four tests collide with each other's needles. A slice bounded on that string binds to whichever occurrence comes first, which may be another test thousands of lines away rather than the function it names.

`main.rs:8512` is not exposed to defect one: it anchors both needles with `find(..).expect(..)` and compares positions, so neither can vanish silently. It is exposed to defect two, and its slice is deliberately unbounded, running from `connect_devserver_impl_inner` to the end of the file. It takes the definition only because the definition happens to come first.

Fixing only the dead assertions leaves every site, including `:8512`, able to bound on a sibling's string literal.

## Why it survives review

An anchored needle is not a unique needle. `expect` is a control over presence and nothing at all over identity: it proves the needle was found, never that it was found in the right place.

Both defects are invisible while the file's current order is correct, which it is. They change nothing today and would surface only as a pin that quietly stops checking its invariant, which is the failure mode that costs the most later: a green test that no longer tests anything reads exactly like a green test that does.

## Verified current state (2026-08-06)

The same class was found and fixed in `runtime_capability.rs`, which now carries the reference shape. That fix is the evidence for both halves of this item:

- The dead end assertion was identified first and corrected by anchoring the end with `find(..).expect(..)`.
- That correction was then **proved insufficient**. An out-of-tree probe running the pin's logic against a mutated copy of `main.rs`, with the two function definitions reordered, still passed: the slice had bound to a sibling test's string literal and still contained the statement under test.
- The working fix anchors both ends on the definition form, `\nasync fn NAME(`, at line start with its open paren. Counted against the source, that form occurs exactly once for each name, against four and two occurrences of the bare names.

The probe now covers four distinct breaks, each red with its own message: the statement deleted, its failure demoted from `?` to `.ok()`, the statement moved past the call it must precede, and the two definitions reordered.

## Re-verified 2026-08-07

Every cited line is exact on current main: the needle occurs four times (`main.rs:2622` definition, `:7714`, `:7798`, `:8512` literals), defect one is live at `:7714-7716` and `:7798-7800`, and the reference shape stands in `runtime_capability.rs:488-492`. Three corrections sharpen the spec:

1. **The `:8512` collision is current behavior, not a hypothetical.** Its `.split(needle).nth(1)` over four occurrences yields the region from line 2622 to line 7714, terminating on a sibling test's string literal, computed against the file rather than inferred. Both of its `find` needles happen to fall inside that window, so the pin passes today by ordering luck. The slice is not "unbounded to the end of the file" as stated above; it is bounded on exactly the wrong thing.
2. **The reference fix breaks on a generic function.** `\nasync fn rostered_conn(` occurs zero times because the definition at `main.rs:2371` is `async fn rostered_conn<R: tauri::Runtime>(`. The definition-form recipe needs a generic-function clause (`\nasync fn rostered_conn` without the paren is unique); without it the fix is discovered broken mid-implementation at the `:7798` site.
3. **The counts in the sizing are wrong, and the class is larger.** There are three pin sites, not four; four is the needle count including the definition. And the dead `.split(..).next().expect(..)` end-bound pattern occurs at 24 sites in `main.rs`, so the contract's "a bound that cannot fail is not a bound" reaches far beyond the three named sites if read literally. The item must state its boundary before execution: the three `connect_devserver_impl_inner` sites, or the whole 24-site class. Per the project's fix-the-whole-class discipline the class is the right boundary, which moves the size from small toward medium.

## Ruling 2026-08-07: the boundary is the class

The owner accepted the class boundary: the item covers every dead `.split(..).next().expect(..)` end-bound in `main.rs`, all 24 sites, not only the three `connect_devserver_impl_inner` pins. Needle-uniqueness verification applies to every pin whose slice the fix touches, the generic-function clause from the re-verification applies to the definition-form needles, and the size is medium. The mutation acceptance below still names the two-definition reorder as the mandatory proof for the three original pins; the remaining sites are proven by their own bound being able to fail.

## Contract

- A source-slice pin binds to a needle that is unique in the file it slices, and the uniqueness is a property of the needle rather than of the current ordering.
- Every bound of the slice is asserted, including the end. A bound that cannot fail is not a bound.
- A pin that cannot bind its slice fails. It never widens to a larger region and continues asserting.
- Test needles do not collide with each other. A pin's own literal must not be a candidate match for a sibling pin's search.

## Acceptance

- All four sites bound on definition-form needles, with the uniqueness of each verified against the file rather than assumed.
- The end of every slice is asserted with something that can fail.
- **Proven by the mutation that caught the original**: reorder the two definitions and confirm each pin goes red. Absence of the needle is the easier case and it is not sufficient evidence; a pin can survive absence by widening and still bind to the wrong occurrence. A fix demonstrated only against a deleted needle is not accepted.
- The probe used lives with the change or is described in it, so the next person to touch these pins can rerun the mutation rather than reason about it.

## Rough size

Small. Four call sites in one file, plus the mutation runs. The care is entirely in the acceptance: the obvious fix passes the obvious test and does not hold.
