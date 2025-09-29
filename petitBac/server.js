// --- Core & setup ------------------------------------------------------------
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { customAlphabet } = require("nanoid");
const fs = require("fs");
const path = require("path");

// Serveur web
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// --- Constantes & utilitaires -----------------------------------------------
const nanoid = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 5);

const DEFAULT_CATEGORIES = [
  "Fruit",
  "Objet très utile sur une île déserte",
  "Hobby",
  "Sport un peu niche",
  "Arme",
  "Site internet",
];

// Lecture robuste du fichier de thèmes (ne jette jamais)
function loadCategoriesFile() {
  const candidates = [
    path.join(__dirname, "categories.json"),
    path.join(__dirname, "database", "seeders", "categories.json"),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, "utf8");
        const data = JSON.parse(raw);
        if (Array.isArray(data)) return data;
        if (data && Array.isArray(data.categories)) return data.categories;
      }
    } catch (_) {}
  }
  return DEFAULT_CATEGORIES;
}
function pickRandom(arr, n) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}
function randomLetter() {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const pool = letters.split("").filter((l) => !["W", "X", "Y", "Z"].includes(l));
  return pool[Math.floor(Math.random() * pool.length)];
}

// --- État mémoire ------------------------------------------------------------
/*
game = {
  code, hostId, status: 'lobby'|'playing'|'review',
  round, letter, categories, reviewIndex,
  hostPlays, endMode: 'first'|'all', randomThemes,
  players: Map<socketId, { id, name, score, submitted, answers, validations, joinedAt }>
}
*/
const games = new Map();

// --- Routes HTTP min ---------------------------------------------------------
app.get("/health", (_, res) => res.json({ ok: true }));

// --- Socket.IO ---------------------------------------------------------------
io.on("connection", (socket) => {
  // Créer une partie
  socket.on("createGame", ({ name, categories, hostPlays = true, endMode = "all", randomThemes = false }) => {
    const code = nanoid();
    const game = {
      code,
      hostId: socket.id,
      status: "lobby",
      round: 0,
      letter: null,
      categories: Array.isArray(categories) && categories.length ? categories : DEFAULT_CATEGORIES,
      reviewIndex: 0,
      hostPlays: !!hostPlays,
      endMode: endMode === "first" ? "first" : "all",
      randomThemes: !!randomThemes,
      players: new Map(),
    };

    socket.join(code);
    game.players.set(socket.id, {
      id: socket.id,
      name: (name || "Maître").slice(0, 20),
      score: 0,
      submitted: false,
      answers: {},
      validations: {},
      joinedAt: Date.now(),
    });

    games.set(code, game);
    io.to(code).emit("lobbyUpdate", publicGame(game));
    socket.emit("created", { code, youAreHost: true });
  });

  // Rejoindre une partie (même si la partie est en cours)
  socket.on("joinGame", ({ code, name }) => {
    const game = games.get((code || "").toUpperCase());
    if (!game) return socket.emit("errorMsg", "Code de partie invalide.");

    // Si le joueur existe déjà (reconnexion), on met à jour son nom si besoin
    let player = game.players.get(socket.id);
    if (!player) {
      // Si la partie est en lobby ou si on autorise la reconnexion en cours de partie
      player = {
        id: socket.id,
        name: (name || "Joueur").slice(0, 20),
        score: 0,
        submitted: false,
        answers: {},
        validations: {},
        joinedAt: Date.now(),
      };
      game.players.set(socket.id, player);
    } else if (name && player.name !== name) {
      player.name = name.slice(0, 20);
    }

    socket.join(game.code);

    // Envoie l'état actuel selon le status
    if (game.status === "playing") {
      socket.emit("roundStarted", {
        round: game.round,
        letter: game.letter,
        categories: game.categories,
        endMode: game.endMode,
      });
    } else if (game.status === "review") {
      socket.emit("reviewPhase", reviewPayload(game));
      socket.emit("reviewNavigate", { index: game.reviewIndex ?? 0 });
    } else if (game.status === "lobby") {
      socket.emit("lobbyUpdate", publicGame(game));
    }

    io.to(game.code).emit("lobbyUpdate", publicGame(game));
    socket.emit("joined", { code: game.code, youAreHost: socket.id === game.hostId });
  });

  // Lancer le round
  socket.on("startRound", ({ code, letter, categories }) => {
    const game = games.get(code);
    if (!game || socket.id !== game.hostId) return;

    game.status = "playing";
    game.round += 1;
    game.letter = (letter || randomLetter()).toUpperCase();

    // Catégories : aléatoires depuis JSON ou celles saisies
    if (game.randomThemes) {
      const all = loadCategoriesFile();
      game.categories = pickRandom(all, 6);
    } else if (Array.isArray(categories) && categories.length) {
      game.categories = categories;
    } else if (!game.categories?.length) {
      game.categories = DEFAULT_CATEGORIES;
    }

    // Reset joueurs
    for (const p of game.players.values()) {
      p.submitted = false;
      p.answers = {};
      p.validations = {};
    }

    io.to(code).emit("roundStarted", {
      round: game.round,
      letter: game.letter,
      categories: game.categories,
      endMode: game.endMode,
    });
  });

  // Soumettre ses réponses
  socket.on("submitAnswers", ({ code, answers }) => {
    const game = games.get(code);
    const player = game?.players.get(socket.id);
    if (!game || game.status !== "playing" || !player) return;

    player.submitted = true;
    player.answers = answers || {};

    // Progression
    io.to(code).emit("progress", {
      submitted: [...game.players.values()].filter((p) => p.submitted).length,
      total: game.players.size,
    });

    // Passage en review selon le mode
    const allSubmitted = [...game.players.values()].every((p) => p.submitted);
    if (game.endMode === "first" || allSubmitted) {
      game.status = "review";
      game.reviewIndex = 0;
      io.to(code).emit("reviewPhase", reviewPayload(game));
      io.to(code).emit("reviewNavigate", { index: game.reviewIndex });
    }
  });

  // Forcer review (MC)
  socket.on("forceReview", ({ code }) => {
    const game = games.get(code);
    if (!game || socket.id !== game.hostId) return;
    game.status = "review";
    game.reviewIndex = 0;
    io.to(code).emit("reviewPhase", reviewPayload(game));
    io.to(code).emit("reviewNavigate", { index: game.reviewIndex });
  });

  // Navigation de thèmes en review (MC)
  socket.on("setReviewIndex", ({ code, index }) => {
    const game = games.get(code);
    if (!game || socket.id !== game.hostId) return;
    const max = (game.categories?.length || 1) - 1;
    game.reviewIndex = Math.max(0, Math.min((index | 0), max));
    io.to(code).emit("reviewNavigate", { index: game.reviewIndex });
  });

  // Valider / invalider (MC)
  socket.on("toggleValidation", ({ code, playerId, category }) => {
    const game = games.get(code);
    if (!game || socket.id !== game.hostId) return;
    const p = game.players.get(playerId);
    if (!p) return;
    p.validations[category] = !p.validations[category];
    io.to(code).emit("validationUpdated", {
      playerId,
      category,
      valid: p.validations[category],
    });
  });

  // Fin de round (MC)
  socket.on("endRound", ({ code }) => {
    const game = games.get(code);
    if (!game || socket.id !== game.hostId) return;

    for (const p of game.players.values()) {
      p.score += Object.values(p.validations).filter(Boolean).length;
    }
    game.status = "lobby";

    io.to(code).emit("roundEnded", { leaderboard: leaderboard(game) });
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
            const next = [...game.players.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
            if (next) game.hostId = next.id;
          }
          io.to(game.code).emit("lobbyUpdate", publicGame(game));
        }
        break;
      }
    }
  });
});

// --- Helpers de payload ------------------------------------------------------
function publicGame(game) {
  return {
    code: game.code,
    status: game.status,
    round: game.round,
    letter: game.letter,
    categories: game.categories,
    randomThemes: !!game.randomThemes,
    hostPlays: !!game.hostPlays,
    players: [...game.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      submitted: p.submitted,
      isHost: p.id === game.hostId,
    })),
  };
}
function reviewPayload(game) {
  return {
    code: game.code,
    letter: game.letter,
    categories: game.categories,
    players: [...game.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      answers: p.answers,
      validations: p.validations,
    })),
  };
}
function leaderboard(game) {
  return [...game.players.values()]
    .map((p) => ({ id: p.id, name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score);
}

// --- Start -------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Petit Bac server on http://localhost:${PORT}`));
