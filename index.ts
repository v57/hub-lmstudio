import { Service } from 'hub-service'

type ChatMessage = {
  role: string
  content: unknown
  [key: string]: unknown
}

type LocalChatRequest = {
  model: string
  messages: ChatMessage[]
  stream?: boolean
  options?: Record<string, unknown>
  keep_alive?: unknown
  [key: string]: unknown
}

type PostRequest = LocalChatRequest & { stream?: false }
type StreamRequest = LocalChatRequest & { stream?: true }

const baseUrl = (Bun.env.LMSTUDIO_BASE_URL ?? 'http://localhost:1234/v1').replace(/\/+$/, '')
const apiKey = Bun.env.LMSTUDIO_API_KEY
const streamDone = Symbol('streamDone')

function lmStudioUrl(path: string) {
  return `${baseUrl}/${path.replace(/^\/+/, '')}`
}

async function requestLmStudio(path: string, init: RequestInit) {
  const response = await fetch(lmStudioUrl(path), {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      ...init.headers,
    },
  })

  if (!response.ok) {
    const text = await response.text()
    const suffix = text ? `: ${text.slice(0, 2048)}` : ''
    throw new Error(`LM Studio request failed with HTTP ${response.status}${suffix}`)
  }

  return response
}

function chatBody(body: LocalChatRequest, stream: boolean) {
  const { options, keep_alive: _keepAlive, stream: _stream, ...request } = body
  const next: Record<string, unknown> = { ...request, stream }

  if (options) {
    for (const [key, value] of Object.entries(options)) {
      next[key] ??= value
    }
  }

  return next
}

function parseStreamLine(rawLine: string): unknown | typeof streamDone | undefined {
  const line = rawLine.trim()
  if (!line || line.startsWith(':')) return
  if (!line.startsWith('data:')) return

  const data = line.slice(5).trim()
  if (data === '[DONE]') return streamDone
  return JSON.parse(data)
}

async function* streamChat(body: StreamRequest) {
  const response = await requestLmStudio('chat/completions', {
    method: 'POST',
    body: JSON.stringify(chatBody(body, true)),
  })

  if (!response.body) {
    throw new Error('LM Studio response did not include a stream body.')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })

    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''

    for (const rawLine of lines) {
      const chunk = parseStreamLine(rawLine)
      if (chunk === streamDone) return
      if (chunk !== undefined) yield chunk
    }

    if (done) break
  }

  const chunk = parseStreamLine(buffer)
  if (chunk !== undefined && chunk !== streamDone) yield chunk
}

new Service({
  address: process.argv[2],
  name: 'LM Studio Service',
  icon: { symbol: 'apple.intelligence', text: 'LLM' },
})
  .post(
    'llm/local',
    async (body: PostRequest) => {
      const response = await requestLmStudio('chat/completions', {
        method: 'POST',
        body: JSON.stringify(chatBody(body, false)),
      })
      return await response.json()
    },
    { limit: 4 },
  )
  .stream(
    'llm/local',
    async function* (body: StreamRequest) {
      for await (const chunk of streamChat(body)) {
        yield chunk
      }
    },
    { limit: 4 },
  )
  .post('llm/list', async () => {
    const response = await requestLmStudio('models', { method: 'GET' })
    return await response.json()
  })
  .start()
