# mcp-on-workers

A small Model Context Protocol server for the Streamable HTTP transport (spec 2025-11-25), made for Cloudflare Workers
and any runtime with `fetch`, `Request` and Web Crypto. No dependencies. About 250 lines.

It answers every request with one JSON object (the spec allows `application/json` instead of an SSE stream), answers
GET with 405 (no server stream), and keeps sessions stateless: a session id is signed with HMAC, so any Worker instance
can check it without storage.

## What the spec asks, and where it is done

| The spec (2025-11-25, basic/transports) | Here |
| --- | --- |
| "Servers MUST validate the Origin header"; a bad one answers 403 | `allowOrigin` option, checked first |
| A notification or response "MUST return HTTP status code 202 Accepted with no body" | yes |
| A session id of visible ASCII, sent in `MCP-Session-Id` with the InitializeResult | signed, 24 hours |
| Requests without the session id after initialize: 400; an ended session: 404 | yes; a forged or expired id is 404 |
| An unsupported `MCP-Protocol-Version`: 400 | supports 2025-11-25, 2025-06-18, 2025-03-26 |
| Servers "MUST validate all tool inputs" (server/tools) | a small JSON Schema check before every tool runs; problems come back as a tool error |
| JSON-RPC batches | refused with 400 (not part of this protocol version) |

## Use

```ts
import { McpServer, type Tool } from 'mcp-on-workers'

const hello: Tool<null> = {
  name: 'hello', title: 'Say hello', description: 'Greets someone.',
  inputSchema: { type: 'object', properties: { name: { type: 'string', maxLength: 40 } }, required: ['name'], additionalProperties: false },
  async run(args) { return { content: [{ type: 'text', text: `Hello, ${args.name}!` }] } },
}

export default {
  async fetch(request: Request, env: { SESSION_SECRET: string }) {
    return new McpServer<null>({
      info: { name: 'hello', title: 'Hello', version: '1.0.0' },
      tools: [hello],
      secret: env.SESSION_SECRET,
      allowOrigin: (origin) => origin === 'https://my-site.example',
      context: async () => null,
    }).handle(request)
  },
}
```

`context(request)` builds whatever your tools need per request (a user from the `Authorization` header, a storage
handle). Throw from it to refuse a call with a tool error.

`example/worker.ts` is a complete server with one tool.

## Test

```
npm install
npm test        # the protocol rules above, as unit tests
```

## Licence

MIT. See LICENSE.
