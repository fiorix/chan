// Shared cache of the last successful indexing-state poll.
//
// The Dashboard carousel's Indexing slide mounts `GraphCanvas` to draw
// the directory spine. Holding the last response in a module-level
// `$state` lets a carousel mounted later in the page (another Dashboard
// tab, or one mounted again) render its graph synchronously from cache
// instead of flashing empty while a fresh poll round-trips.
//
// Written by `EmptyPaneCarousel.refreshIndexing()` on every successful
// poll; read by the same component as the initial value for its local
// `indexing` state.

import type { IndexingStateResponse } from "../api/types";

export const indexingCache = $state<{ last: IndexingStateResponse | null }>({
  last: null,
});
