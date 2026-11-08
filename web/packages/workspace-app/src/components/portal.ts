import type { Attachment } from "svelte/attachments";

export function portal(node: HTMLElement): { destroy(): void } {
  document.body.appendChild(node);
  return {
    destroy() {
      node.parentNode?.removeChild(node);
    },
  };
}

/// Move the element into `target` for as long as the attachment lives, and
/// put it back exactly where it was when the attachment is torn down, which
/// happens when `target` changes and when the element's component is
/// destroyed. A null target leaves the element in place.
///
/// The element keeps its listeners and Svelte keeps updating it, because the
/// blocks inside it anchor to its own children. The element must not be the
/// first or last node of a block (an `{#if}` branch, a keyed item): a
/// block's teardown removes its nodes by walking siblings from wherever its
/// first node is, so a moved boundary node would take the target's children
/// with it. A placeholder comment holds the element's place; on teardown the
/// element goes back into it, so a component destroyed while the element is
/// away takes the element down with the rest of its detached subtree.
export function portalTo(target: HTMLElement | null): Attachment<HTMLElement> {
  return (node) => {
    if (!target || !node.parentNode) return;
    const home = document.createComment("portal");
    node.parentNode.insertBefore(home, node);
    target.appendChild(node);
    return () => {
      if (home.parentNode) home.parentNode.replaceChild(node, home);
      else node.remove();
    };
  };
}
