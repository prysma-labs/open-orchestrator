import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workflow } from '../src/workflow.mjs';
import { runFixture } from '../src/runner.mjs';
import { image } from '../src/providers.mjs';
const answers = { audience:'Artists', mood:'Analog collage', text:'OFFLINE / Friday' };
async function setup(t) {
  const out = await mkdtemp(join(tmpdir(),'poster-test-'));
  t.after(()=>rm(out,{recursive:true,force:true}));
  return { out, brief:'Offline night', fixture:true, models:{}, ask:async key=>answers[key] };
}
test('specialists enforce scopes, hand off answers, and emit usable artifacts and traces', async t=>{
  const opts = await setup(t), seen=[];
  const result = await workflow({ ...opts, mode:'specialized', runner:async args=>{
    seen.push([args.name,args.tools.map(t=>t.name)]); return runFixture(args);
  }});
  assert.deepEqual(seen,[['researcher',['search_concepts']],['interviewer',['ask_user']],['artist',['generate_image']]]);
  assert.deepEqual(result.direction,answers);
  assert.match(await readFile(result.artifacts[0].path,'utf8'),/SVG PLACEHOLDER/);
  const events=(await readFile(join(opts.out,'trace.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(e=>e.type==='tool_start').length,5);
  assert.ok(events.every(e=>e.elapsedMs>=0));
});
test('baseline and specialists consume the same snapshot and answers', async t=>{
  const opts=await setup(t); const snapshot={fixture:true,posts:[{text:'Shared evidence'}]};
  const results=[];
  for(const mode of ['specialized','baseline']) results.push(await workflow({...opts,out:join(opts.out,mode),mode,getResearch:async()=>snapshot}));
  assert.deepEqual(results[0].evidence,results[1].evidence);
  assert.deepEqual(results[0].direction,results[1].direction);
});
test('missing tool use fails and persists diagnostic trace',async t=>{
  const opts=await setup(t);
  await assert.rejects(workflow({...opts,mode:'specialized',runner:async()=>''}),/skipped research/);
  assert.match(await readFile(join(opts.out,'trace.jsonl'),'utf8'),/skipped research/);
});
test('bad artist copy is blocked before provider call',async t=>{
  const opts=await setup(t);
  await assert.rejects(workflow({...opts,mode:'specialized',runner:async args=>{
    if(args.name!=='artist') return runFixture(args);
    await args.tools[0].execute('test',{prompt:'A poster',text:'Invented event'});
  }}),/exact user copy/);
});
test('OpenAI image adapter writes base64 PNG and rejects missing image',async t=>{
  const opts=await setup(t); const previous=process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY='test-not-a-real-key';
  t.after(()=>{if(previous===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=previous;});
  let payload;
  const result=await image({file:join(opts.out,'image'),text:'Hello',prompt:'Bold',fetchJson:async(url,req)=>{
    assert.equal(url,'https://api.openai.com/v1/images/generations');payload=JSON.parse(req.body);return {data:[{b64_json:Buffer.from('test-image-bytes').toString('base64')}]};
  }});
  assert.equal(payload.size,'1024x1536');assert.match(payload.prompt,/Hello/);
  assert.equal(await readFile(result.path,'utf8'),'test-image-bytes');
  await assert.rejects(image({file:join(opts.out,'bad'),text:'Hi',prompt:'Bold',fetchJson:async()=>({data:[]})}),/no base64/);
});
