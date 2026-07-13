const ui = {
  status: document.getElementById("audienceStatus"),
  joinPanel: document.getElementById("joinPanel"),
  sessionInput: document.getElementById("sessionInput"),
  joinButton: document.getElementById("joinButton"),
  video: document.getElementById("audienceVideo"),
  empty: document.getElementById("audienceEmpty"),
  playButton: document.getElementById("playButton"),
  meta: document.getElementById("audienceMeta"),
};

const state = {
  sessionId: "",
  streamUrl: "",
  streamConnected: false,
  lastStartedAt: 0,
  statusTimer: 0,
};

function getSessionFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return String(params.get("session") || "").trim();
}

function extractSession(value) {
  const raw = String(value || "").trim();

  if (!raw) {
    return "";
  }

  try {
    const url = new URL(raw);
    return String(url.searchParams.get("session") || "").trim();
  } catch {
    return raw;
  }
}

function setStatus(text, live = false) {
  ui.status.textContent = text;
  ui.status.classList.toggle("is-live", live);
}

function setMessage(text) {
  ui.meta.textContent = text;
}

function updateJoinPanel() {
  ui.joinPanel.hidden = Boolean(state.sessionId);
}

function applySession(sessionId) {
  state.sessionId = String(sessionId || "").trim();
  state.streamUrl = "";
  state.streamConnected = false;
  state.lastStartedAt = 0;
  ui.video.removeAttribute("src");
  ui.video.load();
  updateJoinPanel();

  if (state.sessionId) {
    const url = new URL(window.location.href);
    url.searchParams.set("session", state.sessionId);
    window.history.replaceState({}, "", url);
  }
}

function buildAudienceUrl(pathname) {
  const url = new URL(pathname, window.location.origin);
  url.searchParams.set("session", state.sessionId);
  url.searchParams.set("t", String(Date.now()));
  return url.toString();
}

function connectStream() {
  if (!state.sessionId) {
    return;
  }

  state.streamUrl = buildAudienceUrl("/api/audience/stream");
  ui.video.src = state.streamUrl;
  state.streamConnected = true;
  ui.empty.classList.add("hidden");
  ui.playButton.disabled = false;
}

async function refreshStatus() {
  if (!state.sessionId) {
    setStatus("Waiting");
    setMessage("Paste the watch link from the teacher.");
    return;
  }

  try {
    const response = await fetch(
      buildAudienceUrl("/api/audience/status"),
      {
        cache: "no-store",
      }
    );

    if (!response.ok) {
      throw new Error("Status unavailable");
    }

    const status = await response.json();

    if (!status.active) {
      setStatus("Waiting");
      ui.empty.classList.remove("hidden");
      ui.playButton.disabled = true;
      state.streamConnected = false;
      state.lastStartedAt = 0;
      ui.video.removeAttribute("src");
      ui.video.load();
      setMessage("Waiting for the teacher to start the audience broadcast.");
      return;
    }

    setStatus("Live", true);
    setMessage(
      status.viewerCount === 1
        ? "1 viewer connected."
        : `${status.viewerCount || 0} viewers connected.`
    );

    if (
      !state.streamConnected ||
      state.lastStartedAt !== status.startedAt
    ) {
      state.lastStartedAt = status.startedAt;
      connectStream();
    }
  } catch {
    setStatus("Offline");
    setMessage("GatherCast is not reachable. Ask the teacher for the latest watch link.");
    ui.playButton.disabled = true;
  }
}

function startStatusPolling() {
  window.clearInterval(state.statusTimer);
  refreshStatus();
  state.statusTimer = window.setInterval(
    refreshStatus,
    1800
  );
}

ui.joinButton.addEventListener("click", () => {
  const sessionId = extractSession(ui.sessionInput.value);

  if (!sessionId) {
    setMessage("Enter the session link from the teacher.");
    ui.sessionInput.focus();
    return;
  }

  applySession(sessionId);
  startStatusPolling();
});

ui.sessionInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    ui.joinButton.click();
  }
});

ui.playButton.addEventListener("click", () => {
  if (!state.streamConnected) {
    connectStream();
  }

  ui.video.play().catch(() => {
    setMessage("Press play in the video controls to start audio.");
  });
});

ui.video.addEventListener("playing", () => {
  ui.empty.classList.add("hidden");
});

ui.video.addEventListener("ended", () => {
  state.streamConnected = false;
  ui.empty.classList.remove("hidden");
  refreshStatus();
});

ui.video.addEventListener("error", () => {
  state.streamConnected = false;
  ui.empty.classList.remove("hidden");
  window.setTimeout(refreshStatus, 1200);
});

applySession(getSessionFromUrl());
startStatusPolling();
