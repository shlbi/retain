// Supabase publishable keys identify a project to the browser. Session-bound HTTP
// requests authorize all scores and standings. The socket carries refresh signals.
const hostedProject = 'https://byrqvlamuspcfiiirjhd.supabase.co';
const hostedPublishableKey = 'sb_publishable_cIPtJO7GLj4trbBv0g6BoQ_a1HHOImZ';

export function gameConnection(state, env) {
  if (!state) return state;
  const {channel,...board} = state;
  let realtime = null;
  const endpoint = env.SUPABASE_URL?.replace(/\/$/,'');
  const key = env.SUPABASE_PUBLISHABLE_KEY ?? (endpoint === hostedProject ? hostedPublishableKey : '');
  if (/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(endpoint ?? '') &&
      /^sb_publishable_[A-Za-z0-9_-]+$/.test(key) && /^bingo-[0-9a-f-]{36}$/i.test(channel ?? '')) {
    realtime = {url:endpoint.replace('https:', 'wss:')+'/realtime/v1/websocket',publishableKey:key,topic:channel};
  }
  return {...board,realtime};
}
