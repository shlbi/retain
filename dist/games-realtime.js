// Supabase Realtime protocol v1 uses JSON frames. Broadcasts only invalidate the board;
// the authenticated workspace API supplies every score and performs the membership check.
function connectionDetails(config) {
  if (typeof config?.publishableKey !== 'string' || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(config.publishableKey) ||
      typeof config?.topic !== 'string' || !/^bingo-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(config.topic)) return null;
  let url;
  try { url = new URL(config.url); } catch { return null; }
  if (url.protocol !== 'wss:' || !/^[a-z0-9-]+\.supabase\.co$/.test(url.host) ||
      url.pathname !== '/realtime/v1/websocket' || url.username || url.password || url.search || url.hash) return null;
  url.searchParams.set('apikey',config.publishableKey);
  url.searchParams.set('vsn','1.0.0');
  return {url:url.href,topic:'realtime:'+config.topic};
}

export function createGameUpdates(refresh, Socket = globalThis.WebSocket) {
  let socket, details, heartbeat, timeout, pendingPulse, refetch;
  let joined = false, failedAt = 0, failures = 0;

  function disconnect() {
    const previous = socket;
    socket = null; joined = false; pendingPulse = null;
    clearInterval(heartbeat); clearTimeout(timeout); clearTimeout(refetch); refetch = null;
    if (previous) {
      previous.onopen = previous.onmessage = previous.onclose = previous.onerror = null;
      previous.close();
    }
  }
  function close() {
    disconnect();
    details = null; failures = 0; failedAt = 0;
  }
  // Coalesce simultaneous updates from a busy team before reloading the current standings.
  function invalidate() {
    if (refetch) return;
    refetch = setTimeout(() => { refetch = null; refresh(); }, 350);
  }
  function sync(config) {
    const target = connectionDetails(config);
    if (!target || !Socket) { close(); return; }
    if (details?.url !== target.url || details?.topic !== target.topic) {
      close(); details = target;
    }
    const backoff = Math.min(60000, 1000 * 2 ** Math.min(failures,6));
    if (socket || Date.now()-failedAt < backoff) return;
    const fail = () => {
      failedAt = Date.now(); failures++; disconnect();
      invalidate(); // Switch immediately to the normal polling cadence.
    };
    let ws;
    try { ws = socket = new Socket(target.url); } catch { fail(); return; }
    let index = 1;
    const joinRef = String(index);
    const send = (topic,event,payload,ref,join_ref) => {
      ws.send(JSON.stringify({topic,event,payload,ref,join_ref}));
    };
    timeout = setTimeout(fail,10000);
    ws.onopen = () => {
      send(target.topic,'phx_join',{
        config:{broadcast:{ack:false,self:false},presence:{enabled:false},postgres_changes:[],private:false}
      },joinRef,joinRef);
    };
    ws.onmessage = ({data}) => {
      let frame;
      try { frame = JSON.parse(data); } catch { return; }
      if (socket !== ws || !frame) return;
      if (frame.topic === 'phoenix' && frame.event === 'phx_reply' && frame.ref === pendingPulse) {
        pendingPulse = null;
        return;
      }
      if (frame.topic !== target.topic) return;
      if (frame.event === 'phx_close' || frame.event === 'phx_error') { fail(); return; }
      if (frame.event === 'phx_reply' && frame.ref === joinRef && !joined) {
        if (frame.payload?.status !== 'ok') { fail(); return; }
        clearTimeout(timeout); joined = true; failures = 0;
        // Changes may have committed between the initial snapshot and channel join.
        invalidate();
        heartbeat = setInterval(() => {
          if (pendingPulse) { fail(); return; }
          pendingPulse = String(++index);
          send('phoenix','heartbeat',{},pendingPulse,null);
        },25000);
      } else if (joined && frame.event === 'broadcast' && frame.payload?.event === 'refresh') {
        invalidate();
      }
    };
    ws.onclose = ws.onerror = fail;
  }
  return {sync,close,connected:() => joined};
}
