import { describe, expect, test } from "vitest";
import { terminalNoticeTop } from "./terminalNoticePlacement";

function box(left: number, top: number, right: number, bottom: number): DOMRect {
  return { left, top, right, bottom } as DOMRect;
}

describe("terminal notice placement", () => {
  const notice = box(1288, 38, 1595, 66);

  test("keeps the default place without a status pill", () => {
    expect(terminalNoticeTop(notice, null, 5)).toBe(5);
  });

  test("keeps the default place when the status pill is beside the notice", () => {
    expect(terminalNoticeTop(notice, box(1100, 48, 1280, 78), 5)).toBe(5);
  });

  test("keeps the default place when the status pill is above or below the notice", () => {
    expect(terminalNoticeTop(notice, box(1447, 0, 1587, 37), 5)).toBe(5);
    expect(terminalNoticeTop(notice, box(1447, 67, 1587, 90), 5)).toBe(5);
  });

  test("drops an overlapping notice five pixels below the status pill", () => {
    expect(terminalNoticeTop(notice, box(1447, 48, 1587, 78), 5)).toBe(50);
  });

  test("drops an overlapping notice from the find bar's lower default place", () => {
    expect(terminalNoticeTop(box(1288, 83, 1595, 111), box(1447, 93, 1587, 123), 50)).toBe(95);
  });

  test("keeps the default place when boxes only touch in either axis", () => {
    expect(terminalNoticeTop(notice, box(1595, 48, 1700, 78), 5)).toBe(5);
    expect(terminalNoticeTop(notice, box(1447, 66, 1587, 90), 5)).toBe(5);
  });
});
