// @vitest-environment jsdom
//
// Show transfers opens the transfer panel from the launcher, the way to it
// while the status bar's Transfers launcher is closed. It is offered only
// while the panel has something to show.

import { afterEach, expect, test } from "vitest";
import { allCommands, commandContext } from "../commands";
import { beginTransfer, hideTransfers, transfers } from "../transfers.svelte";
import "./global";

afterEach(() => {
  transfers.items = [];
  hideTransfers();
});

function showTransfersCommand() {
  const command = allCommands().find((c) => c.id === "app.transfers.show");
  expect(command, "Show transfers is registered").toBeDefined();
  return command!;
}

test("is not offered with no transfer to show", () => {
  expect(showTransfersCommand().available(commandContext())).toBe(false);
});

test("opens the panel while a transfer runs", () => {
  beginTransfer({ kind: "upload", filename: "a.bin", cancel: null });
  const command = showTransfersCommand();
  expect(command.available(commandContext())).toBe(true);
  command.run();
  expect(transfers.shown).toBe(true);
});
