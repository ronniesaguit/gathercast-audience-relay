const ui = {
  status: document.getElementById("audienceStatus"),
  joinPanel: document.getElementById("joinPanel"),
  sessionInput: document.getElementById("sessionInput"),
  joinButton: document.getElementById("joinButton"),
  video: document.getElementById("audienceVideo"),
  empty: document.getElementById("audienceEmpty"),
  playButton: document.getElementById("playButton"),
  meta: document.getElementById("audienceMeta"),
  chatStatus: document.getElementById("audienceChatStatus"),
  messageList: document.getElementById("audienceMessageList"),
  messageForm: document.getElementById("audienceMessageForm"),
  nameInput: document.getElementById("audienceNameInput"),
  messageInput: document.getElementById("audienceMessageInput"),
  sendButton: document.getElementById("audienceSendButton"),
};

const state = {
  sessionId: "",
  streamUrl: "",
  streamConnected: false,
  lastStartedAt: 0,
  statusTimer: 0,
  messagesTimer: 0,
  messages: [],
  latestMessageId: 0,
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

function setChatStatus(text) {
  ui.chatStatus.textContent = text;
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
  state.messages = [];
  state.latestMessageId = 0;
  renderMessages();
  updateJoinPanel();

  if (state.sessionId) {
    const url = new URL(window.location.href);
    url.searchParams.set("session", state.sessionId);
    window.history.replaceState({}, "", url);
  }
}

function createMessageElement(message) {
  const item = document.createElement("article");
  item.className = "audience-message";
  item.dataset.role =
    message.role === "teacher" ? "teacher" : "audience";

  const meta = document.createElement("div");
  meta.className = "audience-message-meta";

  const name = document.createElement("strong");
  name.textContent =
    message.role === "teacher"
      ? "Teacher"
      : message.name || "Audience";

  const time = document.createElement("time");
  const createdAt =
    Number(message.createdAt) || Date.now();
  time.dateTime = new Date(createdAt).toISOString();
  time.textContent = new Date(createdAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  const text = document.createElement("p");
  text.textContent = message.text || "";

  meta.append(name, time);
  item.append(meta, text);
  return item;
}

function renderMessages() {
  ui.messageList.textContent = "";

  if (!state.messages.length) {
    const empty = document.createElement("p");
    empty.className = "audience-message-empty";
    empty.textContent =
      state.sessionId
        ? "No messages yet."
        : "Messages will appear here when the broadcast starts.";
    ui.messageList.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();

  for (const message of state.messages) {
    fragment.append(createMessageElement(message));
  }

  ui.messageList.append(fragment);
  ui.messageList.scrollTop = ui.messageList.scrollHeight;
}

function mergeMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) {
    return;
  }

  const knownIds = new Set(
    state.messages.map((message) => message.id)
  );

  for (const message of messages) {
    if (!knownIds.has(message.id)) {
      state.messages.push(message);
      knownIds.add(message.id);
    }

    state.latestMessageId = Math.max(
      state.latestMessageId,
      Number(message.id) || 0
    );
  }

  state.messages = state.messages.slice(-300);
  renderMessages();
}

async function refreshMessages() {
  if (!state.sessionId) {
    setChatStatus("Waiting");
    ui.sendButton.disabled = true;
    return;
  }

  try {
    const url = buildAudienceUrl("/api/audience/messages");
    url.searchParams.set(
      "after",
      String(state.latestMessageId || 0)
    );

    const response = await fetch(url.toString(), {
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error("Messages unavailable");
    }

    const payload = await response.json();
    ui.sendButton.disabled = !payload.active;
    setChatStatus(payload.active ? "Open" : "Waiting");
    mergeMessages(payload.messages);
  } catch {
    setChatStatus("Offline");
    ui.sendButton.disabled = true;
  }
}

function startMessagesPolling() {
  window.clearInterval(state.messagesTimer);
  refreshMessages();
  state.messagesTimer = window.setInterval(
    refreshMessages,
    1800
  );
}

function buildAudienceUrl(pathname) {
  const url = new URL(pathname, window.location.origin);
  url.searchParams.set("session", state.sessionId);
  url.searchParams.set("t", String(Date.now()));
  return url;
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
      setChatStatus("Waiting");
      ui.sendButton.disabled = true;
      return;
    }

    setStatus("Live", true);
    setChatStatus("Open");
    ui.sendButton.disabled = false;
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
    setChatStatus("Offline");
    ui.playButton.disabled = true;
    ui.sendButton.disabled = true;
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
  startMessagesPolling();
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

ui.messageForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!state.sessionId) {
    setChatStatus("Need link");
    return;
  }

  const text = ui.messageInput.value.trim();

  if (!text) {
    ui.messageInput.focus();
    return;
  }

  const name = ui.nameInput.value.trim();

  try {
    ui.sendButton.disabled = true;
    setChatStatus("Sending...");

    if (name) {
      window.localStorage?.setItem(
        "gathercastAudienceName",
        name
      );
    }

    const response = await fetch(
      buildAudienceUrl("/api/audience/message"),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name,
          text,
        }),
      }
    );

    if (!response.ok) {
      throw new Error("Message rejected");
    }

    const payload = await response.json();
    mergeMessages([payload.message]);
    ui.messageInput.value = "";
    setChatStatus("Sent");
  } catch {
    setChatStatus("Could not send");
  } finally {
    window.setTimeout(refreshMessages, 300);
  }
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

ui.nameInput.value =
  window.localStorage?.getItem("gathercastAudienceName") || "";

applySession(getSessionFromUrl());
startStatusPolling();
startMessagesPolling();
