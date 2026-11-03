export type ParameterSchema = boolean | ParameterObject;

export interface ParameterObject {
  type?: string | string[];
  description?: string;
  properties?: Record<string, ParameterSchema>;
  required?: string[];
  items?: ParameterSchema;
  prefixItems?: ParameterSchema[];
  additionalProperties?: ParameterSchema;
  propertyNames?: ParameterSchema;
  anyOf?: ParameterSchema[];
  oneOf?: ParameterSchema[];
  allOf?: ParameterSchema[];
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  [key: string]: unknown;
}

export interface ParameterRow {
  type: string;
  typeDescription: string;
  description: string;
  required: boolean;
  default?: string;
}

function alternatives(schema: ParameterObject): ParameterSchema[] {
  return schema.oneOf ?? schema.anyOf ?? schema.allOf ?? [];
}

export function parameterType(schema: ParameterSchema): string {
  if (typeof schema === "boolean") return schema ? "unknown" : "never";
  if ("const" in schema) return JSON.stringify(schema.const);
  if (schema.enum)
    return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  const choices = alternatives(schema);
  if (choices.length)
    return choices.map(parameterType).join(schema.allOf ? " & " : " | ");
  if (schema.type === "array") {
    if (schema.prefixItems) {
      const members = schema.prefixItems.map(parameterType);
      if (schema.items !== false)
        members.push(`...Array<${parameterType(schema.items ?? true)}>`);
      return `[${members.join(", ")}]`;
    }
    return `Array<${parameterType(schema.items ?? true)}>`;
  }
  if (
    schema.type === "object" &&
    typeof schema.additionalProperties === "object"
  )
    return `Record<string, ${parameterType(schema.additionalProperties)}>`;
  return Array.isArray(schema.type)
    ? schema.type.join(" | ")
    : (schema.type ?? "unknown");
}

const constraintKeys = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
  "pattern",
  "format",
  "uniqueItems",
  "multipleOf",
]);

export function parameterConstraints(schema: ParameterSchema): string {
  if (typeof schema === "boolean")
    return schema ? "Any value is accepted." : "No values are accepted.";
  const constraints = Object.entries(schema)
    .filter(([key]) => constraintKeys.has(key))
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  if (schema.additionalProperties === false)
    constraints.push("Unknown properties are rejected.");
  if (schema.propertyNames !== undefined)
    constraints.push(
      `Record keys: ${parameterConstraints(schema.propertyNames)}`,
    );
  return constraints.join("; ");
}

/** The checked-in JSON boundary is produced from validated registered schemas. */
export function parameterRows(schema: unknown): Record<string, ParameterRow> {
  if (
    schema === null ||
    (typeof schema !== "object" && typeof schema !== "boolean") ||
    Array.isArray(schema)
  )
    throw new TypeError("Expected a JSON Schema object or boolean");
  const rows: Record<string, ParameterRow> = {};
  const visit = (
    node: ParameterSchema,
    name: string,
    required: boolean,
    context?: string,
  ) => {
    const object = typeof node === "boolean" ? undefined : node;
    if (name)
      rows[name] = {
        type: parameterType(node),
        typeDescription: parameterType(node),
        description: [
          object?.description,
          context ??
            (required
              ? "Required within its containing object."
              : "Optional within its containing object."),
          parameterConstraints(node),
        ]
          .filter(Boolean)
          .join(" "),
        required,
        ...(object && "default" in object
          ? { default: JSON.stringify(object.default) }
          : {}),
      };
    if (!object) return;
    const requiredNames = new Set(object.required);
    for (const [key, child] of Object.entries(object.properties ?? {}))
      visit(child, name ? `${name}.${key}` : key, requiredNames.has(key));
    if (object.items !== undefined)
      visit(
        object.items,
        `${name}[]`,
        false,
        "Schema for each additional array item. Array length constraints apply to the containing array.",
      );
    object.prefixItems?.forEach((child, index) =>
      visit(
        child,
        `${name}[${index}]`,
        false,
        `Schema for array position ${index}. Array length constraints apply to the containing array.`,
      ),
    );
    if (typeof object.additionalProperties === "object")
      visit(
        object.additionalProperties,
        `${name}.*`,
        false,
        "Schema for each existing record value. Record size and key constraints apply to the containing object.",
      );
    alternatives(object).forEach((child, index) =>
      visit(
        child,
        `${name}[alternative ${index + 1}]`,
        false,
        `Alternative ${index + 1} for the containing value.`,
      ),
    );
  };
  visit(schema as ParameterSchema, "", false);
  return rows;
}
