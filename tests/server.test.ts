import { describe, expect, it } from 'vitest'
import { McpServer, type Tool } from '../src/server'
import { validate } from '../src/schema'

const echo: Tool<{ user: string }> = {
  name: 'echo', title: 'Echo', description: 'Says it back',
  inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 10 } }, required: ['text'], additionalProperties: false },
  async run(args, ctx) { return { content: [{ type: 'text', text: `${ctx.user}: ${args.text}` }] } },
}

function server(now = () => 1_000_000) {
  return new McpServer<{ user: string }>({
    info: { name: 't', title: 'T', version: '1' }, instructions: 'hi', tools: [echo], secret: 'test-secret', now,
    allowOrigin: (o) => o === 'https://good.example',
    async context(req) {
      const a = req.headers.get('Authorization')
      if (!a) throw new Error('no key')
      return { user: a.slice(7) }
    },
  })
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('https://x/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) })

async function init(s: ReturnType<typeof server>, version = '2025-11-25') {
  const res = await s.handle(post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'c', version: '1' } } }))
  return { res, sid: res.headers.get('MCP-Session-Id')!, body: await res.json() as { result: { protocolVersion: string; capabilities: unknown; serverInfo: { name: string }; instructions: string } } }
}

describe('MCP Streamable HTTP, spec 2025-11-25', () => {
  it('initializes with the asked version, a session id of visible ASCII, the tools capability and instructions', async () => {
    const { res, sid, body } = await init(server())
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/json')
    expect(sid).toMatch(/^[\x21-\x7e]+$/)
    expect(body.result.protocolVersion).toBe('2025-11-25')
    expect(body.result.capabilities).toEqual({ tools: { listChanged: false } })
    expect(body.result.serverInfo.name).toBe('t')
    expect(body.result.instructions).toBe('hi')
  })

  it('answers an unknown asked version with its latest one', async () => {
    const { body } = await init(server(), '1999-01-01')
    expect(body.result.protocolVersion).toBe('2025-11-25')
  })

  it('accepts a notification with 202 and no body', async () => {
    const s = server(); const { sid } = await init(s)
    const res = await s.handle(post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { 'MCP-Session-Id': sid }))
    expect(res.status).toBe(202)
    expect(await res.text()).toBe('')
  })

  it('lists tools and calls one, passing the per request context', async () => {
    const s = server(); const { sid } = await init(s)
    const h = { 'MCP-Session-Id': sid, 'MCP-Protocol-Version': '2025-11-25', Authorization: 'Bearer ann' }
    const list = await (await s.handle(post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, h))).json() as { result: { tools: { name: string; inputSchema: unknown }[] } }
    expect(list.result.tools.map((t) => t.name)).toEqual(['echo'])
    const call = await (await s.handle(post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } }, h))).json() as { result: { content: { text: string }[] } }
    expect(call.result.content[0].text).toBe('ann: hi')
  })

  it('reports bad arguments as a tool error, an unknown tool and method as protocol errors', async () => {
    const s = server(); const { sid } = await init(s)
    const h = { 'MCP-Session-Id': sid, Authorization: 'Bearer ann' }
    const bad = await (await s.handle(post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: { text: 'far too long text', extra: 1 } } }, h))).json() as { result: { isError: boolean; content: { text: string }[] } }
    expect(bad.result.isError).toBe(true)
    expect(bad.result.content[0].text).toContain('longer than 10')
    expect(bad.result.content[0].text).toContain('extra is not expected')
    const unknown = await (await s.handle(post({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope' } }, h))).json() as { error: { code: number } }
    expect(unknown.error.code).toBe(-32602)
    const method = await (await s.handle(post({ jsonrpc: '2.0', id: 6, method: 'resources/list' }, h))).json() as { error: { code: number } }
    expect(method.error.code).toBe(-32601)
  })

  it('refuses: no session (400), a forged or expired session (404), a bad version (400), a bad origin (403), a batch (400)', async () => {
    let t = 1_000_000
    const s = server(() => t); const { sid } = await init(s)
    expect((await s.handle(post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))).status).toBe(400)
    expect((await s.handle(post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'MCP-Session-Id': sid + 'x' }))).status).toBe(404)
    expect((await s.handle(post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'MCP-Session-Id': sid, 'MCP-Protocol-Version': '2020-01-01' }))).status).toBe(400)
    expect((await s.handle(post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { Origin: 'https://evil.example' }))).status).toBe(403)
    expect((await s.handle(post([{ jsonrpc: '2.0', id: 1, method: 'ping' }], { 'MCP-Session-Id': sid }))).status).toBe(400)
    t += 25 * 3600_000
    expect((await s.handle(post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'MCP-Session-Id': sid }))).status).toBe(404)
  })

  it('answers GET with 405 (no server stream), and CORS for an allowed browser origin', async () => {
    const s = server()
    const get = await s.handle(new Request('https://x/mcp', { method: 'GET', headers: { Accept: 'text/event-stream' } }))
    expect(get.status).toBe(405)
    const { sid } = await init(s)
    const res = await s.handle(post({ jsonrpc: '2.0', id: 9, method: 'ping' }, { 'MCP-Session-Id': sid, Origin: 'https://good.example' }))
    expect(res.status).toBe(200)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://good.example')
    expect(res.headers.get('Access-Control-Expose-Headers')).toContain('MCP-Session-Id')
  })

  it('validates schemas: types, required, enums, ranges', () => {
    const schema = { type: 'object' as const, properties: { a: { type: 'integer' as const, minimum: 1, maximum: 5 }, b: { type: 'string' as const, enum: ['x', 'y'] } }, required: ['a'] }
    expect(validate(schema, { a: 3, b: 'x' })).toEqual([])
    expect(validate(schema, {})).toEqual(['arguments.a is required'])
    expect(validate(schema, { a: 9, b: 'z' })).toEqual(['arguments.a must be at most 5', 'arguments.b must be one of x, y'])
    expect(validate(schema, { a: 1.5 })).toEqual(['arguments.a must be a integer'])
  })
})
