// Minimal stateless server with one tool. Set SESSION_SECRET with `wrangler secret put` before deploying.
import { McpServer, type Tool } from '../src'

interface Env { SESSION_SECRET: string }

const dice: Tool<null> = {
  name: 'roll_dice',
  title: 'Roll dice',
  description: 'Rolls some dice and returns the total.',
  inputSchema: {
    type: 'object',
    properties: { count: { type: 'integer', minimum: 1, maximum: 20 }, sides: { type: 'integer', minimum: 2, maximum: 100 } },
    required: ['count', 'sides'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  async run(args) {
    const count = args.count as number, sides = args.sides as number
    const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides))
    const total = rolls.reduce((a, b) => a + b, 0)
    return { content: [{ type: 'text', text: `Rolled ${rolls.join(', ')}: ${total}` }], structuredContent: { rolls, total } }
  },
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname !== '/mcp') return new Response('MCP endpoint: POST /mcp', { status: 404 })
    return new McpServer<null>({
      info: { name: 'dice', title: 'Dice', version: '1.0.0' },
      tools: [dice],
      secret: env.SESSION_SECRET,
      allowOrigin: () => false,
      context: async () => null,
    }).handle(request)
  },
}
