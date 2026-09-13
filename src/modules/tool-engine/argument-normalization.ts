type AbsenceSchema = {
  properties?: Record<string, unknown>;
  required?: string[];
  items?: unknown;
};

function preservesBlankString(
  source: Record<string, unknown>,
  key: string,
  toolName?: string,
): boolean {
  if (toolName === 'lc_run_shell' && key === 'stdin') return true;

  const editFlatField = toolName === 'lc_edit_file'
    && (key === 'old_string' || key === 'new_string')
    && !(Array.isArray(source.files) && source.files.length > 0);
  if (editFlatField) return true;

  if (toolName !== 'lc_whiteboard') return false;
  if (source.action === 'replace') return key === 'content';
  if (source.action === 'edit') return key === 'old_string' || key === 'new_string';
  return false;
}

/**
 * Treat a blank string as omission only when the wire schema marks that
 * property optional. Required empty values remain available to validation.
 */
export function normalizeOptionalAbsence(
  value: unknown,
  schema: unknown,
  toolName?: string,
): unknown {
  const schemaNode = schema as AbsenceSchema | undefined;
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    return value.map((item) => normalizeOptionalAbsence(item, schemaNode?.items, toolName));
  }
  if (typeof value !== 'object') return value;

  const source = value as Record<string, unknown>;
  const required = new Set(schemaNode?.required ?? []);
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) {
    const propertySchema = schemaNode?.properties?.[key];
    // Preserve unknown properties so a strict schema can reject them. They are
    // not optional merely because they are absent from the declared schema.
    if (propertySchema === undefined) {
      out[key] = child;
      continue;
    }
    if (child === null || child === undefined) continue;
    const isOptional = !required.has(key);
    if (
      isOptional
      && !preservesBlankString(source, key, toolName)
      && typeof child === 'string'
      && child.trim().length === 0
    ) {
      continue;
    }
    out[key] = normalizeOptionalAbsence(child, propertySchema, toolName);
  }
  return out;
}
