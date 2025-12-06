const { customAlphabet } = require('nanoid');

const DIGIT_SUFFIX_LEN = 4;
const digitSuffix = customAlphabet('0123456789', DIGIT_SUFFIX_LEN);


function generateByUsername(username) {
  if (!username || typeof username !== 'string') {
    throw new Error('Invalid username for friend code generation');
  }

  // normalize: lowercase, keep only a-z0-9, trim to 12 chars
  const base = String(username)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 12) || 'user';

  return `${base}#${digitSuffix()}`;
}

module.exports = { generateByUsername };
