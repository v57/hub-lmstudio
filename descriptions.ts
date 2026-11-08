/**
 * What a path says about itself in `hub/api/list` (protocol.md section 15): passed in the settings of `post` and
 * `stream`, next to `access`. hub-service before descriptions ignores these fields.
 */
export interface Described {
  title?: string
  description: string
  inputSchema?: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }
}
// Typed, not `satisfies`: schema literals would widen to `type: string`, which ApiSettings' JSONSchema doesn't take
export type Descriptions = { post: Record<string, Described>; stream: Record<string, Described> }

// The request takes the shape hub-ollama's llm/local takes (model, messages with role and content, options,
// keep_alive) and is sent to LM Studio's OpenAI-compatible /v1/chat/completions: keep_alive and stream are dropped,
// options' keys move to the top level unless the body already sets them, and every other key passes through.
// Answers are OpenAI's chat completion shapes, not Ollama's.

const toolCall = {
  type: 'object',
  description: 'A function call the model asks for; the caller runs it and answers with a "tool" message',
  properties: {
    id: { type: 'string' },
    type: { type: 'string', const: 'function' },
    function: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of one of the request\'s tools' },
        arguments: { type: 'string', description: 'Arguments, as a JSON string' },
      },
    },
  },
}
const message = {
  type: 'object',
  description: 'One chat message (OpenAI format)',
  properties: {
    role: { type: 'string', description: 'Who wrote it', enum: ['system', 'developer', 'user', 'assistant', 'tool'] },
    content: {
      description: 'Message text, or OpenAI content parts (text, and image_url with a data: URL for vision models)',
      anyOf: [
        { type: 'string' },
        { type: 'array', items: { type: 'object', properties: { type: { type: 'string', enum: ['text', 'image_url'] } }, required: ['type'] } },
        { type: 'null' },
      ],
    },
    tool_calls: { type: 'array', items: toolCall, description: 'Tool calls an assistant message made' },
    tool_call_id: { type: 'string', description: 'In a "tool" message: the call whose result this is' },
  },
  required: ['role', 'content'],
}
const request = {
  type: 'object',
  description: 'Chat request; keys other than options, keep_alive and stream go to /v1/chat/completions as they are',
  properties: {
    model: { type: 'string', description: 'Model id from llm/list' },
    messages: { type: 'array', items: message, description: 'The conversation so far, oldest first' },
    stream: { type: 'boolean', description: 'Ignored: the post answers once and the stream yields chunks' },
    options: {
      type: 'object',
      description: 'Sampling parameters, merged into the request\'s top level unless it sets the same key, so use OpenAI names: temperature, top_p, max_tokens, seed, stop',
    },
    keep_alive: { description: 'Accepted for hub-ollama compatibility and ignored' },
    temperature: { type: 'number', description: 'Sampling temperature; higher is more random' },
    max_tokens: { type: 'integer', description: 'Most tokens to generate; -1 for no limit' },
    tools: { type: 'array', items: { type: 'object' }, description: 'Functions the model may call, OpenAI format' },
    response_format: { type: 'object', description: 'OpenAI structured output, like { type: "json_schema", json_schema: {...} }' },
  },
  required: ['model', 'messages'],
}
const usage = {
  type: 'object',
  properties: {
    prompt_tokens: { type: 'integer' },
    completion_tokens: { type: 'integer' },
    total_tokens: { type: 'integer' },
  },
}
const assistant = {
  type: 'object',
  properties: {
    role: { type: 'string' },
    content: { type: ['string', 'null'], description: 'Reply text, or the next piece of it in a chunk\'s delta' },
    reasoning_content: { type: 'string', description: 'The model\'s reasoning, for thinking models' },
    tool_calls: { type: 'array', items: toolCall },
  },
}
const completion = (chunk: boolean) => ({
  type: 'object',
  description: chunk
    ? 'One OpenAI chat.completion.chunk: the next piece of the reply in choices[0].delta; the last carries a finish_reason'
    : 'OpenAI chat.completion: the reply in choices[0].message, with token usage',
  properties: {
    id: { type: 'string' },
    object: { type: 'string', const: chunk ? 'chat.completion.chunk' : 'chat.completion' },
    created: { type: 'integer', description: 'Unix seconds' },
    model: { type: 'string' },
    choices: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          [chunk ? 'delta' : 'message']: assistant,
          finish_reason: { type: ['string', 'null'], description: 'Why it stopped, like "stop", "length" or "tool_calls"' },
        },
      },
    },
    usage,
  },
  required: ['id', 'object', 'created', 'model', 'choices'],
})

export const descriptions: Descriptions = {
  post: {
    'llm/local': {
      title: 'Chat with a local model',
      description:
        'Runs a chat completion on this device\'s LM Studio and answers with the whole reply in OpenAI\'s chat.completion shape. Fails with "LM Studio request failed with HTTP <status>" when LM Studio isn\'t running or rejects the request; the hub runs at most 4 at once per provider. Needs a grant of llm/local.',
      inputSchema: request,
      outputSchema: completion(false),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    'llm/list': {
      title: 'List local models',
      description:
        'Lists the models this device\'s LM Studio offers (its /v1/models), in OpenAI\'s list shape. Use an id from it as the model of llm/local. Needs a grant of llm/list.',
      outputSchema: {
        type: 'object',
        description: 'OpenAI model list',
        properties: {
          object: { type: 'string', const: 'list' },
          data: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Model id to pass to llm/local' },
                object: { type: 'string', const: 'model' },
                owned_by: { type: 'string' },
              },
              required: ['id'],
            },
          },
        },
        required: ['data'],
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
  },
  stream: {
    'llm/local': {
      title: 'Stream a chat with a local model',
      description:
        'Runs a chat completion on this device\'s LM Studio and yields the reply as it is generated, one OpenAI chat.completion.chunk per value, ending at LM Studio\'s [DONE]. Fails like the post; the hub runs at most 4 at once per provider. Needs a grant of llm/local.',
      inputSchema: request,
      outputSchema: completion(true),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
  },
}
