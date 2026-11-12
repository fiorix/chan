/// chan's binding of the vendored libghostty-vt core (`vendor/ghostty-vt/`),
/// exported as `@chan/ghostty-web-ng/vt`. It is an entry of its own, apart
/// from the widget's `lib/index.ts`, because the app imports the binding
/// statically and the widget lazily: through one entry, a static import of
/// the binding would bundle the widget with it, and the widget would no
/// longer load as a chunk of its own when the first ghostty terminal starts.

export * from "./ghosttyCopy";
export * from "./ghosttyVt";
