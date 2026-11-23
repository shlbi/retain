// This manifest is shared by the catalog, the rule builder and the authoritative game engine.
export const results = {
  savedCalls: 'Calls saved',
  internet: 'Internet saves',
  tv: 'Video saves',
  phone: 'Voice saves',
  mobile: 'Mobile service saves',
  lineSave: 'Mobile lines retained',
  spInternet: 'Internet-only saves',
  subscriber: 'Subscriber accounts saved',
  sp: 'Single-play saves',
  dp: 'Double-play saves',
  tp: 'Triple-play saves',
  mobileOrders: 'Mobile orders',
  mobileLines: 'Mobile lines sold',
  calls: 'Calls logged',
};
export const bingoBlocks = [
  ['savedCalls', 3],
  ['internet', 2],
  ['mobileOrders', 1],
  ['sp', 1],
  ['tv', 1],
  ['mobileLines', 2],
  ['dp', 1],
  ['phone', 1],
  ['calls', 8],
];
const list = [
  [
    'bingo',
    'Bingo Hall',
    'Mark your card with saves and sales. Connect three or cover the board.',
    'Bingo squares',
    3,
    'Card',
  ],
  [
    'vault',
    'Vault Break',
    'Crack three combination locks together. Each lock needs a different result.',
    'Saves per lock',
    5,
    'Co-op',
  ],
  [
    'rally',
    'Crew Rally',
    'Race two crews head to head. Saves move the car and mobile orders fire the boost.',
    'Calls per driver',
    10,
    'Team race',
  ],
  [
    'mission',
    'Mission Draft',
    'Pick a contract before your next calls. Finish three different contracts for a passport of stamps.',
    'Results per contract',
    2,
    'Strategy',
  ],
  [
    'heist',
    'Moon Heist',
    'Hide a moon rock, scan rival lockers for a signal, then name the hiding place.',
    'Saves per scan',
    1,
    'Deduction',
  ],
  [
    'switchboard',
    'Switchboard',
    'Rotate the switches to bring a dark city block online. Sales give you extra turns.',
    'Saves per turn',
    1,
    'Puzzle',
  ],
  [
    'fm',
    'After Hours FM',
    'Unlock drums, bass and keys together, vote for sounds, and listen to your team’s mix.',
    'Results per layer',
    2,
    'Studio',
  ],
  [
    'belt',
    'The Belt',
    'Take a seat in the ring. Two contenders get the same call allowance to win the belt.',
    'Calls per contender',
    5,
    'Duel',
  ],
  [
    'swap',
    'Swap Meet',
    'Collect illustrated stamps, swap doubles with a teammate or use a mobile sale as a wild card.',
    'Saves per pack',
    1,
    'Collecting',
  ],
  [
    'macro',
    'What on Earth?',
    'Watch a mystery object come into focus. An early correct guess scores the most.',
    'Results per reveal',
    2,
    'Mystery',
  ],
  [
    'caption',
    'Caption Clash',
    'Pick a caption for a peculiar office scene and vote for the funniest entry.',
    'Saves to enter',
    1,
    'Party',
  ],
  [
    'territory',
    'Queen City Takeover',
    'Plant flags in adjoining city blocks. Mobile orders give your crew extra flags.',
    'Blocks to connect',
    4,
    'Territory',
  ],
  [
    'wavelength',
    'Same Wavelength',
    'One teammate sets a secret dial and offers a clue. Everyone else tries to tune in.',
    'Results to tune in',
    1,
    'Social',
  ],
  [
    'ghost',
    'Ghost Shift',
    'Race your previous round over the same number of calls. Watch your ghost cross the track.',
    'Calls per race',
    8,
    'Personal best',
  ],
  [
    'plot',
    'Plot Twist',
    'Vote on the next scene in a branching team story. Each chapter unlocks through calls.',
    'Results per chapter',
    2,
    'Adventure',
  ],
  [
    'elevator',
    'One More Floor',
    'Ride up on future saves or bank your floor. A missed checkpoint costs the unbanked climb.',
    'Calls per checkpoint',
    3,
    'Push your luck',
  ],
  [
    'manual',
    'Wrong Manual',
    'One player sees the panel, another sees the decoder. Work out the right sequence together.',
    'Results per signal',
    1,
    'Co-op',
  ],
  [
    'fantasy',
    'Fantasy Shift',
    'Draft three results and double one captain. Your squad scores from future team outcomes.',
    'Points to win',
    12,
    'Draft',
  ],
  [
    'domino',
    'Last Domino',
    'Build a team chain, vote on its route and watch it fall when the final tile lands.',
    'Tiles to finish',
    20,
    'Co-op',
  ],
];
export const games = list.map(([id, name, description, targetLabel, target, genre], index) => ({
  id,
  name,
  description,
  targetLabel,
  target,
  genre,
  index,
}));
export const gameById = Object.fromEntries(games.map((g) => [g.id, g]));
export const modes = {
  bingo: ['Line', 'Blackout'],
  vault: ['Standard', 'Hard locks'],
  rally: ['Balanced', 'Turbo'],
  mission: ['Standard', 'Expert'],
  heist: ['Near signal', 'Exact signal'],
  switchboard: ['Four switches', 'Six switches'],
  fm: ['Night drive', 'Daybreak'],
  belt: ['Standard', 'Sales boost'],
  swap: ['Four stamps', 'Six stamps'],
  macro: ['Workshop', 'Kitchen'],
  caption: ['Office raccoon', 'Moon meeting'],
  territory: ['City center', 'Riverside'],
  wavelength: ['Quiet to loud', 'Cold to hot'],
  ghost: ['Saves', 'Mobile orders'],
  plot: ['Night train', 'Lost transmission'],
  elevator: ['Standard', 'Express'],
  manual: ['Four symbols', 'Six symbols'],
  fantasy: ['Balanced', 'Power captain'],
  domino: ['Bridge', 'Spiral'],
};
export const defaultConfig = (id) => ({
  target: gameById[id].target,
  metric: 'savedCalls',
  bonus: 'mobileOrders',
  mode: modes[id][0],
});
export function validateConfig(id, value) {
  if (
    !Object.hasOwn(gameById, id) ||
    !value ||
    Object.keys(value).sort().join() !== 'bonus,metric,mode,target' ||
    !Number.isInteger(value.target) ||
    value.target < 1 ||
    value.target > (id === 'territory' ? 12 : 99) ||
    !Object.hasOwn(results, value.metric) ||
    !Object.hasOwn(results, value.bonus) ||
    !modes[id].includes(value.mode)
  )
    throw Error('Choose valid game rules.');
  return { target: value.target, metric: value.metric, bonus: value.bonus, mode: value.mode };
}
