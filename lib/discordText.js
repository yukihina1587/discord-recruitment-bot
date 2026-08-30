const MARKDOWN_DELIMITERS = new Set([
  '\\', '`', '*', '_', '~', '|', '[', ']', '(', ')', '<', '>',
]);

function normalizedVisibleText(value, neutralizeMentions) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    .replace(/@/gu, neutralizeMentions ? '＠' : '@')
    .replace(/\s+/gu, ' ')
    .trim();
}

function lineLeadingEscapeIndex(value) {
  if (
    /^#{1,6}(?:\s|$)/u.test(value)
    || /^[-+](?:\s|$)/u.test(value)
    || /^-#(?:\s|$)/u.test(value)
  ) return 0;
  const orderedList = /^\d{1,9}\.(?:\s|$)/u.exec(value);
  return orderedList ? orderedList[0].indexOf('.') : -1;
}

/**
 * Escapes untrusted single-line text for insertion into Bot-authored Discord Markdown.
 * Inline delimiters and line-leading heading/list/quote/subtext syntax are neutralized while
 * ordinary punctuation remains readable. The output limit is applied after escaping without
 * splitting surrogate pairs or escape sequences.
 */
export function sanitizeDiscordMarkdownText(
  value,
  { maxLength, neutralizeMentions = true } = {},
) {
  if (!Number.isInteger(maxLength) || maxLength < 1) {
    throw new TypeError('maxLength must be a positive integer');
  }
  const normalized = normalizedVisibleText(value, neutralizeMentions);
  const leadingEscapeIndex = lineLeadingEscapeIndex(normalized);
  let result = '';
  let offset = 0;
  for (const character of normalized) {
    const shouldEscape = MARKDOWN_DELIMITERS.has(character) || offset === leadingEscapeIndex;
    const token = shouldEscape ? `\\${character}` : character;
    if (result.length + token.length > maxLength) break;
    result += token;
    offset += character.length;
  }
  return result;
}
