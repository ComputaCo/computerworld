// Compiled by `tsc --noEmit` (see README): the declarations describe real use.
import { Agent, ApiError, Client, findElement, type Frame, type StepResult } from '../computerworld-cloud.mjs';

const client = new Client('cw_live_…', { baseUrl: 'https://computaco.ai', maxRetries: 2 });
const simulation = await client.createSimulation('agent-desktop', { seed: 1 });
const agent: Agent = await simulation.agent({ label: 'agent' });
const scene = await agent.scene({ elements: true });
const el = findElement(scene, { role: 'button', interaction: /^shell:launch:/ });
const step: StepResult = await agent.click({ element: el });
const ok: boolean = step.outcomes[0].success;
const frame: Frame | null = await agent.render({ width: 640, height: 400 });
const bytes: Uint8Array | undefined = frame?.bytes;
const run = await (await simulation.fork()).run('agent-desktop/legal-engagement', { seed: 2, includeSteps: true });
const passed: boolean = run.verification.passed;
const town = await client.createSimulation('company-2026', { society: { id: 'rumor-cascade', journal: 'builtin' } });
await town.society.runRounds(4);
const arm = await town.fork({ societyOps: [{ op: 'add_rule' }] });
const simulated = (await arm.agents()).filter((a) => a.kind === 'simulated').length;
const summary = await town.society.summary();
try {
  await client.getSimulation('w_nope');
} catch (e) {
  if (e instanceof ApiError && e.code === 'not_found') console.log(e.status, e.retryAfter);
}
const remote = Agent.connect(agent.token!, simulation.id, agent.id);
await remote.typeText('hi', { check: false });
const hosted = await simulation.hostedAgent('workstation', { name: 'typist' });
await hosted.prompt('Open the editor.');
for await (const m of hosted.stream({ until: (x) => x.role === 'status' && x.status !== 'started' })) console.log(m.seq, m.role, m.text);
const { state } = await hosted.stop();
await simulation.delete();
console.log(ok, bytes, passed, simulated, summary, state);
