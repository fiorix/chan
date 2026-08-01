/// Put an extension wrapper in the browser top layer without reparenting it.
/// Reparenting an element that contains an iframe destroys that iframe's
/// browsing context, including its WebAssembly heap and live sockets.
export function extensionPresentationLayer(node: HTMLElement, enabled: boolean) {
  const supportsPopover =
    typeof node.showPopover === "function" && typeof node.hidePopover === "function";
  let shown = false;

  const apply = (next: boolean) => {
    if (next === shown) return;
    shown = next;
    if (!supportsPopover) return;
    if (shown) {
      node.setAttribute("popover", "manual");
      node.showPopover();
    } else {
      node.hidePopover();
      node.removeAttribute("popover");
    }
  };

  apply(enabled);
  return {
    update: apply,
    destroy() {
      if (supportsPopover && shown) node.hidePopover();
      node.removeAttribute("popover");
    },
  };
}
