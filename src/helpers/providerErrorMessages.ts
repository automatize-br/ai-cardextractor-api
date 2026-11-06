export interface ProviderErrorContext {
  provider: string
  model: string
  baseUrl: string
}

function isModelError(status: number, detail: string): boolean {
  return (
    status === 404 ||
    /model[^.]{0,40}(not found|unavailable|does not exist|invalid)/i.test(detail) ||
    /no such model/i.test(detail)
  )
}

/**
 * Traduz erros crus do provider para uma ação concreta. O detalhe técnico fica
 * em `details` (log), não na mensagem mostrada ao usuário.
 */
export function humanizeProviderError(
  status: number,
  detail: string,
  context: ProviderErrorContext,
): string {
  const model = context.model || 'modelo configurado'
  const baseUrl = context.baseUrl || 'URL configurada'
  const opencode = /(^|\.)opencode\.ai$/i.test(safeHost(baseUrl))

  if (status === 401 || status === 403) {
    return opencode
      ? 'A API key foi recusada. Confira se ela pertence ao container correto: OpenCode Go usa https://opencode.ai/inference/go/openai/v1; Console usa https://opencode.ai/inference/openai/v1. Ex.: chave oc_sk_... + modelo deepseek-v4.1-flash no Go.'
      : `A credencial do provider foi recusada. Confira a API key em ${baseUrl}. Ex.: se o provider não exigir chave (Ollama/llama.cpp), deixe o campo vazio.`
  }

  if (status === 402) {
    return opencode
      ? 'Sua conta/plano do OpenCode não tem saldo ou limite para este modelo. Verifique o plano Go/Console ou escolha outro modelo. Ex.: deepseek-v4.1-flash.'
      : 'O provider informou falta de saldo/limite. Verifique o plano ou os créditos da conta.'
  }

  if (status === 429) {
    return 'O provider limitou a quantidade de requisições. Aguarde alguns instantes ou troque de modelo. Ex.: use deepseek-v4.1-flash no OpenCode Go.'
  }

  if (isModelError(status, detail)) {
    return `O modelo "${model}" não está disponível neste provider/container. Use o model id exato — por exemplo "deepseek-v4.1-flash" no OpenCode Go — e confirme o plano/região e a URL base (${baseUrl}).`
  }

  if (status >= 500) {
    return `O provider está indisponível agora (HTTP ${status}). Tente novamente em instantes ou troque de container/modelo. Ex.: OpenCode Go com deepseek-v4.1-flash.`
  }

  return `O provider recusou a requisição (HTTP ${status}). Confira o model id "${model}", a URL base (${baseUrl}) e se o endpoint é OpenAI-compatible. Ex.: base .../v1 + modelo deepseek-v4.1-flash.`
}

function safeHost(baseUrl: string): string {
  try {
    return new URL(baseUrl.replace(/\/+$/, '')).hostname
  } catch {
    return ''
  }
}
