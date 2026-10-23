import { describe, expect, it } from 'vitest';
import { agentSystemPrompt } from '../prompt';
import { toolsForRun } from '../tools';

// The tools and the system prompt are the fixed part of every request and count against the context window. A local
// model with a 12,288-token window keeps window − output reserve = 9,216 tokens for everything.
describe('the tool schemas the model sees', () => {
  const tools = toolsForRun({ vision: true });

  it('carry no size bounds: the layer enforces them and names them in its answer', () => {
    // upload's attachment list is the agent's own schema (src/agent/tools.ts), with its own bound.
    const json = JSON.stringify(tools.filter(t => t.name !== 'upload').map(t => t.parameters));
    expect(json).not.toContain('maxLength');
    expect(json).not.toContain('maxItems');
  });

  it('with the system prompt leave room in a 12,288-token window', () => {
    const chars =
      agentSystemPrompt({ tools: tools.map(t => t.name) }).length +
      JSON.stringify(tools.map(t => [t.name, t.description, t.parameters])).length;
    expect(chars / 4).toBeLessThan(9_216);
  });
});
