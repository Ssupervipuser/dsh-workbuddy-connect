import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkBuddyCredential } from '../src/auth.ts'
import { WorkBuddyUpstreamClient } from '../src/upstream.ts'
import type { ChatIdentity } from '../src/client-identity.ts'

/**
 * The chat request must look like the OFFICIAL client's request.
 *
 * The official WorkBuddy desktop app's `applyGatewayHeaders` (read out of the
 * installed app's `resources/app.asar`, `main/server.js`) sends, on every
 * chat request:
 *
 *   X-Conversation-ID, X-Conversation-Request-ID, X-Conversation-Message-ID,
 *   X-Request-ID, acp-connection-id, X-Agent-Intent, X-Agent-Purpose,
 *   x-codebuddy-request, X-IDE-Type, X-IDE-Name, X-IDE-Version,
 *   X-Private-Data, X-Product
 *
 * plus the trace headers `traceparent`, `b3`, `X-B3-TraceId`,
 * `X-B3-ParentSpanId`, `X-B3-SpanId`, `X-B3-Sampled` and `X-Trace-ID`.
 *
 * MEASURED, so the size of this change is honest: none of these headers
 * changes what the gateway answers. The official header set and the plugin's
 * smaller set were sent side by side with an identical body — same answer,
 * same model catalogue, same response headers — and the refusal this plugin
 * fixes is caused by the SYSTEM MESSAGE'S OPENING alone (with the official
 * headers and the raw host prompt, the gateway still answers 400 / 11128).
 *
 * So these headers are ALIGNMENT, not a fix: the plugin's requests are meant
 * to look like the official client's rather than like a different client. The
 * trace ids are random hex, like the official client's, and carry no state.
 */

const CN: WorkBuddyCredential = {
  accessToken: 'at', refreshToken: 'rt', expiresAtMs: 0,
  domain: 'www.codebuddy.cn', uid: 'uid-1', source: 'desktop',
}
const GLOBAL: WorkBuddyCredential = { ...CN, domain: 'www.workbuddy.ai' }

const IDENTITY: ChatIdentity = { clientVersion: '5.8.3', cliVersion: '2.137.1' }

/** The official client's conversation-channel and request-identity headers. */
const OFFICIAL_HEADERS = [
  'X-Conversation-ID',
  'X-Conversation-Request-ID',
  'X-Conversation-Message-ID',
  'X-Request-ID',
  'acp-connection-id',
  'X-Agent-Intent',
  'X-Agent-Purpose',
  'x-codebuddy-request',
  'X-IDE-Type',
  'X-IDE-Name',
  'X-IDE-Version',
  'X-Private-Data',
  'X-Product',
] as const

/** The official client's trace headers. */
const TRACE_HEADERS = [
  'traceparent',
  'b3',
  'X-B3-TraceId',
  'X-B3-ParentSpanId',
  'X-B3-SpanId',
  'X-B3-Sampled',
  'X-Trace-ID',
] as const

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const HEX = /^[0-9a-f]+$/

function client(): WorkBuddyUpstreamClient {
  return new WorkBuddyUpstreamClient({ resolveChatIdentity: async () => IDENTITY })
}

function captureFetch(body: string, ok = true, status = 200) {
  const fetchMock = vi.fn(async () => ({
    ok, status, text: () => Promise.resolve(body),
  } as unknown as Response))
  vi.stubGlobal('fetch', fetchMock)
  const all = () => fetchMock.mock.calls as unknown as [string, RequestInit][]
  return {
    all,
    last: () => {
      expect(fetchMock).toHaveBeenCalled()
      const calls = all()
      return calls[calls.length - 1]!
    },
  }
}

function headersOf(init: RequestInit): Record<string, string> {
  return init.headers as Record<string, string>
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the chat request carries the official client\'s header set', () => {
  it.each(OFFICIAL_HEADERS)('sends %s', async (name) => {
    const wire = captureFetch('{}')
    await client().chatStream(CN, JSON.stringify({
      model: 'm',
      messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }],
    }))
    const headers = headersOf(wire.last()[1])
    expect(headers[name]).toBeDefined()
  })

  it.each(TRACE_HEADERS)('sends the trace header %s', async (name) => {
    const wire = captureFetch('{}')
    await client().chatStream(CN, JSON.stringify({
      model: 'm',
      messages: [{ role: 'system', content: 's' }],
    }))
    expect(headersOf(wire.last()[1])[name]).toBeDefined()
  })

  it('mints a fresh UUID for each request-identity header', async () => {
    const wire = captureFetch('{}')
    const upstream = client()
    const body = JSON.stringify({ model: 'm', messages: [{ role: 'system', content: 's' }] })
    await upstream.chatStream(CN, body)
    const first = headersOf(wire.last()[1])
    await upstream.chatStream(CN, body)
    const second = headersOf(wire.last()[1])
    for (const name of ['X-Conversation-ID', 'X-Request-ID', 'acp-connection-id'] as const) {
      expect(first[name]).toMatch(UUID_V4)
      expect(second[name]).toMatch(UUID_V4)
      expect(second[name]).not.toBe(first[name])
    }
  })

  it('mints fresh trace ids per request', async () => {
    const wire = captureFetch('{}')
    const upstream = client()
    const body = JSON.stringify({ model: 'm', messages: [{ role: 'system', content: 's' }] })
    await upstream.chatStream(CN, body)
    const first = headersOf(wire.last()[1])
    await upstream.chatStream(CN, body)
    const second = headersOf(wire.last()[1])
    expect(first['X-B3-TraceId']).toMatch(HEX)
    expect(second['X-B3-TraceId']).toMatch(HEX)
    expect(second['X-B3-TraceId']).not.toBe(first['X-B3-TraceId'])
    // The official client's shape: a W3C traceparent with the trace id in it.
    expect(first['traceparent']).toBe(`00-${first['X-B3-TraceId']}-${first['X-B3-SpanId']}-01`)
  })

  it('sends the official first-party markers with the official values', async () => {
    const wire = captureFetch('{}')
    await client().chatStream(CN, JSON.stringify({
      model: 'm',
      messages: [{ role: 'system', content: 's' }],
    }))
    const headers = headersOf(wire.last()[1])
    expect(headers['X-Private-Data']).toBe('true')
    expect(headers['X-Agent-Intent']).toBe('craft')
    expect(headers['X-Agent-Purpose']).toBe('conversation')
    expect(headers['x-codebuddy-request']).toBe('1')
    expect(headers['X-IDE-Type']).toBe('WorkBuddy')
    expect(headers['X-IDE-Name']).toBe('WorkBuddy')
    expect(headers['X-Product']).toBe('SaaS')
  })

  it('sends the same set on the international chat, so the paths cannot drift', async () => {
    const wire = captureFetch('{}')
    await client().chatStream(GLOBAL, JSON.stringify({
      model: 'm',
      messages: [{ role: 'system', content: 's' }],
    }))
    const headers = headersOf(wire.last()[1])
    for (const name of OFFICIAL_HEADERS) expect(headers[name]).toBeDefined()
    for (const name of TRACE_HEADERS) expect(headers[name]).toBeDefined()
  })
})

describe('the official header set stays off every other endpoint (blast-radius pin)', () => {
  it('refresh never carries the first-party or trace headers', async () => {
    const wire = captureFetch(JSON.stringify({ code: 0, msg: 'ok', data: { accessToken: 'next' } }))
    await client().refreshToken(CN)
    for (const [, init] of wire.all()) {
      const headers = headersOf(init)
      for (const name of ['X-Private-Data', 'X-Agent-Intent', 'acp-connection-id', 'traceparent']) {
        expect(headers[name]).toBeUndefined()
      }
    }
  })

  it('the effort probe shares the chat rule', async () => {
    const wire = captureFetch('{"code":11150,"msg":"no"}', false, 400)
    await client().probeEffort(GLOBAL, 'model-x', 'low', new AbortController().signal)
    const headers = headersOf(wire.last()[1])
    for (const name of OFFICIAL_HEADERS) expect(headers[name]).toBeDefined()
  })
})
