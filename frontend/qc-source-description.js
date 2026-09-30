const NUMBERED_POINT_MARKER = /(\d+)(?:\.(?!\d)|(?=\p{Script=Han}))/gu;
const MARKER_BOUNDARY = /[\s,，;；:：.!?。！？]/u;

/** Add presentation-only line breaks before a sequential numbered source point. */
export function formatNumberedDescription(value) {
  const source = value == null ? "" : String(value);
  const points = [];
  let expectedNumber = 1;

  NUMBERED_POINT_MARKER.lastIndex = 0;
  for (const match of source.matchAll(NUMBERED_POINT_MARKER)) {
    const start = match.index;
    const preceding = start === 0 ? "" : source[start - 1];
    if (preceding && !MARKER_BOUNDARY.test(preceding)) continue;

    const number = Number(match[1]);
    if (number !== expectedNumber) continue;
    points.push({ start });
    expectedNumber += 1;
  }

  if (points.length < 2) return source;

  const edits = [];
  for (const { start } of points) {
    if (start === 0) continue;
    let whitespaceStart = start;
    while (whitespaceStart > 0 && /\s/u.test(source[whitespaceStart - 1])) whitespaceStart -= 1;
    edits.push({ start: whitespaceStart, end: start, replacement: "\n" });
  }

  let result = "";
  let cursor = 0;
  for (const edit of edits) {
    result += source.slice(cursor, edit.start) + edit.replacement;
    cursor = edit.end;
  }
  return result + source.slice(cursor);
}
