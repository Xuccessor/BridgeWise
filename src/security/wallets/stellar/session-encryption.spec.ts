import { encryptSessionData, decryptSessionData, EncryptedSession } from './session-encryption';

describe('Soroban Wallet Session Encryption', () => {
  const validSecretKey = '12345678901234567890123456789012'; // 32 bytes
  const invalidSecretKey = 'too-short';
  const sessionData = JSON.stringify({
    walletId: 'soroban-wallet-123',
    account: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ',
    network: 'testnet',
  });

  it('should encrypt and decrypt session data successfully', () => {
    const encrypted = encryptSessionData(sessionData, validSecretKey);
    
    expect(encrypted).toHaveProperty('iv');
    expect(encrypted).toHaveProperty('authTag');
    expect(encrypted).toHaveProperty('content');
    
    expect(encrypted.iv.length).toBeGreaterThan(0);
    expect(encrypted.authTag.length).toBeGreaterThan(0);
    expect(encrypted.content.length).toBeGreaterThan(0);

    const decrypted = decryptSessionData(encrypted, validSecretKey);
    expect(decrypted).toBe(sessionData);
  });

  it('should throw an error if the secret key is not 32 bytes', () => {
    expect(() => {
      encryptSessionData(sessionData, invalidSecretKey);
    }).toThrow('Invalid key length');

    expect(() => {
      decryptSessionData({ iv: 'a', authTag: 'b', content: 'c' }, invalidSecretKey);
    }).toThrow('Invalid key length');
  });

  it('should fail to decrypt with the wrong key', () => {
    const encrypted = encryptSessionData(sessionData, validSecretKey);
    const wrongKey = '09876543210987654321098765432109'; // 32 bytes but different
    
    expect(() => {
      decryptSessionData(encrypted, wrongKey);
    }).toThrow(); // Will likely throw a bad decrypt or auth tag error
  });

  it('should fail to decrypt if auth tag is manipulated (tampering)', () => {
    const encrypted = encryptSessionData(sessionData, validSecretKey);
    
    // Modify auth tag by changing one character
    const tamperedAuthTag = encrypted.authTag.substring(0, encrypted.authTag.length - 1) + 
                            (encrypted.authTag.endsWith('a') ? 'b' : 'a');
    
    const tamperedSession = { ...encrypted, authTag: tamperedAuthTag };
    
    expect(() => {
      decryptSessionData(tamperedSession, validSecretKey);
    }).toThrow(); // Should throw auth tag validation error
  });

  it('should produce different encrypted content for the same input (due to random IV)', () => {
    const encrypted1 = encryptSessionData(sessionData, validSecretKey);
    const encrypted2 = encryptSessionData(sessionData, validSecretKey);
    
    expect(encrypted1.iv).not.toBe(encrypted2.iv);
    expect(encrypted1.content).not.toBe(encrypted2.content);
  });
});
