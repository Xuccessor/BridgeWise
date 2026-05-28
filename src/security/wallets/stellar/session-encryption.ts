import * as crypto from 'crypto';

export interface EncryptedSession {
  iv: string;
  authTag: string;
  content: string;
}

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

/**
 * Validates the encryption key to ensure it is the correct length (32 bytes).
 */
function validateKey(key: string): Buffer {
  const keyBuffer = Buffer.from(key, 'utf8');
  if (keyBuffer.length !== 32) {
    throw new Error('Invalid key length. Key must be exactly 32 bytes for AES-256-GCM.');
  }
  return keyBuffer;
}

/**
 * Encrypts session data securely using AES-256-GCM.
 * @param sessionData The session data to encrypt (e.g. JSON string).
 * @param secretKey A 32-byte secret key string.
 * @returns An EncryptedSession object containing the encrypted content, IV, and authTag.
 */
export function encryptSessionData(sessionData: string, secretKey: string): EncryptedSession {
  const keyBuffer = validateKey(secretKey);
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, keyBuffer, iv);
  
  let encrypted = cipher.update(sessionData, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  return {
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    content: encrypted,
  };
}

/**
 * Decrypts an encrypted session back into the original data.
 * @param encryptedSession The session object containing IV, authTag, and content.
 * @param secretKey The 32-byte secret key string used for encryption.
 * @returns The decrypted session data.
 */
export function decryptSessionData(encryptedSession: EncryptedSession, secretKey: string): string {
  const keyBuffer = validateKey(secretKey);
  
  const ivBuffer = Buffer.from(encryptedSession.iv, 'hex');
  const authTagBuffer = Buffer.from(encryptedSession.authTag, 'hex');
  
  if (authTagBuffer.length !== AUTH_TAG_LENGTH) {
    throw new Error('Invalid authentication tag length.');
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, keyBuffer, ivBuffer);
  decipher.setAuthTag(authTagBuffer);

  let decrypted = decipher.update(encryptedSession.content, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}
