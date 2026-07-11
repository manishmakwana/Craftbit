import { useEffect, useState } from "react";
import { evaluateExpression, referencedNames } from "@craftbit/core";
import { useGeometryStore } from "../stores/geometryStore";

/**
 * The shared dimension input (spec §7.0.3): accepts expressions with units
 * and parameter references, validates live, commits on Enter/blur, and shows
 * an ƒx badge when the value references parameters.
 */
export function ExpressionInput({
  label,
  value,
  onCommit,
  autoFocus,
  testid,
}: {
  label: string;
  value: string;
  onCommit: (expr: string) => void;
  autoFocus?: boolean;
  testid?: string;
}) {
  const [text, setText] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const result = useGeometryStore((s) => s.result);
  const paramValues = result?.parameterValues ?? {};

  useEffect(() => setText(value), [value]);

  const validate = (t: string): string | null => {
    try {
      evaluateExpression(t, (name) => {
        const v = paramValues[name];
        if (v === undefined) throw new Error(`Unknown parameter "${name}"`);
        return v;
      });
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };

  const commit = () => {
    const err = validate(text);
    setError(err);
    if (!err && text !== value) onCommit(text);
  };

  const hasParams = referencedNames(text).length > 0;

  return (
    <div className="field">
      <label>
        {label}
        {hasParams && <span style={{ color: "var(--accent)", marginLeft: 4 }}>ƒx</span>}
      </label>
      <input
        data-testid={testid}
        className={error ? "invalid" : ""}
        value={text}
        autoFocus={autoFocus}
        onChange={(e) => {
          setText(e.target.value);
          setError(validate(e.target.value));
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
      />
      {error && <span className="error-text">{error}</span>}
    </div>
  );
}
