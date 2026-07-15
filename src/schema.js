export const ROUTES = [
  { routeId: "economy", description: "Simple, localized, low-risk task" },
  { routeId: "balanced", description: "Moderate reasoning, testing, repo inspection, or several files" },
  { routeId: "advanced", description: "Complex debugging, broad repo work, security, architecture, migrations, or concurrency" }
];

export const REASONING_LEVELS = ["low", "medium", "high", "xhigh"];

export const CLASSIFIER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "routeId",
    "reasoningLevel",
    "confidence",
    "taskType",
    "userIntent",
    "likelyFilesTouched",
    "candidateFiles",
    "ambiguity",
    "repoInspection",
    "testing",
    "risk",
    "effort",
    "estimatedMinutes",
    "complexity",
    "reason"
  ],
  properties: {
    routeId: { type: "string", enum: ROUTES.map((route) => route.routeId) },
    reasoningLevel: { type: "string", enum: REASONING_LEVELS },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    taskType: { type: "string", minLength: 1 },
    userIntent: { type: "string", minLength: 1 },
    likelyFilesTouched: { type: "integer", minimum: 0 },
    candidateFiles: { type: "array", items: { type: "string" } },
    ambiguity: { type: "integer", minimum: 0, maximum: 5 },
    repoInspection: { type: "string", minLength: 1 },
    testing: { type: "string", minLength: 1 },
    risk: { type: "string", enum: ["low", "medium", "high"] },
    effort: { type: "string", enum: ["low", "medium", "high"] },
    estimatedMinutes: {
      type: "object",
      additionalProperties: false,
      required: ["minimum", "maximum"],
      properties: {
        minimum: { type: "integer", minimum: 0 },
        maximum: { type: "integer", minimum: 0 }
      }
    },
    complexity: {
      type: "object",
      additionalProperties: false,
      required: ["reasoning", "repositoryContext", "implementation", "verification", "scope"],
      properties: {
        reasoning: { type: "integer", minimum: 1, maximum: 5 },
        repositoryContext: { type: "integer", minimum: 1, maximum: 5 },
        implementation: { type: "integer", minimum: 1, maximum: 5 },
        verification: { type: "integer", minimum: 1, maximum: 5 },
        scope: { type: "integer", minimum: 1, maximum: 5 }
      }
    },
    reason: { type: "string", minLength: 1 }
  }
};

export const CODEX_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: CLASSIFIER_SCHEMA.required,
  properties: {
    routeId: { type: "string", enum: ROUTES.map((route) => route.routeId) },
    reasoningLevel: { type: "string", enum: REASONING_LEVELS },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    taskType: { type: "string" },
    userIntent: { type: "string" },
    likelyFilesTouched: { type: "integer" },
    candidateFiles: { type: "array", items: { type: "string" } },
    ambiguity: { type: "integer", minimum: 0, maximum: 5 },
    repoInspection: { type: "string" },
    testing: { type: "string" },
    risk: { type: "string", enum: ["low", "medium", "high"] },
    effort: { type: "string", enum: ["low", "medium", "high"] },
    estimatedMinutes: {
      type: "object",
      additionalProperties: false,
      required: ["minimum", "maximum"],
      properties: {
        minimum: { type: "integer" },
        maximum: { type: "integer" }
      }
    },
    complexity: {
      type: "object",
      additionalProperties: false,
      required: ["reasoning", "repositoryContext", "implementation", "verification", "scope"],
      properties: {
        reasoning: { type: "integer", minimum: 1, maximum: 5 },
        repositoryContext: { type: "integer", minimum: 1, maximum: 5 },
        implementation: { type: "integer", minimum: 1, maximum: 5 },
        verification: { type: "integer", minimum: 1, maximum: 5 },
        scope: { type: "integer", minimum: 1, maximum: 5 }
      }
    },
    reason: { type: "string" }
  }
};

export function validateClassifierResult(value) {
  const errors = [];
  validateSchema(CLASSIFIER_SCHEMA, value, "$", errors);

  if (value && typeof value === "object" && value.estimatedMinutes) {
    const { minimum, maximum } = value.estimatedMinutes;
    if (Number.isInteger(minimum) && Number.isInteger(maximum) && minimum > maximum) {
      errors.push("$.estimatedMinutes.minimum must be <= $.estimatedMinutes.maximum");
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

function validateSchema(schema, value, path, errors) {
  if (schema.type === "object") {
    if (!isPlainObject(value)) {
      errors.push(`${path} must be an object`);
      return;
    }

    for (const key of schema.required || []) {
      if (!(key in value)) {
        errors.push(`${path}.${key} is required`);
      }
    }

    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties || {}));
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
          errors.push(`${path}.${key} is not allowed`);
        }
      }
    }

    for (const [key, childSchema] of Object.entries(schema.properties || {})) {
      if (key in value) {
        validateSchema(childSchema, value[key], `${path}.${key}`, errors);
      }
    }
    return;
  }

  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      errors.push(`${path} must be an array`);
      return;
    }
    value.forEach((item, index) => validateSchema(schema.items, item, `${path}[${index}]`, errors));
    return;
  }

  if (schema.type === "string") {
    if (typeof value !== "string") {
      errors.push(`${path} must be a string`);
      return;
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path} must not be empty`);
    }
    if (schema.enum && !schema.enum.includes(value)) {
      errors.push(`${path} must be one of: ${schema.enum.join(", ")}`);
    }
    return;
  }

  if (schema.type === "number") {
    if (typeof value !== "number" || Number.isNaN(value)) {
      errors.push(`${path} must be a number`);
      return;
    }
    validateBounds(schema, value, path, errors);
    return;
  }

  if (schema.type === "integer") {
    if (!Number.isInteger(value)) {
      errors.push(`${path} must be an integer`);
      return;
    }
    validateBounds(schema, value, path, errors);
  }
}

function validateBounds(schema, value, path, errors) {
  if (schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${path} must be >= ${schema.minimum}`);
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    errors.push(`${path} must be <= ${schema.maximum}`);
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
