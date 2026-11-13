import test from 'node:test';
import assert from 'node:assert/strict';
import { credentials, hashPassword, verifyPassword, newSession, tokenHash, sessionToken, sessionCookie, SESSION_SECONDS } from '../server/auth.js';

test('credentials allow one-character and whitespace passwords without a strength policy',()=>{
  assert.deepEqual(credentials('  A  ','x'),{username:'A',password:'x'});
  assert.deepEqual(credentials('agent',' '),{username:'agent',password:' '});
  assert.equal(credentials('😀'.repeat(64),'🔒'.repeat(1024)).username.length,128);
  for (const pair of [['','x'],['   ','x'],['a',''],['a'.repeat(65),'x'],['a','x'.repeat(1025)],[5,'x'],['a',5]]) assert.throws(()=>credentials(...pair));
});

test('signup validates trimmed usernames and counts Unicode characters in both fields', () => {
  const username = '😀'.repeat(8), password = '🔒'.repeat(8);
  assert.deepEqual(credentials(' ' + username + ' ', password, 'signup'), {username, password});
  assert.deepEqual(credentials('Ap9', ' ', 'signup'), {username:'Ap9', password:' '});
  for (const name of ['p', ' Peter ', '1agent', '٩agent', '   ', username + 'x', null]) {
    assert.throws(() => credentials(name, password, 'signup'), /Username/);
  }
  for (const value of ['', password + 'x', '12345678\n', null]) {
    assert.throws(() => credentials('agent', value, 'signup'), /Password/);
  }
});

test('salted scrypt hashes differ and verify only the exact original password',async()=>{
  const first = await hashPassword('x'), second = await hashPassword('x');
  assert.notEqual(first,second);
  assert.match(first,/^scrypt\$32768\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
  assert.equal(await verifyPassword('x',first),true);
  assert.equal(await verifyPassword('X',first),false);
  assert.equal(await verifyPassword('x ',first),false);
});

test('nonexistent and malformed hashes take the dummy verification path and never authenticate',async()=>{
  assert.equal(await verifyPassword('x',undefined),false);
  assert.equal(await verifyPassword('x','scrypt$999999999$8$1$evil$evil'),false);
});

test('random session tokens have 256 bits and only their digest is stored',()=>{
  const first = newSession(), second = newSession();
  assert.match(first.token,/^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(first.token,'base64url').length,32);
  assert.notEqual(first.token,second.token);
  assert.equal(first.hash,tokenHash(first.token));
  assert.match(first.hash,/^[a-f0-9]{64}$/);
  assert.notEqual(first.hash,first.token);
});

test('session cookie is host-only HttpOnly Strict Secure and expires in 30 days',()=>{
  const now = Date.UTC(2026,10,6), {token} = newSession();
  const cookie = sessionCookie(token,{now});
  assert.match(cookie,/Path=\/; HttpOnly; SameSite=Strict/);
  assert.match(cookie,/; Secure$/);
  assert.ok(cookie.includes(`Max-Age=${SESSION_SECONDS}`));
  assert.ok(cookie.includes(new Date(now + SESSION_SECONDS * 1000).toUTCString()));
  assert.doesNotMatch(cookie,/Domain=/);
  assert.doesNotMatch(sessionCookie(token,{secure:false}),/Secure/);
  assert.match(sessionCookie('',{clear:true}),/workspace_session=;.*Max-Age=0/);
});

test('cookie parsing rejects ambiguous, truncated, and injected bearer values',()=>{
  const {token} = newSession();
  assert.equal(sessionToken(`other=ok; workspace_session=${token}`),token);
  assert.equal(sessionToken(`workspace_session=${token}; workspace_session=${token}`),null);
  assert.equal(sessionToken('workspace_session=short'),null);
  assert.equal(sessionToken(`workspace_session=${token}%00`),null);
  assert.equal(sessionToken(undefined),null);
});
