import { parseArgs } from 'node:util';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';
import { workflow } from './workflow.mjs';
import { research } from './providers.mjs';
async function main() {
  const { values: v, positionals } = parseArgs({ allowPositionals: true, options: {
    brief: {type:'string'}, answers:{type:'string'}, out:{type:'string'}, query:{type:'string'},
    fixture:{type:'boolean'}, 'fixture-image':{type:'boolean'}, 'fixture-research':{type:'boolean'},
    'research-adapter':{type:'string'},
    ...Object.fromEntries(['researcher','interviewer','artist','baseline'].map(k=>[k+'-model',{type:'string'}]))
  }});
  const mode = positionals[0] || 'specialized';
  if (!['specialized','baseline','compare'].includes(mode)) throw new Error('Use specialized, baseline, or compare');
  if (!v.brief?.trim()) throw new Error('Pass --brief "your poster brief"');
  const answers = v.answers ? JSON.parse(await readFile(v.answers,'utf8')) : {};
  if (v.answers) for (const k of ['audience','mood','text']) if (typeof answers[k] !== 'string' || !answers[k].trim()) throw new Error(`Answers file needs ${k}`);
  let terminal;
  const ask = async (key, question) => {
    if (answers[key]) { console.error(`${question} [replay: ${answers[key]}]`); return answers[key]; }
    if (!process.stdin.isTTY) throw new Error('Noninteractive run requires --answers with audience, mood, text');
    terminal ??= createInterface({ input: process.stdin, output: process.stdout });
    let answer;
    do { answer = (await terminal.question(question+' ')).trim(); } while (!answer);
    answers[key] = answer;
    return answer;
  };
  const models = Object.fromEntries(['researcher','interviewer','artist','baseline'].map(k=>[k,v[k+'-model'] || process.env[k.toUpperCase()+'_MODEL'] || 'anthropic/claude-sonnet-4-6']));
  const root = v.out || join('runs',new Date().toISOString().replace(/[:.]/g,'-'));
  const opts = { brief:v.brief, query:v.query || '(design OR art) (analog OR offline) -is:retweet lang:en', adapter:v['research-adapter'], fixture:!!v.fixture, fixtureResearch:!!(v.fixture || v['fixture-research']), fixtureImage:!!v['fixture-image'], models, ask };
  let snapshot;
  const getResearch = async () => snapshot ??= await research({ ...opts, fixture:opts.fixtureResearch });
  await mkdir(root,{recursive:true});
  console.error(v.fixture ? 'FIXTURE: scripted agents, synthetic research, SVG placeholders. No model calls.' : 'LIVE Pi agents. Explicit fixture flags, if supplied, affect only named integrations.');
  try {
    const arms = mode === 'compare' ? ['specialized','baseline'] : [mode];
    const results = [];
    for (const arm of arms) results.push(await workflow({ ...opts, getResearch, mode:arm, out:join(root,arm) }));
    await writeFile(join(root,'answers.json'),JSON.stringify(answers,null,2));
    await writeFile(join(root,'comparison.json'),JSON.stringify({ notice:'Qualitative comparison, not proof of superiority. Fixture timings are plumbing only.', results },null,2));
    console.log(`Results: ${root}`);
  } finally { terminal?.close(); }
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
