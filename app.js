(() => {
  "use strict";

  const STORAGE_KEY = "futex-data-v1";
  const LEGACY_STORAGE_KEY = "exp-fut-data-v1";
  const FIELD_ATTRIBUTES = [
    { key: "velocidade", label: "Velocidade", short: "VEL" },
    { key: "chute", label: "Chute", short: "CHU" },
    { key: "passe", label: "Passe", short: "PAS" },
    { key: "drible", label: "Drible", short: "DRI" },
    { key: "defesa", label: "Defesa", short: "DEF" },
    { key: "visao", label: "Visão", short: "VIS" },
  ];
  const GOALKEEPER_ATTRIBUTES = [
    { key: "elasticidade", label: "Elasticidade", short: "ELA" },
    { key: "reflexo", label: "Reflexo", short: "REF" },
    { key: "posicionamento", label: "Posicionamento", short: "POS" },
    { key: "reposicao", label: "Reposição", short: "REP" },
  ];

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#039;", '"': "&quot;" }[char]));

  let state = loadState();
  let pendingPhoto = "";
  let editingPlayerId = null;
  let detailPlayerId = null;
  let adjustmentDraft = {};
  let toastTimer = null;

  function emptyState() {
    return { players: [], matches: [], draft: null };
  }

  function normalizePending(pending, goalkeeper) {
    if (!Array.isArray(pending)) return [];
    return pending
      .filter((item) => item && typeof item.matchId === "string" && Number(item.delta) !== 0)
      .map((item) => ({
        matchId: item.matchId,
        delta: Number(item.delta) > 0 ? (goalkeeper ? 12 : 18) : (goalkeeper ? -8 : -12),
      }));
  }

  function loadState() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
      const parsed = JSON.parse(stored);
      if (!parsed || !Array.isArray(parsed.players) || !Array.isArray(parsed.matches)) return emptyState();
      parsed.players = parsed.players.map((player) => ({
        ...player,
        archived: Boolean(player.archived),
        manualAdjustment: Boolean(player.manualAdjustment),
        pending: normalizePending(player.pending, Boolean(player.goalkeeper)),
      }));
      parsed.draft = parsed.draft || null;
      if (parsed.draft) {
        const activeIds = new Set(parsed.players.filter((player) => !player.archived).map((player) => player.id));
        parsed.draft.teamA = Array.isArray(parsed.draft.teamA) ? parsed.draft.teamA.filter((id) => activeIds.has(id)) : [];
        parsed.draft.teamB = Array.isArray(parsed.draft.teamB) ? parsed.draft.teamB.filter((id) => activeIds.has(id)) : [];
        parsed.draft.excluded = Array.isArray(parsed.draft.excluded) ? parsed.draft.excluded.filter((id) => activeIds.has(id)) : [];
      }
      return parsed;
    } catch {
      return emptyState();
    }
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      showToast("Não foi possível salvar. A foto pode ser grande demais para este navegador.", true);
    }
  }

  function exportBackup() {
    const backup = {
      application: "FUTEX",
      version: 1,
      exportedAt: new Date().toISOString(),
      data: state,
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "exp.json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast("Backup completo exportado.");
  }

  function normalizeBackup(payload) {
    const raw = payload?.data || payload;
    if (!raw || !Array.isArray(raw.players) || !Array.isArray(raw.matches)) throw new Error("Estrutura inválida");
    const copy = JSON.parse(JSON.stringify(raw));
    const ids = new Set();

    copy.players = copy.players.map((player) => {
      if (!player || typeof player.id !== "string" || !player.id || ids.has(player.id)) throw new Error("Jogador inválido");
      if (typeof player.name !== "string" || !player.name.trim() || !player.attrs || typeof player.attrs !== "object") throw new Error("Jogador inválido");
      ids.add(player.id);
      const goalkeeper = Boolean(player.goalkeeper);
      const definitions = goalkeeper ? GOALKEEPER_ATTRIBUTES : FIELD_ATTRIBUTES;
      const attrs = Object.fromEntries(definitions.map((item) => {
        const value = Number(player.attrs[item.key]);
        if (!Number.isFinite(value)) throw new Error("Atributos inválidos");
        return [item.key, Math.max(0, Math.min(99, Math.round(value)))];
      }));
      return {
        id: player.id,
        name: player.name.trim().slice(0, 28),
        photo: typeof player.photo === "string" && player.photo.startsWith("data:image/") ? player.photo : "",
        goalkeeper,
        archived: Boolean(player.archived),
        manualAdjustment: Boolean(player.manualAdjustment),
        attrs,
        pending: normalizePending(player.pending, goalkeeper),
        createdAt: typeof player.createdAt === "string" ? player.createdAt : new Date().toISOString(),
      };
    });

    copy.matches = copy.matches.map((match, index) => {
      if (!match || typeof match.id !== "string" || !Array.isArray(match.teamA) || !Array.isArray(match.teamB)) throw new Error("Partida inválida");
      const scoreA = Number(match.scoreA);
      const scoreB = Number(match.scoreB);
      if (!Number.isInteger(scoreA) || !Number.isInteger(scoreB) || scoreA < 0 || scoreB < 0 || scoreA === scoreB) throw new Error("Placar inválido");
      return {
        id: match.id,
        number: Number.isInteger(match.number) ? match.number : index + 1,
        createdAt: typeof match.createdAt === "string" ? match.createdAt : new Date().toISOString(),
        teamA: match.teamA.filter((id) => ids.has(id)),
        teamB: match.teamB.filter((id) => ids.has(id)),
        scoreA,
        scoreB,
        completed: true,
      };
    });

    const activeIds = new Set(copy.players.filter((player) => !player.archived).map((player) => player.id));
    if (copy.draft && Array.isArray(copy.draft.teamA) && Array.isArray(copy.draft.teamB)) {
      copy.draft = {
        teamA: copy.draft.teamA.filter((id) => activeIds.has(id)),
        teamB: copy.draft.teamB.filter((id) => activeIds.has(id)),
        excluded: Array.isArray(copy.draft.excluded) ? copy.draft.excluded.filter((id) => activeIds.has(id)) : [],
        scoreA: copy.draft.scoreA === undefined ? "" : String(copy.draft.scoreA),
        scoreB: copy.draft.scoreB === undefined ? "" : String(copy.draft.scoreB),
      };
    } else {
      copy.draft = null;
    }
    return copy;
  }

  async function loadServerData() {
    try {
      const response = await fetch("exp.json", { cache: "no-store" });
      if (!response.ok) {
        if (response.status !== 404) showToast("Não foi possível carregar o exp.json do servidor.", true);
        return;
      }
      state = normalizeBackup(await response.json());
      saveState();
      renderAll();
      showToast("Dados carregados automaticamente do exp.json.");
    } catch {
      if (window.location.protocol !== "file:") showToast("O exp.json existe, mas não pôde ser lido.", true);
    }
  }

  async function importBackup(file) {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const imported = normalizeBackup(parsed);
      const confirmed = window.confirm(`Importar ${imported.players.length} jogadores e ${imported.matches.length} partidas? Os dados atuais serão substituídos.`);
      if (!confirmed) return;
      state = imported;
      saveState();
      renderAll();
      setScreen("players");
      showToast("Backup importado com sucesso.");
    } catch {
      showToast("Este arquivo não é um backup válido do FUTEX.", true);
    } finally {
      $("#importDataInput").value = "";
    }
  }

  function attributesFor(player) {
    return player.goalkeeper ? GOALKEEPER_ATTRIBUTES : FIELD_ATTRIBUTES;
  }

  function activePlayers() {
    return state.players.filter((player) => !player.archived);
  }

  function archivedPlayers() {
    return state.players.filter((player) => player.archived);
  }

  function overall(player) {
    const attributes = attributesFor(player);
    const total = attributes.reduce((sum, item) => sum + Number(player.attrs[item.key] || 0), 0);
    return total / attributes.length;
  }

  function formatOverall(value) {
    const rounded = Math.round(value * 10) / 10;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  }

  function tierFor(value) {
    if (value < 65) return { key: "bronze", name: "Bronze" };
    if (value < 75) return { key: "silver", name: "Silver" };
    if (value < 85) return { key: "gold", name: "Gold" };
    if (value < 95) return { key: "toty", name: "TOTY" };
    return { key: "legend", name: "Legend" };
  }

  function initials(name) {
    return String(name).trim().split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase();
  }

  function photoMarkup(player, avatar = false) {
    if (player.photo) return `<img src="${escapeHtml(player.photo)}" alt="Foto de ${escapeHtml(player.name)}">`;
    return avatar ? escapeHtml(initials(player.name)) : `<span class="photo-fallback">${escapeHtml(initials(player.name))}</span>`;
  }

  function cardAttributeOrder(player) {
    if (player.goalkeeper) return GOALKEEPER_ATTRIBUTES;
    return [FIELD_ATTRIBUTES[0], FIELD_ATTRIBUTES[3], FIELD_ATTRIBUTES[1], FIELD_ATTRIBUTES[4], FIELD_ATTRIBUTES[2], FIELD_ATTRIBUTES[5]];
  }

  function exportDateLabel() {
    return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date());
  }

  function cardMarkup(player, large = false) {
    const value = overall(player);
    const tier = tierFor(value);
    const visibleStats = player.goalkeeper ? GOALKEEPER_ATTRIBUTES.slice(0, 3) : [FIELD_ATTRIBUTES[0], FIELD_ATTRIBUTES[1], FIELD_ATTRIBUTES[2]];
    const statMarkup = large
      ? cardAttributeOrder(player).map((item) => `<span class="card-attribute"><b>${player.attrs[item.key]}</b>${item.short}</span>`).join("")
      : visibleStats.map((item) => `<span><b>${player.attrs[item.key]}</b>${item.short}</span>`).join("");

    return `
      <article class="fifa-card tier-${tier.key} ${large ? `large-card ${player.goalkeeper ? "gk-card" : ""}` : "mini-card"}">
        <div class="card-topline">
          <div class="card-rating"><strong>${formatOverall(value)}</strong><span>${player.goalkeeper ? "GOL" : "OVR"}</span></div>
          <span class="tier-name">${tier.name}</span>
        </div>
        <div class="player-photo">${photoMarkup(player)}</div>
        <div class="card-name">${escapeHtml(player.name)}</div>
        <div class="${large ? "card-attributes" : "mini-stats"}">${statMarkup}</div>
        ${large ? `<div class="card-export-date">FUTEX · ${exportDateLabel()}</div>` : ""}
      </article>`;
  }

  function showToast(message, isError = false) {
    const toast = $("#toast");
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.toggle("error", isError);
    toast.classList.add("show");
    toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
  }

  function renderAll() {
    renderPlayers();
    renderArchivedPlayers();
    renderMatches();
    updateHeaderAction();
  }

  function renderPlayers() {
    const grid = $("#playerGrid");
    const players = activePlayers();
    const archived = archivedPlayers();
    $("#playerCount").textContent = players.length;
    $("#squadAverage").textContent = players.length
      ? formatOverall(players.reduce((sum, player) => sum + overall(player), 0) / players.length)
      : "—";
    $("#archivedPlayersBtn").textContent = archived.length ? `Arquivados (${archived.length})` : "Arquivados";

    if (!players.length) {
      grid.innerHTML = `
        <div class="empty-state">
          <div>
            <span class="empty-state-icon">＋</span>
            <h3>${archived.length ? "Nenhum jogador ativo" : "Seu elenco começa aqui"}</h3>
            <p>${archived.length ? "Restaure um jogador arquivado ou crie um novo para voltar a montar partidas." : "Crie o primeiro jogador. Todos começam com 60 em cada atributo e uma carta Bronze."}</p>
            ${archived.length ? `<button class="ghost-btn" data-open-archived>Ver arquivados</button>` : `<button class="primary-btn" data-create-player>+ Criar primeiro jogador</button>`}
          </div>
        </div>`;
      return;
    }

    grid.innerHTML = `
      <div class="player-list-head" aria-hidden="true">
        <span>Jogador</span><span>Overall</span><span>Partidas</span><span>Vitórias</span><span>Aproveitamento</span><span></span>
      </div>` + [...players]
      .map((player) => ({ player, stats: playerStats(player) }))
      .sort((a, b) => b.stats.wins - a.stats.wins
        || b.stats.winRate - a.stats.winRate
        || b.stats.matches - a.stats.matches
        || a.player.name.localeCompare(b.player.name, "pt-BR"))
      .map(({ player, stats }) => {
        return `
          <button class="player-list-row ${player.goalkeeper ? "goalkeeper-row" : ""}" data-player-id="${player.id}" aria-label="Abrir carta de ${escapeHtml(player.name)}">
            <span class="list-player">
              <span class="list-avatar-wrap">
                <span class="list-avatar">${photoMarkup(player, true)}</span>
                ${player.pending.length ? `<span class="list-pending-star" title="${player.pending.length} ajuste(s) pendente(s)">*<small>${player.pending.length}</small></span>` : ""}
              </span>
              <span class="list-player-copy">
                <strong>${escapeHtml(player.name)}</strong>
                <span class="list-player-meta">
                  <span class="list-player-tier">${tierFor(overall(player)).name}</span>
                  ${player.manualAdjustment ? `<span class="manual-adjustment-badge">Ajuste manual</span>` : ""}
                </span>
              </span>
            </span>
            <span class="list-stat overall"><small>Overall</small><strong>${formatOverall(overall(player))}</strong></span>
            <span class="list-stat"><small>Partidas</small><strong>${stats.matches}</strong></span>
            <span class="list-stat"><small>Vitórias</small><strong>${stats.wins}</strong></span>
            <span class="list-stat win-rate"><small>Aproveitamento</small><strong>${stats.winRate}%</strong></span>
            <span class="list-chevron">›</span>
          </button>`;
      }).join("");
  }

  function renderArchivedPlayers() {
    const container = $("#archivedPlayerList");
    if (!container) return;
    const players = archivedPlayers().sort((a, b) => overall(b) - overall(a) || a.name.localeCompare(b.name, "pt-BR"));
    if (!players.length) {
      container.innerHTML = `<div class="history-empty archived-empty">Nenhum jogador arquivado.</div>`;
      return;
    }
    container.innerHTML = players.map((player) => {
      const stats = playerStats(player);
      return `
        <div class="archived-player-row ${player.goalkeeper ? "goalkeeper-row" : ""}">
          <button class="archived-player-open" data-archived-player-id="${player.id}" aria-label="Abrir carta de ${escapeHtml(player.name)}">
            <span class="list-avatar">${photoMarkup(player, true)}</span>
            <span class="list-player-copy"><strong>${escapeHtml(player.name)}</strong><span>${tierFor(overall(player)).name} · ${formatOverall(overall(player))} OVR · ${stats.matches} ${stats.matches === 1 ? "partida" : "partidas"}</span></span>
          </button>
          <button class="primary-btn restore-player-btn" data-unarchive-player="${player.id}">Restaurar</button>
        </div>`;
    }).join("");
  }

  function openPlayer(playerId) {
    const player = state.players.find((item) => item.id === playerId);
    if (!player) return;
    detailPlayerId = playerId;
    adjustmentDraft = Object.fromEntries(attributesFor(player).map((item) => [item.key, 0]));
    renderPlayerDetail();
    $("#playerDialog").showModal();
  }

  function openArchivedPlayers() {
    renderArchivedPlayers();
    $("#archivedPlayersDialog").showModal();
  }

  function archivePlayer(playerId) {
    const player = state.players.find((item) => item.id === playerId);
    if (!player || player.archived) return;
    player.archived = true;
    if (state.draft) {
      state.draft.teamA = state.draft.teamA.filter((id) => id !== playerId);
      state.draft.teamB = state.draft.teamB.filter((id) => id !== playerId);
      state.draft.excluded = state.draft.excluded.filter((id) => id !== playerId);
    }
    saveState();
    if ($("#playerDialog").open) $("#playerDialog").close();
    renderAll();
    showToast(`${player.name} foi arquivado e não entrará nos próximos sorteios.`);
  }

  function unarchivePlayer(playerId) {
    const player = state.players.find((item) => item.id === playerId);
    if (!player || !player.archived) return;
    player.archived = false;
    saveState();
    renderAll();
    if ($("#playerDialog").open && detailPlayerId === playerId) renderPlayerDetail();
    showToast(`${player.name} voltou ao elenco ativo.`);
  }

  function matchNumber(match) {
    return match.number || state.matches.findIndex((item) => item.id === match.id) + 1;
  }

  function formatDate(value, includeTime = false) {
    const options = includeTime
      ? { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }
      : { day: "2-digit", month: "short", year: "numeric" };
    return new Intl.DateTimeFormat("pt-BR", options).format(new Date(value));
  }

  function playerMatchHistory(player) {
    return [...state.matches]
      .filter((match) => match.teamA.includes(player.id) || match.teamB.includes(player.id))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  function didPlayerWin(match, playerId) {
    const onA = match.teamA.includes(playerId);
    return onA ? match.scoreA > match.scoreB : match.scoreB > match.scoreA;
  }

  function playerStats(player) {
    const history = playerMatchHistory(player);
    const wins = history.filter((match) => didPlayerWin(match, player.id)).length;
    return { matches: history.length, wins, winRate: history.length ? Math.round((wins / history.length) * 100) : 0 };
  }

  function renderPlayerDetail() {
    const player = state.players.find((item) => item.id === detailPlayerId);
    if (!player) return;
    const history = playerMatchHistory(player);
    const tier = tierFor(overall(player));

    $("#playerDetail").innerHTML = `
      <div class="player-detail-grid">
        <div class="card-stage">${cardMarkup(player, true)}</div>
        <div class="detail-side">
          <div class="detail-title detail-title-row">
            <div>
              <p class="eyebrow">${player.archived ? "ARQUIVADO · " : ""}JOGADOR</p>
              <h2>${escapeHtml(player.name)}</h2>
              <p>Carta ${tier.name} · Overall ${formatOverall(overall(player))} · ${history.length} ${history.length === 1 ? "partida" : "partidas"}</p>
            </div>
            <div class="detail-actions">
              <button class="ghost-btn" data-export-card="${player.id}">↓ Exportar carta</button>
              <button class="ghost-btn" data-edit-player="${player.id}">Editar</button>
              ${player.archived
                ? `<button class="primary-btn" data-unarchive-player="${player.id}">Restaurar</button>`
                : `<button class="danger-btn" data-archive-player="${player.id}">Arquivar</button>`}
            </div>
          </div>
          ${player.pending.length ? adjustmentMarkup(player) : ""}
          <section class="player-history">
            <h3>Histórico do jogador</h3>
            <div class="player-history-list">
              ${history.length ? history.map((match) => {
                const win = didPlayerWin(match, player.id);
                return `<div class="player-history-row">
                  <span>Partida #${matchNumber(match)} · ${formatDate(match.createdAt)}</span>
                  <strong>${match.scoreA} × ${match.scoreB}</strong>
                  <span class="result-status ${win ? "win" : "loss"}">${win ? "VITÓRIA" : "DERROTA"}</span>
                </div>`;
              }).join("") : `<div class="history-empty">Este jogador ainda não entrou em campo.</div>`}
            </div>
          </section>
        </div>
      </div>`;
  }

  async function exportPlayerCard(playerId) {
    const player = state.players.find((item) => item.id === playerId);
    const card = $("#playerDetail .large-card");
    if (!player || !card || typeof window.html2canvas !== "function") {
      showToast("Não foi possível preparar a imagem da carta.", true);
      return;
    }
    try {
      if (document.fonts?.ready) await document.fonts.ready;
      const canvas = await window.html2canvas(card, {
        backgroundColor: null,
        scale: 3,
        useCORS: true,
        logging: false,
      });
      const safeName = player.name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "jogador";
      const link = document.createElement("a");
      link.download = `carta-${safeName}-${new Date().toISOString().slice(0, 10)}.png`;
      link.href = canvas.toDataURL("image/png");
      document.body.appendChild(link);
      link.click();
      link.remove();
      showToast("Carta exportada em PNG com a data.");
    } catch {
      showToast("Não foi possível exportar esta carta.", true);
    }
  }

  function adjustmentContext(player) {
    const pending = player.pending[0];
    const sign = pending.delta > 0 ? 1 : -1;
    const requested = Math.abs(pending.delta);
    const attributes = attributesFor(player);
    const capacity = attributes.reduce((sum, item) => sum + (sign > 0 ? 99 - player.attrs[item.key] : player.attrs[item.key]), 0);
    const target = Math.min(requested, capacity);
    const used = attributes.reduce((sum, item) => sum + (adjustmentDraft[item.key] || 0), 0);
    return { pending, sign, attributes, requested, target, used, remaining: target - used };
  }

  function adjustmentMarkup(player) {
    const context = adjustmentContext(player);
    const match = state.matches.find((item) => item.id === context.pending.matchId);
    const win = context.sign > 0;
    return `
      <section class="pending-adjustment ${win ? "" : "loss-adjustment"}">
        <div class="adjustment-head">
          <div>
            <h3>* ${win ? `Vitória: distribua +${context.requested} pontos` : `Derrota: remova ${context.requested} pontos`}</h3>
            <p>${match ? `Partida #${matchNumber(match)} · ${match.scoreA} × ${match.scoreB}` : "Ajuste pendente"}${context.target < context.requested ? ` · limite aplicável: ${context.target}` : ""}</p>
          </div>
          <div class="points-left"><strong>${context.remaining}</strong><span>restantes</span></div>
        </div>
        <div class="adjustment-rows">
          ${context.attributes.map((item) => {
            const allocated = adjustmentDraft[item.key] || 0;
            const current = player.attrs[item.key];
            const preview = current + context.sign * allocated;
            const canAdd = context.remaining > 0 && (context.sign > 0 ? preview < 99 : preview > 0);
            return `<div class="adjustment-row">
              <span>${item.label} <small>(${current})</small></span>
              <strong class="preview-value">${preview}</strong>
              <div class="stepper">
                <button data-adjust-key="${item.key}" data-adjust-step="-1" ${allocated <= 0 ? "disabled" : ""} aria-label="Retirar um ponto de ${item.label}">−</button>
                <button data-adjust-key="${item.key}" data-adjust-step="1" ${canAdd ? "" : "disabled"} aria-label="Aplicar um ponto em ${item.label}">＋</button>
              </div>
            </div>`;
          }).join("")}
        </div>
        <button class="primary-btn apply-adjustment" data-apply-adjustment ${context.remaining === 0 ? "" : "disabled"}>Confirmar ajuste</button>
      </section>`;
  }

  function changeAdjustment(key, step) {
    const player = state.players.find((item) => item.id === detailPlayerId);
    if (!player) return;
    const context = adjustmentContext(player);
    const currentAllocated = adjustmentDraft[key] || 0;
    if (step < 0 && currentAllocated > 0) adjustmentDraft[key] = currentAllocated - 1;
    if (step > 0 && context.remaining > 0) {
      const preview = player.attrs[key] + context.sign * currentAllocated;
      if ((context.sign > 0 && preview < 99) || (context.sign < 0 && preview > 0)) adjustmentDraft[key] = currentAllocated + 1;
    }
    renderPlayerDetail();
  }

  function applyAdjustment() {
    const player = state.players.find((item) => item.id === detailPlayerId);
    if (!player || !player.pending.length) return;
    const context = adjustmentContext(player);
    if (context.remaining !== 0) return;
    context.attributes.forEach((item) => {
      player.attrs[item.key] = Math.max(0, Math.min(99, player.attrs[item.key] + context.sign * (adjustmentDraft[item.key] || 0)));
    });
    player.pending.shift();
    adjustmentDraft = Object.fromEntries(attributesFor(player).map((item) => [item.key, 0]));
    saveState();
    renderAll();
    renderPlayerDetail();
    showToast(player.pending.length ? "Ajuste aplicado. Há outro resultado pendente." : "Atributos atualizados com sucesso.");
  }

  function renderMatches() {
    $("#matchCount").textContent = state.matches.length;
    $("#totalGoals").textContent = state.matches.reduce((sum, match) => sum + match.scoreA + match.scoreB, 0);
    renderMatchBuilder();
    renderMatchHistory();
  }

  function renderMatchBuilder() {
    const builder = $("#matchBuilder");
    if (!state.draft) {
      const players = activePlayers();
      const canGenerate = players.length >= 2;
      const goalkeeperCount = players.filter((player) => player.goalkeeper).length;
      builder.innerHTML = `
        <div class="builder-empty">
          <div>
            <p class="eyebrow">MONTAGEM AUTOMÁTICA</p>
            <h2>Pronto para a próxima?</h2>
            <p>O FUTEX compara o overall de todo o elenco e distribui os jogadores entre dois lados com a menor diferença possível.</p>
            ${players.length % 2 === 1 && players.length > 1 ? `<p class="builder-warning">Seu elenco ativo tem número ímpar; um lado ficará com um jogador a mais até você ajustar.</p>` : ""}
            ${players.length >= 2 && goalkeeperCount < 2 ? `<p class="builder-warning">Mantenha pelo menos dois goleiros ativos para garantir um em cada lado.</p>` : ""}
          </div>
          <button class="primary-btn" data-generate-match ${canGenerate ? "" : "disabled"}>Gerar partida</button>
        </div>`;
      return;
    }

    const draft = state.draft;
    builder.innerHTML = `
      <div class="draft-shell">
        <div class="draft-head">
          <div><h2>Partida em preparação</h2><p>Você ainda pode mover ou retirar jogadores antes de confirmar o resultado.</p></div>
          <div class="draft-actions">
            <button class="ghost-btn" data-regenerate-match>Gerar novamente</button>
            <button class="danger-btn" data-cancel-draft>Cancelar</button>
          </div>
        </div>
        <div class="teams-grid">
          ${draftTeamMarkup("A", draft.teamA)}
          <div class="versus">VS</div>
          ${draftTeamMarkup("B", draft.teamB)}
        </div>
        ${draft.excluded.length ? excludedMarkup(draft.excluded) : ""}
        <div class="score-panel">
          <div class="score-panel-copy"><h3>Resultado final</h3><p>Empates não são permitidos porque cada jogador precisa receber vitória ou derrota.</p></div>
          <button class="primary-btn" data-confirm-match>Confirmar partida</button>
        </div>
      </div>`;
  }

  function playersByIds(ids) {
    return ids.map((id) => state.players.find((player) => player.id === id)).filter(Boolean);
  }

  function sortedTeamPlayers(ids) {
    return playersByIds(ids).sort((a, b) => Number(b.goalkeeper) - Number(a.goalkeeper) || overall(b) - overall(a) || a.name.localeCompare(b.name, "pt-BR"));
  }

  function teamStats(ids) {
    const players = playersByIds(ids);
    const total = players.reduce((sum, player) => sum + overall(player), 0);
    return { average: players.length ? total / players.length : 0 };
  }

  function draftTeamMarkup(side, ids) {
    const players = sortedTeamPlayers(ids);
    const stats = teamStats(ids);
    const destination = side === "A" ? "B" : "A";
    const scoreKey = side === "A" ? "scoreA" : "scoreB";
    return `
      <section class="team-panel team-${side.toLowerCase()}">
        <div class="team-head">
          <div><h3>Lado ${side}</h3><p>${players.length} ${players.length === 1 ? "jogador" : "jogadores"}</p></div>
          <div class="team-metrics">
            <div class="team-total"><strong>${formatOverall(stats.average)}</strong><span>força média</span></div>
            <div class="team-score"><label for="${scoreKey}">Resultado</label><input id="${scoreKey}" type="number" min="0" max="99" inputmode="numeric" value="${escapeHtml(state.draft[scoreKey])}" placeholder="0"></div>
          </div>
        </div>
        <div class="draft-players">
          ${players.length ? players.map((player) => `
            <div class="draft-player ${player.goalkeeper ? "goalkeeper-player" : ""}">
              <span class="team-avatar-wrap"><span class="avatar">${photoMarkup(player, true)}</span>${player.goalkeeper ? `<span class="goalkeeper-icon" title="Goleiro" aria-label="Goleiro">🧤</span>` : ""}</span>
              <span class="draft-player-copy"><strong>${escapeHtml(player.name)}</strong><span>${tierFor(overall(player)).name}</span></span>
              <span class="ovr-chip">${formatOverall(overall(player))}</span>
              <span class="row-actions">
                <button class="mini-action" data-move-player="${player.id}" data-from="${side}" title="Mover para o Lado ${destination}" aria-label="Mover ${escapeHtml(player.name)} para o lado ${destination}">→</button>
                <button class="mini-action remove" data-remove-player="${player.id}" data-from="${side}" title="Retirar da partida" aria-label="Retirar ${escapeHtml(player.name)} da partida">×</button>
              </span>
            </div>`).join("") : `<div class="team-empty">Nenhum jogador deste lado.</div>`}
        </div>
      </section>`;
  }

  function excludedMarkup(ids) {
    return `
      <div class="excluded-panel">
        <h3>Fora desta partida</h3>
        <div class="excluded-list">
          ${playersByIds(ids).map((player) => `<span class="excluded-player">${escapeHtml(player.name)} <button class="add-btn" data-add-player="${player.id}" data-to="A">+ A</button><button class="add-btn" data-add-player="${player.id}" data-to="B">+ B</button></span>`).join("")}
        </div>
      </div>`;
  }

  function balanceTeams(sourcePlayers = activePlayers(), previousDraft = null) {
    const players = [...sourcePlayers];
    const sizeA = Math.ceil(players.length / 2);
    const previousSignature = previousDraft ? matchupSignature(previousDraft.teamA, previousDraft.teamB) : null;
    const candidates = new Map();
    const attempts = Math.min(1400, Math.max(240, players.length * 100));

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const { teamA, teamB } = randomTeamsWithGoalkeepers(players, sizeA);
      const averageA = teamA.reduce((sum, player) => sum + overall(player), 0) / teamA.length;
      const averageB = teamB.reduce((sum, player) => sum + overall(player), 0) / teamB.length;
      const signature = matchupSignature(teamA.map((player) => player.id), teamB.map((player) => player.id));
      const difference = Math.abs(averageA - averageB);
      if (!candidates.has(signature) || candidates.get(signature).difference > difference) {
        candidates.set(signature, { teamA, teamB, difference, signature });
      }
    }

    const ranked = [...candidates.values()].sort((a, b) => a.difference - b.difference);
    const bestDifference = ranked[0]?.difference || 0;
    let balancedPool = ranked.filter((candidate) => candidate.difference <= bestDifference + 2.25).slice(0, 80);
    const alternatives = balancedPool.filter((candidate) => candidate.signature !== previousSignature);
    if (alternatives.length) balancedPool = alternatives;
    const selected = balancedPool[Math.floor(Math.random() * balancedPool.length)] || ranked[0];

    return {
      teamA: selected.teamA.map((player) => player.id),
      teamB: selected.teamB.map((player) => player.id),
      excluded: [],
      scoreA: "",
      scoreB: "",
    };
  }

  function shufflePlayers(players) {
    const shuffled = [...players];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
    }
    return shuffled;
  }

  function randomTeamsWithGoalkeepers(players, sizeA) {
    const sizeB = players.length - sizeA;
    const goalkeepers = shufflePlayers(players.filter((player) => player.goalkeeper));
    const fieldPlayers = shufflePlayers(players.filter((player) => !player.goalkeeper));
    const teamA = [];
    const teamB = [];

    if (goalkeepers.length >= 2 && sizeA > 0 && sizeB > 0) {
      teamA.push(goalkeepers.shift());
      teamB.push(goalkeepers.shift());
    }

    const remaining = shufflePlayers([...goalkeepers, ...fieldPlayers]);
    remaining.forEach((player) => {
      if (teamA.length >= sizeA) teamB.push(player);
      else if (teamB.length >= sizeB) teamA.push(player);
      else if (Math.random() < .5) teamA.push(player);
      else teamB.push(player);
    });

    return { teamA, teamB };
  }

  function matchupSignature(teamA, teamB) {
    const sides = [[...teamA].sort().join(","), [...teamB].sort().join(",")].sort();
    return sides.join("|");
  }

  function generateDraft() {
    const players = activePlayers();
    if (players.length < 2) {
      showToast("Mantenha pelo menos dois jogadores ativos para gerar uma partida.", true);
      return;
    }
    state.draft = balanceTeams(players);
    saveState();
    setScreen("matches");
    renderMatches();
    showToast("Nova combinação equilibrada sorteada.");
  }

  function regenerateDraft() {
    if (!state.draft) {
      generateDraft();
      return;
    }
    const presentIds = [...new Set([...state.draft.teamA, ...state.draft.teamB])];
    const presentPlayers = playersByIds(presentIds).filter((player) => !player.archived);
    if (presentPlayers.length < 2) {
      showToast("Mantenha pelo menos dois jogadores presentes para gerar novamente.", true);
      return;
    }
    const presentSet = new Set(presentIds);
    const excludedIds = activePlayers().map((player) => player.id).filter((id) => !presentSet.has(id));
    const nextDraft = balanceTeams(presentPlayers, state.draft);
    nextDraft.excluded = excludedIds;
    state.draft = nextDraft;
    saveState();
    renderMatches();
    showToast("Nova combinação gerada somente com os jogadores presentes.");
  }

  function moveDraftPlayer(playerId, fromSide) {
    if (!state.draft) return;
    const source = fromSide === "A" ? state.draft.teamA : state.draft.teamB;
    const destination = fromSide === "A" ? state.draft.teamB : state.draft.teamA;
    state.draft[fromSide === "A" ? "teamA" : "teamB"] = source.filter((id) => id !== playerId);
    if (!destination.includes(playerId)) destination.push(playerId);
    saveState();
    renderMatchBuilder();
  }

  function removeDraftPlayer(playerId, fromSide) {
    if (!state.draft) return;
    const key = fromSide === "A" ? "teamA" : "teamB";
    state.draft[key] = state.draft[key].filter((id) => id !== playerId);
    if (!state.draft.excluded.includes(playerId)) state.draft.excluded.push(playerId);
    saveState();
    renderMatchBuilder();
  }

  function addDraftPlayer(playerId, toSide) {
    if (!state.draft) return;
    const player = state.players.find((item) => item.id === playerId);
    if (!player || player.archived) return;
    state.draft.excluded = state.draft.excluded.filter((id) => id !== playerId);
    const key = toSide === "A" ? "teamA" : "teamB";
    if (!state.draft[key].includes(playerId)) state.draft[key].push(playerId);
    saveState();
    renderMatchBuilder();
  }

  function confirmMatch() {
    if (!state.draft) return;
    const scoreA = Number($("#scoreA").value);
    const scoreB = Number($("#scoreB").value);
    if (!state.draft.teamA.length || !state.draft.teamB.length) {
      showToast("Os dois lados precisam ter pelo menos um jogador.", true);
      return;
    }
    if (!Number.isInteger(scoreA) || !Number.isInteger(scoreB) || scoreA < 0 || scoreB < 0) {
      showToast("Informe um placar válido para os dois lados.", true);
      return;
    }
    if (scoreA === scoreB) {
      showToast("O placar não pode terminar empatado.", true);
      return;
    }

    const match = {
      id: uid(),
      number: state.matches.length + 1,
      createdAt: new Date().toISOString(),
      teamA: [...state.draft.teamA],
      teamB: [...state.draft.teamB],
      scoreA,
      scoreB,
      completed: true,
    };
    state.matches.push(match);
    const winners = scoreA > scoreB ? match.teamA : match.teamB;
    [...match.teamA, ...match.teamB].forEach((playerId) => {
      const player = state.players.find((item) => item.id === playerId);
      if (player) {
        const won = winners.includes(playerId);
        const points = player.goalkeeper ? (won ? 12 : 8) : (won ? 18 : 12);
        player.pending.push({ matchId: match.id, delta: won ? points : -points });
      }
    });
    state.draft = null;
    saveState();
    renderAll();
    showToast("Partida concluída. Os ajustes foram marcados no elenco.");
  }

  function renderMatchHistory() {
    const container = $("#matchHistory");
    if (!state.matches.length) {
      container.innerHTML = `<div class="history-empty">Nenhuma partida concluída por enquanto.</div>`;
      return;
    }
    container.innerHTML = [...state.matches].reverse().map((match) => {
      const teamA = playersByIds(match.teamA);
      const teamB = playersByIds(match.teamB);
      return `
        <button class="match-row" data-match-id="${match.id}">
          <span class="match-date"><strong>Partida #${matchNumber(match)}</strong><span>${formatDate(match.createdAt)}</span></span>
          <span class="match-teams"><strong>${escapeHtml(teamA.map((player) => player.name).join(", ") || "Lado A")} × ${escapeHtml(teamB.map((player) => player.name).join(", ") || "Lado B")}</strong><span>${teamA.length + teamB.length} jogadores · partida concluída</span></span>
          <span class="score-badge">${match.scoreA} × ${match.scoreB}</span>
          <span class="open-chevron">›</span>
        </button>`;
    }).join("");
  }

  function openMatch(matchId) {
    const match = state.matches.find((item) => item.id === matchId);
    if (!match) return;
    const winner = match.scoreA > match.scoreB ? "Lado A" : "Lado B";
    $("#matchDetail").innerHTML = `
      <div class="match-detail-title">
        <p class="eyebrow">PARTIDA #${matchNumber(match)}</p>
        <h2>${winner} venceu</h2>
        <p>${formatDate(match.createdAt, true)}</p>
        <div class="big-score"><strong>${match.scoreA}</strong><span>×</span><strong>${match.scoreB}</strong></div>
        <span class="locked-tag">● PARTIDA CONCLUÍDA E BLOQUEADA</span>
      </div>
      <div class="match-detail-teams">
        ${rosterMarkup("A", match.teamA)}
        ${rosterMarkup("B", match.teamB)}
      </div>`;
    $("#matchDialog").showModal();
  }

  function rosterMarkup(side, ids) {
    return `
      <section class="roster-panel ${side.toLowerCase()}">
        <h3>Lado ${side}</h3>
        <div class="roster-list">
          ${sortedTeamPlayers(ids).map((player) => `<div class="roster-player ${player.goalkeeper ? "goalkeeper-player" : ""}"><span class="team-avatar-wrap"><span class="avatar">${photoMarkup(player, true)}</span>${player.goalkeeper ? `<span class="goalkeeper-icon" title="Goleiro" aria-label="Goleiro">🧤</span>` : ""}</span><strong>${escapeHtml(player.name)}</strong><span>${formatOverall(overall(player))} OVR</span></div>`).join("")}
        </div>
      </section>`;
  }

  function setScreen(name) {
    const playersActive = name === "players";
    $("#playersScreen").classList.toggle("active", playersActive);
    $("#matchesScreen").classList.toggle("active", !playersActive);
    $$("[data-screen]").forEach((button) => button.classList.toggle("active", button.dataset.screen === name));
    document.body.dataset.screen = name;
    updateHeaderAction();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function updateHeaderAction() {
    const action = $("#headerAction");
    const matchesActive = document.body.dataset.screen === "matches";
    action.textContent = matchesActive ? (state.draft ? "Ver escalação" : "Gerar partida") : "+ Novo jogador";
  }

  function openPlayerForm(playerId = null) {
    const player = playerId ? state.players.find((item) => item.id === playerId) : null;
    editingPlayerId = player ? player.id : null;
    $("#newPlayerForm").reset();
    pendingPhoto = player?.photo || "";
    $("#playerName").value = player?.name || "";
    $("#isGoalkeeper").checked = Boolean(player?.goalkeeper);
    $("#isGoalkeeper").disabled = Boolean(player);
    $("#playerFormEyebrow").textContent = player ? "EDITAR ATLETA" : "NOVO ATLETA";
    $("#playerFormTitle").textContent = player ? "Editar jogador" : "Criar jogador";
    $("#photoPickerTitle").textContent = player ? "Trocar foto" : "Adicionar foto";
    $("#goalkeeperHint").textContent = player ? "A posição não pode ser alterada depois da criação." : "Goleiros usam quatro atributos específicos.";
    $("#savePlayerBtn").textContent = player ? "Salvar alterações" : "Criar jogador";
    $("#photoPreview").innerHTML = pendingPhoto ? `<img src="${pendingPhoto}" alt="Foto atual">` : "<span>＋</span>";
    $("#newPlayerDialog").showModal();
    setTimeout(() => $("#playerName").focus(), 50);
  }

  function savePlayer(event) {
    event.preventDefault();
    const name = $("#playerName").value.trim();
    if (!name) return;
    const editingPlayer = editingPlayerId ? state.players.find((item) => item.id === editingPlayerId) : null;
    if (editingPlayer) {
      editingPlayer.name = name;
      editingPlayer.photo = pendingPhoto;
      saveState();
      $("#newPlayerDialog").close();
      renderAll();
      detailPlayerId = editingPlayer.id;
      renderPlayerDetail();
      $("#playerDialog").showModal();
      showToast("Nome e foto atualizados com sucesso.");
      return;
    }
    const goalkeeper = $("#isGoalkeeper").checked;
    const attributes = goalkeeper ? GOALKEEPER_ATTRIBUTES : FIELD_ATTRIBUTES;
    state.players.push({
      id: uid(),
      name,
      photo: pendingPhoto,
      goalkeeper,
      archived: false,
      manualAdjustment: false,
      attrs: Object.fromEntries(attributes.map((item) => [item.key, 60])),
      pending: [],
      createdAt: new Date().toISOString(),
    });
    saveState();
    $("#newPlayerDialog").close();
    renderAll();
    showToast(`${name} entrou para o elenco com overall 60.`);
  }

  function compressImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = reject;
      reader.onload = () => {
        const image = new Image();
        image.onerror = reject;
        image.onload = () => {
          const maxSize = 620;
          const ratio = Math.min(1, maxSize / Math.max(image.width, image.height));
          const width = Math.max(1, Math.round(image.width * ratio));
          const height = Math.max(1, Math.round(image.height * ratio));
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext("2d");
          const preserveTransparency = file.type === "image/png";
          if (!preserveTransparency) {
            context.fillStyle = "#ffffff";
            context.fillRect(0, 0, width, height);
          }
          context.drawImage(image, 0, 0, width, height);
          resolve(canvas.toDataURL(preserveTransparency ? "image/png" : "image/jpeg", .78));
        };
        image.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  async function handlePhoto(file) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      showToast("Escolha um arquivo de imagem.", true);
      return;
    }
    try {
      pendingPhoto = await compressImage(file);
      $("#photoPreview").innerHTML = `<img src="${pendingPhoto}" alt="Prévia da foto">`;
    } catch {
      showToast("Não foi possível ler esta foto.", true);
    }
  }

  function bindEvents() {
    document.addEventListener("click", (event) => {
      const screenButton = event.target.closest("[data-screen]");
      if (screenButton) setScreen(screenButton.dataset.screen);

      const goPlayers = event.target.closest("[data-go='players']");
      if (goPlayers) { event.preventDefault(); setScreen("players"); }

      if (event.target.closest("#newPlayerBtn, [data-create-player]")) openPlayerForm();
      if (event.target.closest("#archivedPlayersBtn, [data-open-archived]")) openArchivedPlayers();
      const playerButton = event.target.closest("[data-player-id]");
      if (playerButton) openPlayer(playerButton.dataset.playerId);

      const archivedPlayerButton = event.target.closest("[data-archived-player-id]");
      if (archivedPlayerButton) {
        $("#archivedPlayersDialog").close();
        openPlayer(archivedPlayerButton.dataset.archivedPlayerId);
      }

      const exportCardButton = event.target.closest("[data-export-card]");
      if (exportCardButton) exportPlayerCard(exportCardButton.dataset.exportCard);

      const editButton = event.target.closest("[data-edit-player]");
      if (editButton) {
        $("#playerDialog").close();
        openPlayerForm(editButton.dataset.editPlayer);
      }

      const archiveButton = event.target.closest("[data-archive-player]");
      if (archiveButton) archivePlayer(archiveButton.dataset.archivePlayer);

      const unarchiveButton = event.target.closest("[data-unarchive-player]");
      if (unarchiveButton) unarchivePlayer(unarchiveButton.dataset.unarchivePlayer);

      const closeButton = event.target.closest("[data-close-dialog]");
      if (closeButton) $("#" + closeButton.dataset.closeDialog).close();

      const adjustButton = event.target.closest("[data-adjust-key]");
      if (adjustButton) changeAdjustment(adjustButton.dataset.adjustKey, Number(adjustButton.dataset.adjustStep));
      if (event.target.closest("[data-apply-adjustment]")) applyAdjustment();

      if (event.target.closest("[data-generate-match]")) generateDraft();
      if (event.target.closest("[data-regenerate-match]")) regenerateDraft();
      if (event.target.closest("[data-cancel-draft]")) {
        state.draft = null; saveState(); renderMatches(); showToast("Preparação da partida cancelada.");
      }
      const moveButton = event.target.closest("[data-move-player]");
      if (moveButton) moveDraftPlayer(moveButton.dataset.movePlayer, moveButton.dataset.from);
      const removeButton = event.target.closest("[data-remove-player]");
      if (removeButton) removeDraftPlayer(removeButton.dataset.removePlayer, removeButton.dataset.from);
      const addButton = event.target.closest("[data-add-player]");
      if (addButton) addDraftPlayer(addButton.dataset.addPlayer, addButton.dataset.to);
      if (event.target.closest("[data-confirm-match]")) confirmMatch();

      const matchButton = event.target.closest("[data-match-id]");
      if (matchButton) openMatch(matchButton.dataset.matchId);
    });

    $("#headerAction").addEventListener("click", () => {
      if (document.body.dataset.screen === "matches") {
        if (state.draft) $("#matchBuilder").scrollIntoView({ behavior: "smooth", block: "start" });
        else generateDraft();
      } else openPlayerForm();
    });

    $("#newPlayerForm").addEventListener("submit", savePlayer);
    $("#playerPhoto").addEventListener("change", (event) => handlePhoto(event.target.files[0]));
    $("#exportDataBtn").addEventListener("click", exportBackup);
    $("#importDataInput").addEventListener("change", (event) => importBackup(event.target.files[0]));
    $("#matchBuilder").addEventListener("input", (event) => {
      if (!state.draft) return;
      if (event.target.id === "scoreA") state.draft.scoreA = event.target.value;
      if (event.target.id === "scoreB") state.draft.scoreB = event.target.value;
      saveState();
    });

    $$("dialog").forEach((dialog) => {
      dialog.addEventListener("click", (event) => {
        if (event.target === dialog) dialog.close();
      });
    });
  }

  async function initialize() {
    document.body.dataset.screen = "players";
    bindEvents();
    renderAll();
    await loadServerData();
  }

  initialize();
})();
