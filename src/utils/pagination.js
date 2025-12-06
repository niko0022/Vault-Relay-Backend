// src/utils/pagination.js
// Cursor helpers (base64url JSON tokens) and Prisma where-clauses for cursor pagination.

function base64urlEncode(str) {
  return Buffer.from(str, 'utf8').toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64urlDecode(token) {
  if (typeof token !== 'string') return null;
  let b64 = token.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4;
  if (pad === 2) b64 += '==';
  else if (pad === 3) b64 += '=';
  else if (pad === 1) return null;
  try {
    return Buffer.from(b64, 'base64').toString('utf8');
  } catch (e) {
    return null;
  }
}

// parse cursor param which may be either a base64url token of {id, createdAt} or raw id string.
// Returns either { id, createdAt } where createdAt is an ISO string, or null for invalid.
function parseCursorParam(cursorParam) {
  if (!cursorParam) return null;
  // try decode as base64url JSON
  let decoded = base64urlDecode(cursorParam);
  if (decoded) {
    try {
      const obj = JSON.parse(decoded);
      // Validate id
      if (!obj || !obj.id) return null;
      // createdAt might be a string or number; keep it as ISO string for Prisma DateTime comparisons
      const createdAt = obj.createdAt ? new Date(obj.createdAt).toISOString() : null;
      return { id: obj.id, createdAt };
    } catch (e) {
      // fall through to treating as raw id
    }
  }
  // otherwise treat as raw id
  return { id: cursorParam };
}

// Make a base64url cursor token from { id, createdAt }
function makeCursorToken({ id, createdAt }) {
  if (!id || !createdAt) throw new Error('makeCursorToken requires {id, createdAt}');
  const json = JSON.stringify({ id, createdAt });
  return base64urlEncode(json);
}

// For Prisma queries: return a where object that selects rows older than the supplied cursor.
function olderThanCursorWhere(cursorObj, createdAtField = 'createdAt', idField = 'id') {
  if (!cursorObj) return {};
  const { id, createdAt } = cursorObj;
  if (!id && !createdAt) return {};

  if (createdAt) {
    const createdAtDate = new Date(createdAt).toISOString();
    return {
      OR: [
        { [createdAtField]: { lt: createdAtDate } },
        {
          AND: [
            { [createdAtField]: createdAtDate },
            { [idField]: { lt: id } },
          ],
        },
      ],
    };
  }

  // fallback: only id provided
  return { [idField]: { lt: id } };
}

module.exports = { olderThanCursorWhere, parseCursorParam, makeCursorToken, base64urlEncode, base64urlDecode };
