/**
 * Expression engine (spec §7.9): numbers with unit suffixes (mm/cm/m/in/deg),
 * fractions like `3/8in`, operators + - * / % ^, parentheses, parameter names,
 * math functions, constant `pi`. All lengths evaluate to millimeters, angles
 * to degrees, and plain numbers stay scalar. A Pratt parser — no eval().
 */

export type ExprErrorCode = "syntax" | "unknown-name" | "cycle" | "division-by-zero";

export class ExprError extends Error {
  constructor(
    public code: ExprErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ExprError";
  }
}

const UNIT_TO_MM: Record<string, number> = {
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
  deg: 1, // angles are stored in degrees; suffix is allowed for clarity
};

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  sin: (x) => Math.sin((x * Math.PI) / 180),
  cos: (x) => Math.cos((x * Math.PI) / 180),
  tan: (x) => Math.tan((x * Math.PI) / 180),
  asin: (x) => (Math.asin(x) * 180) / Math.PI,
  acos: (x) => (Math.acos(x) * 180) / Math.PI,
  atan: (x) => (Math.atan(x) * 180) / Math.PI,
  sqrt: Math.sqrt,
  abs: Math.abs,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  min: Math.min,
  max: Math.max,
};

type Token =
  | { kind: "num"; value: number }
  | { kind: "name"; value: string }
  | { kind: "op"; value: string }
  | { kind: "lparen" }
  | { kind: "rparen" }
  | { kind: "comma" };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === " " || ch === "\t") {
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      const start = i;
      while (i < src.length && /[0-9.]/.test(src[i]!)) i++;
      const raw = src.slice(start, i);
      if (!/^(\d+\.?\d*|\.\d+)$/.test(raw)) {
        throw new ExprError("syntax", `Invalid number "${raw}"`);
      }
      let value = parseFloat(raw);
      // Fraction: `3/8in` — only when numerator and denominator are plain
      // integers immediately followed by a unit suffix.
      const fracMatch = /^\/(\d+)(mm|cm|m|in|deg)/.exec(src.slice(i));
      if (fracMatch && /^\d+$/.test(raw)) {
        value = value / parseInt(fracMatch[1]!, 10);
        i += 1 + fracMatch[1]!.length;
      }
      // Unit suffix
      const unitMatch = /^(mm|cm|m|in|deg)(?![A-Za-z0-9_])/.exec(src.slice(i));
      if (unitMatch) {
        value *= UNIT_TO_MM[unitMatch[1]!]!;
        i += unitMatch[1]!.length;
      }
      tokens.push({ kind: "num", value });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i]!)) i++;
      tokens.push({ kind: "name", value: src.slice(start, i) });
      continue;
    }
    if ("+-*/%^".includes(ch)) {
      tokens.push({ kind: "op", value: ch });
      i++;
      continue;
    }
    if (ch === "(") {
      tokens.push({ kind: "lparen" });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ kind: "rparen" });
      i++;
      continue;
    }
    if (ch === ",") {
      tokens.push({ kind: "comma" });
      i++;
      continue;
    }
    throw new ExprError("syntax", `Unexpected character "${ch}"`);
  }
  return tokens;
}

const BINARY_PRECEDENCE: Record<string, number> = {
  "+": 10,
  "-": 10,
  "*": 20,
  "/": 20,
  "%": 20,
  "^": 30,
};

class Parser {
  private pos = 0;
  constructor(
    private tokens: Token[],
    private env: (name: string) => number,
  ) {}

  parse(): number {
    if (this.tokens.length === 0) throw new ExprError("syntax", "Empty expression");
    const value = this.parseExpr(0);
    if (this.pos < this.tokens.length) {
      throw new ExprError("syntax", "Unexpected trailing input");
    }
    return value;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const t = this.tokens[this.pos++];
    if (!t) throw new ExprError("syntax", "Unexpected end of expression");
    return t;
  }

  private parseExpr(minPrec: number): number {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (!t || t.kind !== "op") break;
      const prec = BINARY_PRECEDENCE[t.value]!;
      if (prec < minPrec) break;
      this.next();
      // ^ is right-associative
      const right = this.parseExpr(t.value === "^" ? prec : prec + 1);
      switch (t.value) {
        case "+":
          left += right;
          break;
        case "-":
          left -= right;
          break;
        case "*":
          left *= right;
          break;
        case "/":
          if (right === 0) throw new ExprError("division-by-zero", "Division by zero");
          left /= right;
          break;
        case "%":
          if (right === 0) throw new ExprError("division-by-zero", "Modulo by zero");
          left %= right;
          break;
        case "^":
          left = Math.pow(left, right);
          break;
      }
    }
    return left;
  }

  private parseUnary(): number {
    const t = this.next();
    if (t.kind === "op" && t.value === "-") return -this.parseUnary();
    if (t.kind === "op" && t.value === "+") return this.parseUnary();
    if (t.kind === "num") return t.value;
    if (t.kind === "lparen") {
      const v = this.parseExpr(0);
      const close = this.next();
      if (close.kind !== "rparen") throw new ExprError("syntax", "Expected )");
      return v;
    }
    if (t.kind === "name") {
      if (t.value === "pi") return Math.PI;
      const fn = FUNCTIONS[t.value];
      if (fn) {
        const open = this.next();
        if (open.kind !== "lparen") {
          throw new ExprError("syntax", `Expected ( after function ${t.value}`);
        }
        const args: number[] = [];
        if (this.peek()?.kind !== "rparen") {
          args.push(this.parseExpr(0));
          while (this.peek()?.kind === "comma") {
            this.next();
            args.push(this.parseExpr(0));
          }
        }
        const close = this.next();
        if (close.kind !== "rparen") throw new ExprError("syntax", "Expected )");
        return fn(...args);
      }
      return this.env(t.value);
    }
    throw new ExprError("syntax", "Unexpected token");
  }
}

/** Evaluate an expression string against a parameter lookup. Result is mm/deg/scalar. */
export function evaluateExpression(src: string, env: (name: string) => number): number {
  const value = new Parser(tokenize(src), env).parse();
  if (!Number.isFinite(value)) {
    throw new ExprError("syntax", "Expression did not evaluate to a finite number");
  }
  return value;
}

/** Names referenced by an expression (used for dependency tracking & rename). */
export function referencedNames(src: string): string[] {
  const names = new Set<string>();
  try {
    for (const t of tokenize(src)) {
      if (t.kind === "name" && t.value !== "pi" && !(t.value in FUNCTIONS)) {
        names.add(t.value);
      }
    }
  } catch {
    // Unparseable expressions reference nothing.
  }
  return [...names];
}

export interface ParameterDef {
  name: string;
  expression: string;
}

/**
 * Evaluate a parameter table (topologically, detecting cycles and unknown
 * names). Returns a map of parameter name → value in mm/deg/scalar.
 */
export function evaluateParameters(params: ParameterDef[]): Map<string, number> {
  const byName = new Map(params.map((p) => [p.name, p]));
  const values = new Map<string, number>();
  const visiting = new Set<string>();

  const resolve = (name: string): number => {
    if (values.has(name)) return values.get(name)!;
    const def = byName.get(name);
    if (!def) throw new ExprError("unknown-name", `Unknown parameter "${name}"`);
    if (visiting.has(name)) {
      throw new ExprError("cycle", `Parameter cycle involving "${name}"`);
    }
    visiting.add(name);
    const value = evaluateExpression(def.expression, resolve);
    visiting.delete(name);
    values.set(name, value);
    return value;
  };

  for (const p of params) resolve(p.name);
  return values;
}
