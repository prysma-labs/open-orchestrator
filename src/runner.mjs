// No coding-agent default tools, filesystem discovery, shell, or shared agent memory.
export async function runPi({ name, model: spec, systemPrompt, input, tools, log, timeoutMs = 180000 }) {
  const { Agent } = await import('@earendil-works/pi-agent-core');
  const { createModels } = await import('@earendil-works/pi-ai');
  const [provider, ...rest] = spec.split('/');
  const models = createModels();
  if (provider === 'anthropic') {
    const { anthropicProvider } = await import('@earendil-works/pi-ai/providers/anthropic');
    models.setProvider(anthropicProvider());
  } else if (provider === 'openai') {
    const { openaiProvider } = await import('@earendil-works/pi-ai/providers/openai');
    models.setProvider(openaiProvider());
  } else throw new Error('Supported model providers: anthropic, openai');
  const model = models.getModel(provider, rest.join('/'));
  if (!model) throw new Error(`Unknown Pi model ${spec}`);
  const agent = new Agent({ initialState: { systemPrompt, model, tools }, streamFn: models.streamSimple.bind(models), toolExecution: 'sequential' });
  let turns = 0;
  const unsubscribe = agent.subscribe(event => {
    if (event.type === 'turn_start' && ++turns > 8) agent.abort();
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      log('message', { text: event.message.content.filter(c => c.type === 'text').map(c => c.text).join(''), usage: event.message.usage });
    }
  });
  const timer = setTimeout(() => agent.abort(), timeoutMs);
  try {
    await agent.prompt(input);
    const last = [...agent.state.messages].reverse().find(m => m.role === 'assistant');
    if (!last || ['error','aborted'].includes(last.stopReason)) throw new Error(last?.errorMessage || `${name} aborted`);
    return last.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  } finally { clearTimeout(timer); unsubscribe(); }
}
// Scripted replay exercises orchestration/tools; it does NOT invoke Pi or any LLM.
export async function runFixture({ name, input, tools }) {
  const call = async (name, args) => {
    const t = tools.find(t => t.name === name);
    if (!t) throw new Error(`Tool not allowed: ${name}`);
    return (await t.execute('fixture', args)).details;
  };
  let evidence, direction;
  if (name === 'researcher' || name === 'baseline') evidence = await call('search_concepts', {});
  if (name === 'interviewer' || name === 'baseline') {
    direction = {};
    for (const [key, question] of Object.entries({ audience: 'Who should this reach?', mood: 'What mood, colors, or style?', text: 'What exact words belong on the poster?' })) {
      direction[key] = await call('ask_user', { key, question });
    }
  }
  if (name === 'artist' || name === 'baseline') {
    const context = name === 'baseline' ? JSON.stringify({ evidence, direction }) : input;
    const parsed = name === 'artist' ? JSON.parse(input) : null;
    await call('generate_image', { prompt: `FIXTURE scripted design. Analog collage, playful bold shapes. Context: ${context}`, text: direction?.text || parsed.direction.text });
  }
  return JSON.stringify({ fixture: true, evidence, direction });
}
