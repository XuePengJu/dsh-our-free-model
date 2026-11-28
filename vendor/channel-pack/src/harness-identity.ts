/**
 * Compatibility for the two default host identity sentences rejected by the
 * Qoder/Gemini system-prompt paths (#931/#902). Change only that literal;
 * user/assistant/tool content and every surrounding instruction stay intact.
 */
export function compatibleHarnessIdentity(text: string): string {
  return text.replace(/You are an AI agent,? powered by DeepSeek Harness\./g,
    'You are an AI assistant.')
}

export function compatibleHarnessPromptMessage<T extends { role: string; content?: unknown }>(message: T): T {
  if (message.role !== 'system' && message.role !== 'developer') return message
  const content = message.content
  if (typeof content === 'string') {
    const text = compatibleHarnessIdentity(content)
    return text === content ? message : { ...message, content: text }
  }
  if (!Array.isArray(content)) return message
  let changed = false
  const parts = content.map(part => {
    if (part === null || typeof part !== 'object' || part.type !== 'text' || typeof part.text !== 'string') return part
    const text = compatibleHarnessIdentity(part.text)
    if (text === part.text) return part
    changed = true
    return { ...part, text }
  })
  return changed ? { ...message, content: parts } : message
}
