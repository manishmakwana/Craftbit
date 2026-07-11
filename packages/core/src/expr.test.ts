import { describe, expect, it } from "vitest";
import { ExprError, evaluateExpression, evaluateParameters, referencedNames } from "./expr";

const noEnv = (name: string): number => {
  throw new ExprError("unknown-name", `Unknown parameter "${name}"`);
};

describe("evaluateExpression", () => {
  it("evaluates arithmetic with precedence", () => {
    expect(evaluateExpression("2 + 3 * 4", noEnv)).toBe(14);
    expect(evaluateExpression("(2 + 3) * 4", noEnv)).toBe(20);
    expect(evaluateExpression("2 ^ 3 ^ 2", noEnv)).toBe(512); // right-assoc
    expect(evaluateExpression("10 % 3", noEnv)).toBe(1);
    expect(evaluateExpression("-4 + 1", noEnv)).toBe(-3);
  });

  it("converts unit suffixes to mm (spec §7.3 AC1)", () => {
    expect(evaluateExpression("1in", noEnv)).toBeCloseTo(25.4);
    expect(evaluateExpression("2.5cm", noEnv)).toBeCloseTo(25);
    expect(evaluateExpression("1m", noEnv)).toBe(1000);
    expect(evaluateExpression("25", noEnv)).toBe(25);
  });

  it("parses fractional inches (spec §7.3 AC2)", () => {
    expect(evaluateExpression("3/8in", noEnv)).toBeCloseTo(9.525);
    expect(evaluateExpression("1/2in", noEnv)).toBeCloseTo(12.7);
  });

  it("still treats plain division normally", () => {
    expect(evaluateExpression("3/8", noEnv)).toBeCloseTo(0.375);
    expect(evaluateExpression("3 / 8in", noEnv)).toBeCloseTo(3 / 25.4 / 8, 4);
  });

  it("supports functions (trig in degrees) and pi", () => {
    expect(evaluateExpression("sin(30)", noEnv)).toBeCloseTo(0.5);
    expect(evaluateExpression("cos(60)", noEnv)).toBeCloseTo(0.5);
    expect(evaluateExpression("sqrt(16)", noEnv)).toBe(4);
    expect(evaluateExpression("min(3, 7, 2)", noEnv)).toBe(2);
    expect(evaluateExpression("max(3, 7)", noEnv)).toBe(7);
    expect(evaluateExpression("pi", noEnv)).toBeCloseTo(Math.PI);
    expect(evaluateExpression("round(2.6)", noEnv)).toBe(3);
  });

  it("resolves parameter names via env", () => {
    const env = (n: string) => (n === "thickness" ? 3 : noEnv(n));
    expect(evaluateExpression("2 * thickness + 5", env)).toBe(11);
  });

  it("rejects bad syntax with ExprError", () => {
    for (const bad of ["", "2 +", "(2", "2..3", "2 & 3", "sin 30", "foo("]) {
      expect(() => evaluateExpression(bad, noEnv)).toThrow(ExprError);
    }
  });

  it("rejects division by zero", () => {
    expect(() => evaluateExpression("1 / 0", noEnv)).toThrow(/[Dd]ivision/);
  });

  it("rejects unknown names", () => {
    expect(() => evaluateExpression("nope + 1", noEnv)).toThrow(/Unknown parameter/);
  });
});

describe("referencedNames", () => {
  it("extracts parameter names, ignoring functions and pi", () => {
    expect(referencedNames("2 * thickness + sin(angle) + pi").sort()).toEqual([
      "angle",
      "thickness",
    ]);
    expect(referencedNames("42")).toEqual([]);
  });
});

describe("evaluateParameters", () => {
  it("resolves dependencies in any order", () => {
    const values = evaluateParameters([
      { name: "width", expression: "2 * thickness + 5" },
      { name: "thickness", expression: "3" },
    ]);
    expect(values.get("thickness")).toBe(3);
    expect(values.get("width")).toBe(11);
  });

  it("detects cycles (spec §7.9 AC3)", () => {
    expect(() =>
      evaluateParameters([
        { name: "a", expression: "b + 1" },
        { name: "b", expression: "a + 1" },
      ]),
    ).toThrow(/cycle/i);
  });

  it("reports unknown references", () => {
    expect(() => evaluateParameters([{ name: "a", expression: "ghost * 2" }])).toThrow(
      /Unknown parameter "ghost"/,
    );
  });
});
