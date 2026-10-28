// Compiled by `tsc --noEmit` (see README): the declarations describe real use.
import { ApiError, Client, Environment, findElement, type Frame, type StepResult } from '../computerworld-cloud.mjs';

const client = new Client('cw_live_…', { baseUrl: 'https://computaco.ai', maxRetries: 2 });
const world = await client.createWorld('agent-desktop', { seed: 1 });
const env: Environment = await world.environment({ label: 'agent' });
const scene = await env.scene({ elements: true });
const el = findElement(scene, { role: 'button', interaction: /^shell:launch:/ });
const step: StepResult = await env.click({ element: el });
const ok: boolean = step.outcomes[0].success;
const frame: Frame | null = await env.render({ width: 640, height: 400 });
const bytes: Uint8Array | undefined = frame?.bytes;
const run = await (await world.fork()).run('agent-desktop/legal-engagement', { seed: 2, includeSteps: true });
const passed: boolean = run.verification.passed;
try {
  await client.getWorld('w_nope');
} catch (e) {
  if (e instanceof ApiError && e.code === 'not_found') console.log(e.status, e.retryAfter);
}
const agent = Environment.connect(env.token!, env.id);
await agent.typeText('hi', { check: false });
await world.delete();
console.log(ok, bytes, passed);
