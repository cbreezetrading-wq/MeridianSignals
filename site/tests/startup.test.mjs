import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const launch=(script)=>spawn('bash',[script],{stdio:'ignore'});
const stop=async(child)=>{ if(child.exitCode!==null||child.signalCode!==null)return; const exited=once(child,'exit');child.kill('SIGTERM');await exited; };
async function waitFor(file,count){
  for(let n=0;n<100;n++){
    const text=await readFile(file,'utf8').catch(()=> '');
    if(text.trim().split('\n').filter(Boolean).length===count)return text;
    await delay(20);
  }
  throw new Error('Fake server did not start');
}
test('concurrent startup produces one server; process exit permits a clean restart',{timeout:10000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'meridian-site-start-'));
  const children=[];
  try {
    const site=join(dir,'site'),bin=join(site,'node_modules','.bin'),log=join(site,'starts.txt');
    await mkdir(bin,{recursive:true});
    await copyFile(new URL('../dev-server.sh',import.meta.url),join(site,'dev-server.sh'));
    // No execution/installer exists in this isolated tree, so no real worker runs.
    await writeFile(join(bin,'vite'),`#!/usr/bin/env python3\nimport sys,time\nwith open(${JSON.stringify(log)},'a') as f: f.write(' '.join(sys.argv[1:])+'\\n'); f.flush()\nwhile True: time.sleep(1)\n`,{mode:0o755});
    const first=launch(join(site,'dev-server.sh'));children.push(first);
    const args=await waitFor(log,1);
    assert.match(args,/--port 3000 --strictPort/);
    const second=launch(join(site,'dev-server.sh'));children.push(second);
    assert.equal((await once(second,'exit'))[0],0);
    assert.equal((await readFile(log,'utf8')).trim().split('\n').length,1);
    const crashed=once(first,'exit');
    first.kill('SIGKILL');
    await crashed;
    const third=launch(join(site,'dev-server.sh'));children.push(third);
    await waitFor(log,2);
    await stop(third);
  } finally {
    for(const child of children)await stop(child);
    await rm(dir,{recursive:true,force:true});
  }
});
