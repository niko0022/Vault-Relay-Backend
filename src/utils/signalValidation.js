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

  // If we are sending an encrypted blob, verify structure from WASM bridge
  // The WASM bridge returns { type: number, body: Uint8Array | Array }
  if (contentType === 'SIGNAL_ENCRYPTED' || !contentType) { 
    if (typeof content === 'string') {
      if (!isBase64(content)) {
        throw new Error('Security Error: Encrypted string content must be a valid Base64 string');
      }
    } else if (typeof content === 'object' && content !== null) {
      if (typeof content.type !== 'number' || !content.body) {
        throw new Error('Security Error: Encrypted object content must have {type: number, body: [...]} structure');
      }
    } else {
      throw new Error('Security Error: Encrypted content format unrecognized');
    }
  }
}

module.exports = {
  validateSignalPayload,
};