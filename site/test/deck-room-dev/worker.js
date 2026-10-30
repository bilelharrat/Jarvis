// DEV ONLY (test/deck-room-dev/e2e.mjs): the real DeckRoom in workerd behind `wrangler dev --local`, with the account
// and share check replaced by ?role= so two Node clients can join. Never deployed: it has its own config and name.
import { DeckRoom } from '../../src/eden/deck-room.js';

export { DeckRoom };
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = /^\/room\/([A-Za-z0-9_-]{22})(\/close)?$/.exec(url.pathname);
    if (!m) return new Response('dev room only', { status: 404 });
    const room = env.DECK_ROOMS.get(env.DECK_ROOMS.idFromName(m[1]));
    if (m[2]) return room.fetch('https://deck-room/close', { method: 'POST' });
    const role = url.searchParams.get('role') || 'owner';
    return room.fetch('https://deck-room/connect', { headers: { upgrade: 'websocket', 'x-room': m[1], 'x-role': role, 'x-seat': role === 'owner' ? 'owner' : `seat_${role}`, 'x-expires': '' } });
  },
};
