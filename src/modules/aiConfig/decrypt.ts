import crypto from 'node:crypto'

// ============================================================================
// Decifra credenciais gravadas pela API central em tb_aiextractorconfigs.
// Formato: v1:<iv b64>:<authTag b64>:<cipher b64> (AES-256-GCM, chave =
// SHA-256(CREDENTIALS_ENC_KEY)). O authTag garante integridade: payload
// adulterado ou chave trocada falha aqui.
// ============================================================================

const ALGORITHM = 'aes-256-gcm'

export function decryptSecretWithKey(payload: string, credentialsKey: string): string {
  if (credentialsKey === '') throw new Error('CREDENTIALS_ENC_KEY não configurada')
  const [version, ivB64, tagB64, dataB64] = payload.split(':')
  if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) {
    throw new Error('payload de credencial em formato inválido')
  }
  const key = crypto.createHash('sha256').update(credentialsKey).digest()
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'))
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    throw new Error('falha ao decifrar a API key (CREDENTIALS_ENC_KEY diferente ou payload adulterado)')
  }
}
