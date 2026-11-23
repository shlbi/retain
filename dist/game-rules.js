import { results } from './arcade-catalog.js';

// The rule preview is the same on the supervisor's setup page and the live board.
export function ruleText(kind, c) {
  const t = c.target,
    earn = results[c.metric].toLowerCase(),
    bonus = results[c.bonus].toLowerCase();
  switch (kind) {
    case 'bingo':
      return c.mode === 'Blackout' ? 'Complete all nine squares.' : 'Complete any row, column or diagonal.';
    case 'vault':
      return (
        'Unlock the dials with ' +
        t +
        ' ' +
        earn +
        ', ' +
        (c.mode === 'Hard locks' ? 2 * t : t) +
        ' internet saves and ' +
        Math.ceil(t / 2) +
        ' ' +
        bonus +
        ' across the team.'
      );
    case 'rally':
      return (
        'Each driver gets ' +
        t +
        ' calls. Each ' +
        earn +
        ' result earns one kilometer and each ' +
        bonus +
        ' result earns ' +
        (c.mode === 'Turbo' ? 3 : 2) +
        '. The highest average crew distance wins.'
      );
    case 'mission':
      return (
        'Choose a contract, then collect ' +
        t +
        ' matching results. ' +
        (c.mode === 'Expert' ? 'Later contracts require one or two extra results. ' : '') +
        'Collect three different stamps.'
      );
    case 'heist':
      return (
        'Your crew hides a rock and a decoy. Every ' +
        t +
        ' ' +
        earn +
        ' earns a scan and a recovery attempt. ' +
        bonus +
        ' earn bonus scans and a chance to swap your rock and decoy.'
      );
    case 'switchboard':
      return (
        'Each ' +
        t +
        ' ' +
        earn +
        ' earns a quarter turn. Each ' +
        bonus +
        ' result lets you bridge one relay. Match every arrow to power the block.'
      );
    case 'fm':
      return (
        'The team unlocks another layer every ' +
        t +
        ' ' +
        earn +
        '. Vote on an unlocked layer to change the mix. One ' +
        bonus +
        ' result unlocks the chorus.'
      );
    case 'belt':
      return (
        'Both fighters get ' +
        t +
        ' new calls in each duel. ' +
        results[c.metric] +
        ' score one and ' +
        bonus +
        ' score ' +
        (c.mode === 'Sales boost' ? 3 : 2) +
        '. The champion keeps a tie.'
      );
    case 'swap':
      return (
        'Open a pack every ' +
        t +
        ' ' +
        earn +
        '. ' +
        results[c.bonus] +
        ' earn wild cards. Swap duplicates to complete the album.'
      );
    case 'macro':
      return (
        'Each ' +
        t +
        ' team ' +
        earn +
        ' reveals more detail. A ' +
        bonus +
        ' result unlocks a private clue. Make one guess. Earlier correct guesses earn more points.'
      );
    case 'caption':
      return (
        'Earn ' +
        t +
        ' ' +
        earn +
        ' to enter a caption. ' +
        results[c.bonus] +
        ' unlock two extra choices. Each player has one vote. Most votes at closing wins.'
      );
    case 'territory':
      return (
        'Claim adjoining blocks using one flag per ' +
        earn +
        ' result or two per ' +
        bonus +
        ' result. First crew to connect ' +
        t +
        ' blocks wins.' +
        (c.mode === 'Riverside' ? ' Cross the river between the top and middle rows at the outer columns.' : '')
      );
    case 'wavelength':
      return (
        'The first player sets a secret dial and picks a clue. Teammates earn a guess with ' +
        t +
        ' ' +
        earn +
        '. Closest dial wins when all guesses are in or time expires.'
      );
    case 'ghost':
      return (
        'Race for ' +
        t +
        ' calls using ' +
        (c.mode === 'Mobile orders' ? 'mobile orders' : earn) +
        '. The first finish sets your benchmark. Later rounds with the same settings race that score.'
      );
    case 'plot':
      return (
        'A chapter unlocks every ' +
        t +
        ' team ' +
        earn +
        '. Vote for a path and turn the page when at least half of the team backs one choice.'
      );
    case 'elevator':
      return (
        'Choose Ride to start a ' +
        t +
        '-call checkpoint. Any ' +
        earn +
        ' or ' +
        bonus +
        ' lifts you ' +
        (c.mode === 'Express' ? 'two floors' : 'one floor') +
        '. A miss clears your unbanked floors. Bank five to win.'
      );
    case 'manual':
      return (
        'The operator reads a symbol aloud. A teammate uses the decoder to help choose the matching button. Each signal needs ' +
        t +
        ' team ' +
        earn +
        '. Solve three together.'
      );
    case 'fantasy':
      return (
        'Draft three results and choose a captain. Future team results score one each, with ' +
        (c.mode === 'Power captain' ? 'triple' : 'double') +
        ' captain points. Reach ' +
        t +
        ' to win.'
      );
    case 'domino':
      return (
        'Each team ' +
        earn +
        ' result places a tile. Agents with ' +
        bonus +
        ' can vote on the route. At ' +
        t +
        ' tiles, the chain falls.'
      );
  }
}
