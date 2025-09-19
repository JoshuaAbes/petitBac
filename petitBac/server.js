const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { customAlphabet } = require("nanoid");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// --- Utilitaires ---
const nanoid = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 5); // ex: P7K3Q
const randomLetter = () => {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const pool = letters.split("").filter((l) => !["W", "X", "Y", "Z"].includes(l));
  return pool[Math.floor(Math.random() * pool.length)];
};

// --- Mémoire (simple, en RAM) ---
const games = new Map();
/*
Game = {
  code, hostId, players, status, round, letter, categories,
  reviewIndex
}
*/

// === Routes REST optionnelles ===
app.get("/health", (_, res) => res.json({ ok: true }));

// === Socket.IO ===
io.on("connection", (socket) => {
  // Utilitaire pour ne compter que les joueurs qui jouent (hors MC si non joueur)
  function playingPlayers(game) {
    return [...game.players.values()].filter((p) => !(p.id === game.hostId && !game.hostPlays));
  }

  // Création de partie par le MC
  socket.on("createGame", ({ name, categories, hostPlays = true, endMode = 'all' }) => {
    const code = nanoid();
    const game = {
      code,
      hostId: socket.id,
      players: new Map(),
      status: "lobby",
      round: 0,
      letter: null,
      categories: categories && categories.length ? categories : [
        "Fruit","Objet très utile sur une île déserte","Hobby","Sport un peu niche","Arme","Site internet"
      ],
      reviewIndex: 0,
      hostPlays: !!hostPlays,
      endMode: endMode === 'first' ? 'first' : 'all',
    };

    socket.join(code);
    if (hostPlays !== false) {
      game.players.set(socket.id, {
        id: socket.id,
        name: name?.trim() || "Maître",
        isHost: true,
        joinedAt: Date.now(),
        submitted: false,
        answers: {},
        validations: {},
        score: 0,
      });
    }

    games.set(code, game);
    io.to(code).emit("lobbyUpdate", publicGame(game));
    socket.emit("created", { code, youAreHost: true });
  });

  // Rejoindre une partie
  socket.on("joinGame", ({ code, name }) => {
    const game = games.get((code || "").toUpperCase());
    if (!game) return socket.emit("errorMsg", "Code de partie invalide.");
    if (game.status !== "lobby") return socket.emit("errorMsg", "La partie a déjà démarré.");

    socket.join(game.code);
    game.players.set(socket.id, {
      id: socket.id,
      name: (name || "Invité").slice(0, 20),
      isHost: false,
      joinedAt: Date.now(),
      submitted: false,
      answers: {},
      validations: {},
      score: 0,
    });

    io.to(game.code).emit("lobbyUpdate", publicGame(game));
    socket.emit("joined", { code: game.code, youAreHost: false });
  });

  // Lancer un round par le MC
  socket.on("startRound", ({ code, letter, categories }) => {
    const game = games.get(code);
    if (!game || socket.id !== game.hostId) return;

    if (Array.isArray(categories) && categories.length) game.categories = categories;

    game.status = "playing";
    game.round += 1;
    game.letter = letter || randomLetter();

    for (const p of game.players.values()) {
      p.submitted = false;
      p.answers = {};
      p.validations = {};
      p.draft = {};           // <— nouveau : brouillon
    }

    io.to(code).emit("roundStarted", {
      round: game.round,
      letter: game.letter,
      categories: game.categories,
      endMode: game.endMode,  // <— utile pour afficher le mode côté client
    });
  });

  // draft d'un joueur (réponse temporaire)
  socket.on('draft', ({ code, answers }) => {
    const game = games.get(code);
    if (!game) return;
    const p = game.players.get(socket.id);
    if (!p) return;
    p.draft = { ...(answers || {}) };
  });

  // Soumission des réponses par un joueur
  socket.on("submitAnswers", ({ code, answers }) => {
    const game = games.get(code);
    if (!game || game.status !== "playing") return;
    const player = game.players.get(socket.id);
    if (!player) return;

    // Le joueur qui envoie : on fige ses réponses
    player.submitted = true;
    player.answers = answers || player.draft || {};

    if (game.endMode === 'first') {
      // ➜ Premier qui valide : on fige TOUT LE MONDE avec leur brouillon
      for (const p of game.players.values()) {
        if (!p.submitted) {
          p.submitted = true;
          p.answers = p.draft || {};
        }
      }
      game.status = "review";
      io.to(code).emit("reviewPhase", reviewPayload(game));
      io.to(code).emit("reviewNavigate", { index: game.reviewIndex ?? 0 });
      return;
    }

    // ➜ Mode "tous doivent valider"
    const submitted = playingPlayers(game).filter((p) => p.submitted).length;
    const total = playingPlayers(game).length;

    io.to(code).emit("progress", { submitted, total });

    if (submitted === total) {
      game.status = "review";
      io.to(code).emit("reviewPhase", reviewPayload(game));
      io.to(code).emit("reviewNavigate", { index: game.reviewIndex ?? 0 });
    }
  });

  // Passage manuel en phase de review par le MC
  socket.on("forceReview", ({ code }) => {
    const game = games.get(code);
    if (!game || socket.id !== game.hostId) return;

    for (const p of game.players.values()) {
      if (!p.submitted) {
        p.submitted = true;
        p.answers = p.draft || {};
      }
    }
    game.status = "review";
    io.to(code).emit("reviewPhase", reviewPayload(game));
    io.to(code).emit("reviewNavigate", { index: game.reviewIndex ?? 0 });
  });

  // Le MC change de thème pendant la review → on synchronise tout le monde
  socket.on("setReviewIndex", ({ code, index }) => {
    const game = games.get(code);
    if (!game || socket.id !== game.hostId) return; // sécurité: seul le MC
    const max = (game.categories?.length || 1) - 1;
    const i = Math.max(0, Math.min(index | 0, max));
    game.reviewIndex = i;
    io.to(code).emit("reviewNavigate", { index: i });
  });

  // Validation/Invalidation d'une réponse par le MC
  socket.on("toggleValidation", ({ code, playerId, category }) => {
    const game = games.get(code);
    if (!game || socket.id !== game.hostId) return;
    const p = game.players.get(playerId);
    if (!p) return;

    const key = category;
    p.validations[key] = !p.validations[key];
    io.to(code).emit("validationUpdated", {
      playerId,
      category: key,
      valid: p.validations[key],
    });
  });

  // Fin de round & calcul des scores
  socket.on("endRound", ({ code }) => {
    const game = games.get(code);
    if (!game || socket.id !== game.hostId) return;

    // Score = somme des validations (1 point par ✓)
    for (const p of game.players.values()) {
      const gained = Object.values(p.validations).filter(Boolean).length;
      p.score += gained;
    }
    game.status = "lobby";

    io.to(code).emit("roundEnded", {
      leaderboard: leaderboard(game),
      nextReady: true,
    });
    io.to(code).emit("lobbyUpdate", publicGame(game));
  });

  // Déconnexion
  socket.on("disconnect", () => {
    for (const game of games.values()) {
      if (game.players.has(socket.id)) {
        const wasHost = socket.id === game.hostId;
        game.players.delete(socket.id);
        if (game.players.size === 0) {
          games.delete(game.code);
        } else {
          if (wasHost) {
            const next = [...game.players.values()].sort((a,b)=>a.joinedAt-b.joinedAt)[0];
            if (next) game.hostId = next.id;
          }
          io.to(game.code).emit("lobbyUpdate", publicGame(game));
        }
        break;
      }
    }
  });

  // draft d'un joueur (réponse temporaire)
socket.on('draft', ({ code, answers }) => {
  const game = games.get(code);
  if (!game) return;
  const p = game.players.get(socket.id);
  if (!p) return;
  p.draft = { ...(answers || {}) }; // on mémorise une copie
});
});

// --- Helpers pour payloads sûrs ---
function publicGame(game) {
  return {
    code: game.code,
    status: game.status,
    round: game.round,
    letter: game.letter,
    categories: game.categories,
    hostPlays: game.hostPlays,   // <—
    endMode: game.endMode,       // <—
    players: [...game.players.values()].map(p => ({
      id: p.id, name: p.name, score: p.score, submitted: p.submitted, isHost: p.id === game.hostId,
    })),
  };
}

function reviewPayload(game) {
  return {
    code: game.code,
    letter: game.letter,
    categories: game.categories,
    reviewIndex: game.reviewIndex ?? 0,
    players: [...game.players.values()].map(p => ({
      id: p.id, name: p.name, answers: p.answers, validations: p.validations,
    })),
  };
}

function leaderboard(game) {
  return [...game.players.values()]
    .map((p) => ({ id: p.id, name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Petit Bac server on http://localhost:" + PORT));
