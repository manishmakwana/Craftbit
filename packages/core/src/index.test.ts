import { describe, expect, it } from "vitest";
import { CRAFTBIT_FORMAT_VERSION } from "./index";

describe("core package scaffold", () => {
  it("exposes the current document format version", () => {
    expect(CRAFTBIT_FORMAT_VERSION).toBe(1);
  });
});
