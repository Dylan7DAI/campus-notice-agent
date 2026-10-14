// Only numeric positions and a fixed error vocabulary leave this parser.
// Native V8 messages may include the notice text and must never be logged.
export function parseModelJson(raw, allowControlChars = false) {
  const clean = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(clean); }
  catch (error) {
    if (allowControlChars) {
      const normalized = clean.replace(/[\u0000-\u001f]/g, (char) => char === '\n' ? '\\n' : char === '\r' ? '\\r' : char === '\t' ? '\\t' : '');
      try { return JSON.parse(normalized); } catch (normalizedError) { throw safeError(normalizedError, normalized); }
    }
    throw safeError(error, clean);
  }
}

function safeError(error, input) {
  const message = String(error?.message ?? '');
  const offset = message.match(/\bat position (\d+)(?: \(line \d+ column \d+\))?$/i);
  const claimedPosition = offset ? Number(offset[1]) : null;
  const position = Number.isSafeInteger(claimedPosition) && claimedPosition >= 0 && claimedPosition <= input.length ? claimedPosition : null;
  const prefix = position === null ? null : input.slice(0, position);
  const line = prefix === null ? null : prefix.split('\n').length;
  const column = prefix === null ? null : prefix.length - prefix.lastIndexOf('\n');
  const kind = /unterminated string/i.test(message) ? 'unterminated_string'
    : /escape/i.test(message) ? 'invalid_escape'
      : /control character/i.test(message) ? 'invalid_control_character'
        : /non-whitespace character after JSON/i.test(message) ? 'trailing_content'
          : /unexpected end/i.test(message) ? 'unexpected_end'
            : /number|fraction|exponent/i.test(message) ? 'invalid_number'
              : /expected.*property name|expected.*(?:,|:|\})|unexpected token/i.test(message) ? 'unexpected_structure'
                : 'unknown_syntax';
  const safe = new Error('MODEL_INVALID_OUTPUT');
  safe.issue = { path: '', code: 'json_invalid', kind, position, line, column };
  return safe;
}

export function repairFeedback(issues) {
  return issues.map((issue) => issue.code === 'json_invalid'
    ? `JSON syntax category=${issue.kind}; ${issue.position === null ? 'offset unavailable' : `UTF-16 offset ${issue.position}`}; line=${issue.line ?? 'unknown'}, column=${issue.column ?? 'unknown'} (after fence removal). Emit one valid JSON object; escape string contents and fix syntax at this location. Do not repeat the invalid output.`
    : `Schema issue ${issue.code} at ${issue.path || '/'}.`).join('\n');
}
