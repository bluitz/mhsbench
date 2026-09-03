import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';

const app = new Hono();

app.get('/health', (c) => c.json({ ok: true }));
app.get('/', (c) => c.text('hello world this is Justin'));

export default {
  port: process.env.PORT || 3000,
  fetch: app.fetch,
};