/**
 * 最小限のJSON Schemaバリデータ。
 * canonical.schema.json が使う機能だけを実装している:
 *   type / required / properties / additionalProperties / items / enum / minimum
 * ajv を入れずに「スキーマ実ファイルとの適合」を検証するために自作した。
 * （ランタイム依存0・devDependency 0を維持するため。design specification §7-6）
 */

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  return typeof value;
}

function typeMatches(allowed, actual) {
  const list = Array.isArray(allowed) ? allowed : [allowed];
  if (list.includes(actual)) return true;
  // integer は number としても許容される
  if (actual === "integer" && list.includes("number")) return true;
  return false;
}

export function validate(schema, data, pointer = "$", errors = []) {
  if (!schema || typeof schema !== "object") return errors;

  if (schema.type !== undefined) {
    const actual = typeOf(data);
    if (!typeMatches(schema.type, actual)) {
      errors.push(
        `${pointer}: type mismatch — expected ${JSON.stringify(schema.type)}, got ${actual}`
      );
      return errors; // 型が違う時点で以降のチェックは無意味
    }
  }

  if (schema.enum !== undefined && !schema.enum.includes(data)) {
    errors.push(`${pointer}: ${JSON.stringify(data)} not in enum ${JSON.stringify(schema.enum)}`);
  }

  if (typeof data === "number" && schema.minimum !== undefined && data < schema.minimum) {
    errors.push(`${pointer}: ${data} < minimum ${schema.minimum}`);
  }

  if (typeOf(data) === "object") {
    for (const key of schema.required ?? []) {
      if (!(key in data)) errors.push(`${pointer}: missing required property '${key}'`);
    }

    const props = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(data)) {
        if (!(key in props)) errors.push(`${pointer}: unexpected property '${key}'`);
      }
    }

    for (const [key, sub] of Object.entries(props)) {
      if (key in data) validate(sub, data[key], `${pointer}.${key}`, errors);
    }
  }

  if (typeOf(data) === "array" && schema.items) {
    data.forEach((item, i) => validate(schema.items, item, `${pointer}[${i}]`, errors));
  }

  return errors;
}
