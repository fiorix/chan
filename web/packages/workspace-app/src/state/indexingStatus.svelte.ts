// Shared cache of the last successful indexing-state poll.
//
// The Dashboard carousel's Indexing slide mounts `GraphCanvas` to draw
// the directory spine. A Hybrid flip unmounts the whole front face,
// including the carousel, and flip-back remounts it from scratch.
// Holding the last response in a module-level `$state` lets the
// remounted slide render its graph synchronously from cache instead of
// flashing empty while a fresh poll round-trips.
//
// Written by `EmptyPaneCarousel.refreshIndexing()` on every successful
// poll; read by the same component as the initial value for its local
// `indexing` state.

import type { IndexingStateResponse } from "../api/types";

export const indexingCache = $state<{ last: IndexingStateResponse | null }>({
  last: null,
});
