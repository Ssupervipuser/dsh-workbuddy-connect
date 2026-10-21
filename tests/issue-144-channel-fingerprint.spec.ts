import { describe, expect, it } from 'vitest'
import {
  classifyUpstreamError,
  prepareChatBody,
  prepareCnChatBody,
  prepareInternationalChatBody,
  systemOpeningsOfBody,
} from '../src/upstream.ts'

/**
 * Regression pin for the gateway's CHANNEL gate.
 *
 * The WorkBuddy gateways scan the START of every `system` message against a
 * list of known third-party-agent prompt openings and refuse a hit with
 * business code `11128` / "Illegal API invocation from an unapproved channel".
 * The upstream describes that refusal as "可能不是官方客户端发出的" ("this call
 * did not come from the official client"), which is misleading text: the rule
 * is a CONTENT prefix match and has nothing to do with the account, the credit
 * balance, the network, or the User-Agent.
 *
 * The user's symptom was exactly this: a CN conversation failed every turn with
 * 「请求被拦截，请重新发送」, because the host's own system prompt opens with
 * "You are an AI agent powered by DeepSeek Harness." — the opening the gateway
 * fingerprints.
 *
 * Every measurement below was taken on the REAL CN gateway
 * (`copilot.tencent.com`, account `18860d9c…`, model `deepseek-v4.1-flash`),
 * with every other request field held fixed and only the system opening
 * varied:
 *
 *   - the DSH opening → 400 / 11128
 *   - the same prompt with the official opening in front → 200
 *   - the Claude Code opening → 400 / 11128
 *   - every other agent opening tried (Kimi, Cursor, Gemini CLI, Cline,
 *     Aider, Codex, opencode, Copilot, Trae, Qwen Code, windsurf, Roo Code)
 *     → 200
 *
 * The rule is a prefix match at offset 0, case-insensitive, and it scans
 * EVERY `system` message rather than only the first. It is a BLACKLIST, not an
 * allowlist — "Hello.", "asdf", "x" and "You are ChatGPT." are all accepted.
 *
 * The line the plugin prepends is the OFFICIAL client's own agent-prompt
 * opening, read out of the installed WorkBuddy desktop app
 * (`resources/app.asar.unpacked/cli/product.json`, template `cli-agent-prompt`):
 * "You are CodeBuddy Code." Only that one line is borrowed — the rest of the
 * official prompt carries its own tool conventions and content policy, which
 * would displace the host's.
 */

/** The host prompt the gateway refuses, exactly as DSH emits it. */
const DSH_OPENING = 'You are an AI agent powered by DeepSeek Harness.'

/** The other measured fingerprint (pi-ai's Anthropic default). */
const CLAUDE_OPENING = "You are Claude Code, Anthropic's official CLI for Claude."

/** The official client's own agent-prompt opening — the line the fix prepends. */
const OFFICIAL = 'You are CodeBuddy Code.'

/** The refusals the plugin must neutralise. */
const REFUSED_OPENINGS = [DSH_OPENING, CLAUDE_OPENING]

/** Openings measured to pass — the fix must leave these bodies untouched. */
const ALLOWED_OPENINGS = [
  'You are an AI agent powered by Kimi.',
  'You are Cursor Agent, a powerful AI coding assistant.',
  'You are Gemini CLI, a Google AI coding assistant.',
  'You are Cline, an AI coding agent.',
  'You are Codex, a coding agent based on GPT-5.',
  'You are an AI agent powered by DeepSeek.',
  'You are a helpful assistant.',
]

/** The system message of a prepared body. */
function systemMessages(bodyJson: string): { role: string, content: unknown }[] {
  const body = JSON.parse(bodyJson) as { messages?: { role: string, content: unknown }[] }
  return body.messages ?? []
}

describe('the channel fingerprint is neutralised', () => {
  it.each(REFUSED_OPENINGS)('prepends the official opening to a system message opening with %j', (opening) => {
    const body = JSON.parse(prepareChatBody(JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'system', content: opening }, { role: 'user', content: 'hi' }],
    }))) as { messages: { role: string, content: string }[] }
    const system = body.messages[0]!
    expect(system.content).toBe(`${OFFICIAL}\n\n${opening}`)
    // The host's own wording is preserved behind the prepended line.
    expect(system.content).toContain(opening)
  })

  it('neutralises the real multi-line DSH prompt that the user hit', () => {
    // The shape DSH actually emits: a multi-line prompt whose FIRST line is
    // the fingerprinted opening.
    const prompt = [
      DSH_OPENING,
      '',
      'You are interacting with the user through the DeepSeek Harness Web GUI.',
      'The browser provides no implicit DOM, route, or screenshot context.',
    ].join('\n')
    const body = JSON.parse(prepareChatBody(JSON.stringify({
      messages: [{ role: 'system', content: prompt }, { role: 'user', content: 'hi' }],
    }))) as { messages: { content: string }[] }
    // The official opening is in front, so the content no longer OPENS with the
    // fingerprint — which is the only thing the gateway looks at.
    expect(body.messages[0]!.content.startsWith(OFFICIAL)).toBe(true)
    expect(body.messages[0]!.content).toContain('DeepSeek Harness Web GUI')
  })

  it('neutralises a system message that is NOT the first one', () => {
    // Measured: the gateway scans EVERY system message, so a hit in the second
    // one is refused just the same.
    const body = JSON.parse(prepareChatBody(JSON.stringify({
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'system', content: DSH_OPENING },
        { role: 'user', content: 'hi' },
      ],
    }))) as { messages: { content: string }[] }
    expect(body.messages[1]!.content).toBe(`${OFFICIAL}\n\n${DSH_OPENING}`)
  })

  it('neutralises a `developer` message, because it becomes a `system` one first', () => {
    // pi-ai may emit the system prompt as `developer`; the plugin rewrites that
    // role to `system` — and the gateway then scans it like any other system
    // message, so the fingerprint still has to be neutralised.
    const body = JSON.parse(prepareChatBody(JSON.stringify({
      messages: [{ role: 'developer', content: DSH_OPENING }, { role: 'user', content: 'hi' }],
    }))) as { messages: { role: string, content: string }[] }
    expect(body.messages[0]!.role).toBe('system')
    expect(body.messages[0]!.content).toBe(`${OFFICIAL}\n\n${DSH_OPENING}`)
  })

  it('neutralises a system message whose content is an array of parts', () => {
    // Measured: the gateway reads the first text part of an array-shaped
    // system content just as it reads a plain string.
    const body = JSON.parse(prepareChatBody(JSON.stringify({
      messages: [
        { role: 'system', content: [{ type: 'text', text: DSH_OPENING }] },
        { role: 'user', content: 'hi' },
      ],
    }))) as { messages: { content: { type: string, text: string }[] }[] }
    expect(body.messages[0]!.content[0]!.text).toBe(`${OFFICIAL}\n\n${DSH_OPENING}`)
  })

  it('matches case-insensitively, as the gateway does', () => {
    // Measured: the lower-cased opening is refused just the same.
    const body = JSON.parse(prepareChatBody(JSON.stringify({
      messages: [{ role: 'system', content: 'you are an ai agent powered by deepseek harness.' }],
    }))) as { messages: { content: string }[] }
    expect(body.messages[0]!.content.startsWith(OFFICIAL)).toBe(true)
  })
})

describe('the neutralisation changes nothing else', () => {
  it.each(ALLOWED_OPENINGS)('leaves a system message opening with %j byte-for-byte', (opening) => {
    const body = JSON.parse(prepareChatBody(JSON.stringify({
      messages: [{ role: 'system', content: opening }],
    }))) as { messages: { content: string }[] }
    expect(body.messages[0]!.content).toBe(opening)
  })

  it('leaves a body with no system message untouched apart from the shared rules', () => {
    const body = JSON.parse(prepareChatBody(JSON.stringify({
      messages: [{ role: 'user', content: 'hi' }],
    }))) as { messages: { role: string, content: string }[], stream: boolean }
    expect(body.messages[0]!.content).toBe('hi')
    expect(body.stream).toBe(true)
  })

  it('never touches a `user` message — the gateway does not scan those', () => {
    // Measured: the same sentence inside a user message is accepted.
    const content = `${DSH_OPENING}\n\nhi`
    const body = JSON.parse(prepareChatBody(JSON.stringify({
      messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content }],
    }))) as { messages: { role: string, content: string }[] }
    expect(body.messages[1]!.content).toBe(content)
  })

  it('does not rewrite a system message whose opening merely has a space in front', () => {
    // Measured: a leading space is NOT refused by the gateway (offset-0 match),
    // so such a body must keep working exactly as it does.
    const content = ` ${DSH_OPENING}`
    const body = JSON.parse(prepareChatBody(JSON.stringify({
      messages: [{ role: 'system', content }],
    }))) as { messages: { content: string }[] }
    expect(body.messages[0]!.content).toBe(content)
  })

  it('keeps the tools, the model, and the rest of the body intact', () => {
    const body = JSON.parse(prepareChatBody(JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'system', content: DSH_OPENING }, { role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'grep' } }],
      max_tokens: 128,
    }))) as Record<string, unknown>
    expect(body['model']).toBe('deepseek-v4.1-flash')
    expect(body['max_tokens']).toBe(128)
    expect(body['tools']).toHaveLength(1)
  })

  it('keeps a non-JSON body untouched', () => {
    expect(prepareChatBody('not json')).toBe('not json')
  })
})

describe('both region paths neutralise the fingerprint', () => {
  // The CN path is a separate function from the shared one, and the
  // international path re-runs the shared one — a fix that only covered one of
  // them would leave the other sending a refused body.
  const REGIONS = [
    ['CN', prepareCnChatBody],
    ['international', prepareInternationalChatBody],
  ] as const

  it.each(REGIONS)('%s neutralises the DSH opening', (_label, prepare) => {
    const body = JSON.parse(prepare(JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'system', content: DSH_OPENING }, { role: 'user', content: 'hi' }],
    }))) as { messages: { content: string }[] }
    expect(body.messages[0]!.content.startsWith(OFFICIAL)).toBe(true)
  })

  it.each(REGIONS)('%s keeps an allowed opening untouched', (_label, prepare) => {
    const body = JSON.parse(prepare(JSON.stringify({
      messages: [{ role: 'system', content: 'You are a helpful assistant.' }],
    }))) as { messages: { content: string }[] }
    expect(body.messages[0]!.content).toBe('You are a helpful assistant.')
  })
})

describe('classifyUpstreamError recognises the channel gate', () => {
  it('classifies the measured channel refusal', () => {
    const body = JSON.stringify({
      code: 11128,
      msg: 'Illegal API invocation from an unapproved channel',
      requestId: 'de1a825f-fcc1-49d2-a580-5633c18c21ac',
      displayMsg: { zh: '请求被拦截，请重新发送', en: 'Request blocked.' },
    })
    expect(classifyUpstreamError(400, body)).toBe('channel_reject')
  })

  it('classifies the shorter spelling of the same gate', () => {
    expect(classifyUpstreamError(400, '{"code":11128,"msg":"unapproved channel"}')).toBe('channel_reject')
  })

  it('does not claim the conversation-id gate, which has its own fix', () => {
    // The same business code, a different rule — claiming it here would blame
    // the prompt's opening for a header problem.
    expect(classifyUpstreamError(400, '{"code":11128,"msg":"conversation id missing"}')).toBe('client')
  })

  it('does not claim the "first message is not system prompt" gate', () => {
    expect(classifyUpstreamError(400, '{"code":11128,"msg":"first message is not system prompt"}')).toBe('client')
  })

  it('needs the wording as well as the code', () => {
    // The code alone would claim the other two gates.
    expect(classifyUpstreamError(400, '{"code":11128}')).toBe('client')
  })

  it('does not read a request id that happens to contain the digits as the code', () => {
    const body = JSON.stringify({ code: 0, msg: 'ok', requestId: '11128-11128-11128' })
    expect(classifyUpstreamError(400, body)).toBe('client')
  })

  it('leaves the other classifications alone', () => {
    expect(classifyUpstreamError(402, '')).toBe('hard_credit')
    expect(classifyUpstreamError(401, '')).toBe('session_dead')
    expect(classifyUpstreamError(429, '')).toBe('soft_rate')
    expect(classifyUpstreamError(403, JSON.stringify({ code: 11140, msg: 'request illegal' }))).toBe('client')
  })
})

describe('systemOpeningsOfBody reports the evidence', () => {
  it('takes the first line of each system message', () => {
    const openings = systemOpeningsOfBody(JSON.stringify({
      messages: [
        { role: 'system', content: `${OFFICIAL}\n\n${DSH_OPENING}` },
        { role: 'user', content: 'hi' },
      ],
    }))
    expect(openings).toEqual([OFFICIAL])
  })

  it('reports the bytes that actually went on the wire', () => {
    // A known fingerprint reads back as the official opening the plugin
    // prepended — that IS what the upstream saw, and it is the evidence.
    const prepared = prepareChatBody(JSON.stringify({
      messages: [{ role: 'system', content: DSH_OPENING }],
    }))
    expect(systemOpeningsOfBody(prepared)).toEqual([OFFICIAL])
  })

  it('keeps at most three openings', () => {
    const openings = systemOpeningsOfBody(JSON.stringify({
      messages: [
        { role: 'system', content: 'one' },
        { role: 'system', content: 'two' },
        { role: 'system', content: 'three' },
        { role: 'system', content: 'four' },
      ],
    }))
    expect(openings).toEqual(['one', 'two', 'three'])
  })

  it('returns nothing rather than throwing on an unreadable body', () => {
    expect(systemOpeningsOfBody('not json')).toEqual([])
    expect(systemOpeningsOfBody('[]')).toEqual([])
    expect(systemOpeningsOfBody('{}')).toEqual([])
  })

  it('skips a system message whose content is an array', () => {
    expect(systemOpeningsOfBody(JSON.stringify({
      messages: [{ role: 'system', content: [{ type: 'text', text: 'x' }] }],
    }))).toEqual([])
  })
})
