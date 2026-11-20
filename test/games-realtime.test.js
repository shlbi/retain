import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameUpdates } from '../dist/games-realtime.js';

class Socket {
  static created = [];
  constructor(url) { this.url=url; this.sent=[]; Socket.created.push(this); }
  send(message) { this.sent.push(JSON.parse(message)); }
  receive(frame) { this.onmessage?.({data:JSON.stringify(frame)}); }
  close() { this.closed=true; }
}
const config = {
  url:'wss://example.supabase.co/realtime/v1/websocket',publishableKey:'sb_publishable_browser_key',
  topic:'bingo-12345678-abcd-4000-8000-123456789abc'
};
const wait = () => new Promise(resolve=>setTimeout(resolve,425));
test('game updates refetch authenticated totals after join and coalesce only board notifications', async () => {
  let reads=0; Socket.created=[];
  const updates=createGameUpdates(()=>{reads++;},Socket);
  try {
    updates.sync(config); updates.sync(config);
    assert.equal(Socket.created.length,1);
    const [ws]=Socket.created;
    assert.equal(new URL(ws.url).searchParams.get('vsn'),'1.0.0');
    ws.onopen();
    const [join]=ws.sent;
    assert.equal(join.topic,'realtime:'+config.topic); assert.equal(join.event,'phx_join');
    ws.receive({event:'phx_reply',topic:join.topic,ref:join.ref,payload:{status:'ok'}});
    await wait(); assert.equal(reads,1); assert.equal(updates.connected(),true);
    ws.receive({event:'broadcast',topic:'realtime:wrong',payload:{event:'refresh'}});
    ws.receive({event:'broadcast',topic:join.topic,payload:{event:'other'}});
    await wait(); assert.equal(reads,1);
    for(let i=0;i<4;i++) ws.receive({event:'broadcast',topic:join.topic,payload:{event:'refresh'}});
    await wait(); assert.equal(reads,2);
    updates.sync({...config,topic:'bingo-76543210-abcd-4000-8000-123456789abc'});
    assert.equal(ws.closed,true); assert.equal(Socket.created.length,2);
    assert.equal(updates.connected(),false);
  } finally { updates.close(); }
});
test('missing push config uses polling; stale notifications cannot reopen a signed-out session', async () => {
  Socket.created=[]; let reads=0;
  const updates=createGameUpdates(()=>{reads++;},Socket);
  for(const candidate of [null,{...config,publishableKey:'sb_secret_wrong'},{...config,url:'wss://invalid.example/socket'}]) updates.sync(candidate);
  assert.equal(Socket.created.length,0);
  updates.sync(config); const [ws]=Socket.created;
  ws.onopen();
  ws.receive({event:'phx_reply',topic:ws.sent[0].topic,ref:'1',payload:{status:'ok'}});
  updates.close(); await wait();
  assert.equal(reads,0); assert.ok(ws.closed); assert.equal(updates.connected(),false);
});
