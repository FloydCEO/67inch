// ============================================================
//  67GUESSR — ADD THESE ROUTES TO YOUR EXISTING WORKER
//  Paste everything below into your export default fetch handler,
//  BEFORE the final "return 404" line.
//  Also paste the helper functions and LORE_LOCATIONS constant
//  at the top of your worker file (outside the handler).
// ============================================================

// ── PASTE THIS NEAR THE TOP OF YOUR WORKER (outside the handler) ──

const LORE_LOCATIONS = [
  { id: 'ledurga',  name: 'Lēdurga, Latvia',               lat: 57.3219, lng: 24.7792, heading: 45,  pitch: 0, hint: 'SOMEWHERE IN LATVIA'  },
  { id: 'brighton', name: '25 Graham Ave, Brighton',        lat: 50.8288, lng: -0.1395, heading: 200, pitch: 5, hint: 'SOMEWHERE IN ENGLAND'  },
  { id: 'covington',name: '395 E 40th St, Covington KY',   lat: 39.0776, lng: -84.4849,heading: 90,  pitch: 0, hint: 'SOMEWHERE IN AMERICA'  },
  { id: 'tallinn',  name: 'Veerenni tn, Tallinn',          lat: 59.4215, lng: 24.7430, heading: 270, pitch: 5, hint: 'SOMEWHERE IN ESTONIA'   },
];

const TOTAL_ROUNDS = 3;
const ROOM_TTL = 3600; // 1 hour room TTL in seconds

// Generate a random 6-char room code
function genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// Pick N random locations without repeats
function pickRoundLocations(n) {
  const shuffled = [...LORE_LOCATIONS].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(n, shuffled.length));
}

// KV helpers (these already exist in your worker — no need to paste again)
// kvGet, kvSet are already defined above

// ── GUESSR KV HELPERS ──
async function getRoomData(env, roomCode) {
  return kvGet(env, `guessr:room:${roomCode}`);
}
async function saveRoomData(env, roomCode, data) {
  await kvSet(env, `guessr:room:${roomCode}`, data, ROOM_TTL);
}

// Calculate distance in km (Haversine)
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Score = distance score (max 4000) + placement bonus
function calcPoints(distKm, placement, totalPlayers) {
  const distScore = Math.round(4000 * Math.exp(-distKm / 2000));
  const bonusTable = [1000, 600, 300, 100];
  const placementBonus = totalPlayers > 1 ? (bonusTable[Math.min(placement - 1, bonusTable.length - 1)] || 0) : 0;
  return distScore + placementBonus;
}


// ============================================================
//  PASTE THESE ROUTE HANDLERS inside your fetch handler,
//  BEFORE the final "return 404" line.
//  They all follow the same pattern as your existing routes.
// ============================================================

      // ── GUESSR: CREATE ROOM ──
      if (path === "/api/guessr/create") {
        const { googleId, name, deviceFingerprint } = body;
        if (!googleId || !name) {
          return new Response(JSON.stringify({ error: "Missing fields" }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
        }
        let roomCode = genRoomCode();
        // Ensure no collision (unlikely but safe)
        for (let i = 0; i < 5; i++) {
          const existing = await getRoomData(env, roomCode);
          if (!existing) break;
          roomCode = genRoomCode();
        }
        const locations = pickRoundLocations(TOTAL_ROUNDS);
        const room = {
          roomCode,
          status: 'waiting', // waiting | playing | done
          hostId: googleId,
          players: [{ googleId, name, joinedAt: Date.now() }],
          locations,
          roundIndex: 0,
          guesses: {}, // { "round_0": { googleId: { lat, lng, distKm, pts } } }
          createdAt: Date.now(),
        };
        await saveRoomData(env, roomCode, room);
        return new Response(JSON.stringify({ success: true, roomCode, locations }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
      }

      // ── GUESSR: JOIN ROOM ──
      if (path === "/api/guessr/join") {
        const { roomCode, googleId, name, deviceFingerprint } = body;
        if (!roomCode || !googleId || !name) {
          return new Response(JSON.stringify({ error: "Missing fields" }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
        }
        const room = await getRoomData(env, roomCode);
        if (!room) {
          return new Response(JSON.stringify({ error: "Room not found", message: "That party code doesn't exist or has expired" }), { status: 404, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
        }
        if (room.status !== 'waiting') {
          return new Response(JSON.stringify({ error: "Game already started", message: "This party has already started a game" }), { status: 409, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
        }
        if (room.players.length >= 4) {
          return new Response(JSON.stringify({ error: "Room full", message: "This party is full (max 4 players)" }), { status: 409, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
        }
        // Check if already in room
        const alreadyIn = room.players.find(p => p.googleId === googleId);
        if (!alreadyIn) {
          room.players.push({ googleId, name, joinedAt: Date.now() });
          await saveRoomData(env, roomCode, room);
        }
        return new Response(JSON.stringify({ success: true, roomCode, players: room.players }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
      }

      // ── GUESSR: POLL ROOM STATE ──
      if (path === "/api/guessr/room") {
        const { roomCode, googleId } = body;
        if (!roomCode) {
          return new Response(JSON.stringify({ error: "Missing roomCode" }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
        }
        const room = await getRoomData(env, roomCode);
        if (!room) {
          return new Response(JSON.stringify({ success: false, error: "Room not found" }), { status: 404, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
        }
        const resp = {
          success: true,
          status: room.status,
          players: room.players,
          roundIndex: room.roundIndex,
        };
        // If game is playing, include locations so guests can start
        if (room.status === 'playing') {
          resp.locations = room.locations;
        }
        return new Response(JSON.stringify(resp), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
      }

      // ── GUESSR: LEAVE ROOM ──
      if (path === "/api/guessr/leave") {
        const { roomCode, googleId } = body;
        if (!roomCode || !googleId) {
          return new Response(JSON.stringify({ success: true }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
        }
        const room = await getRoomData(env, roomCode);
        if (room) {
          room.players = room.players.filter(p => p.googleId !== googleId);
          if (room.players.length === 0) {
            // Delete room
            await env.GUESSR_KV.delete(`guessr:room:${roomCode}`);
          } else {
            // If host left, reassign host
            if (room.hostId === googleId && room.players.length > 0) {
              room.hostId = room.players[0].googleId;
            }
            await saveRoomData(env, roomCode, room);
          }
        }
        return new Response(JSON.stringify({ success: true }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
      }

      // ── GUESSR: START GAME (host only) ──
      if (path === "/api/guessr/start") {
        const { roomCode, googleId } = body;
        if (!roomCode || !googleId) {
          return new Response(JSON.stringify({ error: "Missing fields" }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
        }
        const room = await getRoomData(env, roomCode);
        if (!room) {
          return new Response(JSON.stringify({ error: "Room not found" }), { status: 404, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
        }
        if (room.hostId !== googleId) {
          return new Response(JSON.stringify({ error: "Not host", message: "Only the party leader can start the game" }), { status: 403, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
        }
        room.status = 'playing';
        room.startedAt = Date.now();
        await saveRoomData(env, roomCode, room);
        return new Response(JSON.stringify({ success: true, players: room.players, locations: room.locations, roundIndex: room.roundIndex }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
      }

      // ── GUESSR: SUBMIT GUESS ──
      if (path === "/api/guessr/guess") {
        const { roomCode, googleId, round, lat, lng } = body;
        if (!roomCode || !googleId || round === undefined) {
          return new Response(JSON.stringify({ error: "Missing fields" }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
        }
        const room = await getRoomData(env, roomCode);
        if (!room) {
          return new Response(JSON.stringify({ error: "Room not found" }), { status: 404, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
        }
        const roundKey = `round_${round}`;
        if (!room.guesses[roundKey]) room.guesses[roundKey] = {};
        // Don't allow double-submit
        if (room.guesses[roundKey][googleId]) {
          return new Response(JSON.stringify({ error: "Already guessed" }), { status: 409, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
        }
        const loc = room.locations[round];
        const distKm = loc ? haversineKm(lat || 0, lng || 0, loc.lat, loc.lng) : 99999;
        room.guesses[roundKey][googleId] = { lat: lat || 0, lng: lng || 0, distKm, submittedAt: Date.now() };
        await saveRoomData(env, roomCode, room);

        // Check if all players have guessed
        const guessedCount = Object.keys(room.guesses[roundKey]).length;
        const totalPlayers = room.players.length;
        const allGuessed = guessedCount >= totalPlayers;

        let roundResults = null;
        if (allGuessed) {
          roundResults = buildRoundResults(room, round);
        }

        return new Response(JSON.stringify({ success: true, allGuessed, roundResults }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
      }

      // ── GUESSR: POLL ROUND STATE ──
      if (path === "/api/guessr/roundstate") {
        const { roomCode, round } = body;
        if (!roomCode || round === undefined) {
          return new Response(JSON.stringify({ error: "Missing fields" }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
        }
        const room = await getRoomData(env, roomCode);
        if (!room) {
          return new Response(JSON.stringify({ error: "Room not found" }), { status: 404, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
        }
        const roundKey = `round_${round}`;
        const guessedCount = Object.keys(room.guesses[roundKey] || {}).length;
        const allGuessed = guessedCount >= room.players.length;
        let roundResults = null;
        if (allGuessed) roundResults = buildRoundResults(room, round);
        return new Response(JSON.stringify({ success: true, allGuessed, guessedCount, totalPlayers: room.players.length, roundResults }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
      }

      // ── GUESSR: FINISH GAME ──
      if (path === "/api/guessr/finish") {
        const { roomCode, googleId, scores } = body;
        if (!roomCode) {
          return new Response(JSON.stringify({ success: true }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
        }
        const room = await getRoomData(env, roomCode);
        if (room) {
          room.status = 'done';
          room.finalScores = scores || [];
          room.finishedAt = Date.now();
          await saveRoomData(env, roomCode, room);
          // Update player stats
          if (scores && scores.length > 0) {
            const sorted = [...scores].sort((a,b) => b.total - a.total);
            for (const s of sorted) {
              const userData = await getUser(env, s.googleId);
              if (userData) {
                if (!userData.stats) userData.stats = { games: 0, won: 0, streak: 0 };
                userData.stats.games = (userData.stats.games || 0) + 1;
                if (s.googleId === sorted[0].googleId) userData.stats.won = (userData.stats.won || 0) + 1;
                await saveUser(env, s.googleId, userData);
              }
            }
          }
        }
        return new Response(JSON.stringify({ success: true }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
      }


// ── PASTE THIS HELPER FUNCTION at the top of your worker (outside the handler) ──

function buildRoundResults(room, round) {
  const roundKey = `round_${round}`;
  const guesses = room.guesses[roundKey] || {};
  const loc = room.locations[round];
  const totalPlayers = room.players.length;

  const results = room.players.map(p => {
    const g = guesses[p.googleId];
    const lat = g ? g.lat : 0;
    const lng = g ? g.lng : 0;
    const distKm = loc ? haversineKm(lat, lng, loc.lat, loc.lng) : 99999;
    return { googleId: p.googleId, name: p.name, lat, lng, distKm, pts: 0 };
  });

  results.sort((a, b) => a.distKm - b.distKm);
  results.forEach((r, i) => {
    r.placement = i + 1;
    r.pts = calcPoints(r.distKm, i + 1, totalPlayers);
  });

  return results;
}
