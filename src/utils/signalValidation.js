function validateSignalPayload(content, contentType) {
  const allowedTypes = ['SIGNAL_ENCRYPTED', 'SIGNAL_KEY_DISTRIBUTION'];
  
  if (contentType && !allowedTypes.includes(contentType)) {
    throw new Error(`Invalid contentType. Allowed: ${allowedTypes.join(', ')}`);
  }

  // Base64 Check: If it claims to be encrypted, it MUST be valid Base64
  // Regex explains: 
  // ^[A-Za-z0-9+/]* -> Standard Base64 characters
  // ={0,2}$           -> Optional padding at the end
  // (str.length % 4)  -> Base64 strings are always a multiple of 4
  const isBase64 = (str) => {
    const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
    return str && (str.length % 4 === 0) && base64Regex.test(str);
  };

  // If we are sending an encrypted blob, verify structure
  if (contentType === 'SIGNAL_ENCRYPTED' || !contentType) { 
    // (!contentType handles the 'edit_message' case where we assume encryption)
    if (!isBase64(content)) {
      throw new Error('Security Error: Encrypted content must be a valid Base64 string');
    }
  }
}

module.exports = {
  validateSignalPayload,
};