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
  interactiveStatus: document.getElementById("audienceInteractiveStatus"),
  raiseHandButton: document.getElementById("audienceRaiseHandButton"),
  leaveGuestButton: document.getElementById("audienceLeaveGuestButton"),
  guestPreview: document.getElementById("audienceGuestPreview"),
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
  participantId: "",
  interactiveTimer: 0,
  interactiveSignalId: 0,
  interactiveParticipant: null,
  interactivePeer: null,
  interactiveStream: null,
  interactiveStarting: false,
  interactiveIceServers: [],
};

function getSessionFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return String(params.get("session") || "").trim();
}

function getOrCreateParticipantId() {
  const storageKey = "gathercastAudienceParticipantId";
  const existing =
    window.localStorage?.getItem(storageKey) || "";

  if (/^[a-z0-9_-]{8,80}$/i.test(existing)) {
    return existing;
  }

  const generated =
    window.crypto?.randomUUID?.().replace(/-/g, "") ||
    `aud${Date.now().toString(36)}${Math.random()
      .toString(36)
      .slice(2, 12)}`;
  const participantId = generated
    .replace(/[^a-z0-9_-]/gi, "")
    .slice(0, 80);

  window.localStorage?.setItem(
    storageKey,
    participantId
  );

  return participantId;
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

function setInteractiveStatus(text) {
  if (ui.interactiveStatus) {
    ui.interactiveStatus.textContent = text;
  }
}

function updateJoinPanel() {
  ui.joinPanel.hidden = Boolean(state.sessionId);
}

function applySession(sessionId) {
  stopInteractiveGuest({
    notify: false,
  });
  state.sessionId = String(sessionId || "").trim();
  state.streamUrl = "";
  state.streamConnected = false;
  state.lastStartedAt = 0;
  ui.video.removeAttribute("src");
  ui.video.load();
  state.messages = [];
  state.latestMessageId = 0;
  state.interactiveParticipant = null;
  state.interactiveSignalId = 0;
  state.interactiveIceServers = [];
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

function getAudienceDisplayName() {
  const name = ui.nameInput?.value?.trim() || "";

  if (name) {
    return name;
  }

  return "Audience";
}

async function postInteractive(pathname, body = {}) {
  const response = await fetch(
    buildAudienceUrl(pathname),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        participantId: state.participantId,
        ...body,
      }),
    }
  );

  const payload = await response
    .json()
    .catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      payload?.error || "Interaction request failed"
    );
  }

  return payload;
}

async function sendInteractiveSignal(type, payload = {}) {
  if (!state.sessionId || !state.participantId) {
    return;
  }

  await postInteractive(
    "/api/audience/interactive/signal",
    {
      type,
      payload,
    }
  );
}

function stopInteractiveGuest({ notify = true } = {}) {
  const participantId = state.participantId;
  const sessionId = state.sessionId;

  if (notify && participantId && sessionId) {
    const body = JSON.stringify({
      participantId,
    });
    const url = buildAudienceUrl(
      "/api/audience/interactive/leave"
    );

    if (navigator.sendBeacon) {
      navigator.sendBeacon(
        url.toString(),
        new Blob([body], {
          type: "application/json",
        })
      );
    } else {
      fetch(url.toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body,
        keepalive: true,
      }).catch(() => {});
    }
  }

  if (state.interactivePeer) {
    try {
      state.interactivePeer.close();
    } catch {
      // Already closed.
    }
  }

  if (state.interactiveStream) {
    for (const track of state.interactiveStream.getTracks()) {
      track.stop();
    }
  }

  state.interactivePeer = null;
  state.interactiveStream = null;
  state.interactiveStarting = false;

  if (ui.guestPreview) {
    ui.guestPreview.srcObject = null;
    ui.guestPreview.hidden = true;
  }
}

async function startInteractiveGuest() {
  if (
    state.interactivePeer ||
    state.interactiveStarting ||
    !state.sessionId
  ) {
    return;
  }

  state.interactiveStarting = true;
  setInteractiveStatus("Opening camera...");

  try {
    const stream =
      await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: true,
      });

    const peer = new RTCPeerConnection({
      iceServers: state.interactiveIceServers || [],
    });

    state.interactiveStream = stream;
    state.interactivePeer = peer;

    if (ui.guestPreview) {
      ui.guestPreview.srcObject = stream;
      ui.guestPreview.hidden = false;
      ui.guestPreview.play().catch(() => {});
    }

    for (const track of stream.getTracks()) {
      peer.addTrack(track, stream);
    }

    peer.addEventListener("icecandidate", (event) => {
      if (event.candidate) {
        sendInteractiveSignal("candidate", {
          candidate: event.candidate.toJSON(),
        }).catch(() => {});
      }
    });

    peer.addEventListener(
      "connectionstatechange",
      () => {
        if (
          [
            "failed",
            "disconnected",
            "closed",
          ].includes(peer.connectionState)
        ) {
          setInteractiveStatus("Disconnected");
        } else if (peer.connectionState === "connected") {
          setInteractiveStatus("Connected");
        }
      }
    );

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    await sendInteractiveSignal("offer", {
      description: peer.localDescription,
    });

    setInteractiveStatus("Connecting");
  } catch (error) {
    stopInteractiveGuest({
      notify: false,
    });
    setInteractiveStatus(
      error?.name === "NotAllowedError"
        ? "Camera blocked"
        : "Could not join"
    );
  } finally {
    state.interactiveStarting = false;
  }
}

async function handleInteractiveSignals(signals = []) {
  if (!Array.isArray(signals) || !signals.length) {
    return;
  }

  for (const signal of signals) {
    state.interactiveSignalId = Math.max(
      state.interactiveSignalId,
      Number(signal.id) || 0
    );

    if (!state.interactivePeer) {
      continue;
    }

    if (signal.type === "answer") {
      const description =
        signal.payload?.description || signal.payload;

      if (description?.type && description?.sdp) {
        await state.interactivePeer.setRemoteDescription(
          new RTCSessionDescription(description)
        );
      }
    } else if (signal.type === "candidate") {
      const candidate =
        signal.payload?.candidate || signal.payload;

      if (candidate) {
        await state.interactivePeer.addIceCandidate(
          new RTCIceCandidate(candidate)
        );
      }
    } else if (signal.type === "leave") {
      stopInteractiveGuest({
        notify: false,
      });
      setInteractiveStatus("Removed");
    }
  }
}

async function refreshInteractive() {
  if (!state.sessionId || !state.participantId) {
    setInteractiveStatus("Waiting");
    if (ui.raiseHandButton) {
      ui.raiseHandButton.disabled = true;
    }
    if (ui.leaveGuestButton) {
      ui.leaveGuestButton.disabled = true;
    }
    return;
  }

  try {
    const url = buildAudienceUrl("/api/audience/interactive");
    url.searchParams.set(
      "participant",
      state.participantId
    );
    url.searchParams.set(
      "after",
      String(state.interactiveSignalId || 0)
    );

    const response = await fetch(url.toString(), {
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error("Interaction unavailable");
    }

    const payload = await response.json();
    state.interactiveIceServers =
      Array.isArray(payload.iceServers)
        ? payload.iceServers
        : [];
    state.interactiveParticipant =
      payload.participant || null;
    const participant =
      state.interactiveParticipant;
    const status = participant?.status || "";

    if (ui.raiseHandButton) {
      ui.raiseHandButton.disabled =
        !payload.active ||
        [
          "pending",
          "approved",
        ].includes(status);
    }

    if (ui.leaveGuestButton) {
      ui.leaveGuestButton.disabled =
        ![
          "pending",
          "approved",
        ].includes(status);
    }

    if (!payload.active) {
      stopInteractiveGuest({
        notify: false,
      });
      setInteractiveStatus("Waiting");
    } else if (status === "pending") {
      setInteractiveStatus("Hand raised");
    } else if (status === "approved") {
      setInteractiveStatus(
        state.interactivePeer
          ? "Connecting"
          : "Approved"
      );
      await startInteractiveGuest();
      await handleInteractiveSignals(payload.signals);
    } else if (status === "rejected") {
      stopInteractiveGuest({
        notify: false,
      });
      setInteractiveStatus("Not chosen");
    } else if (
      status === "removed" ||
      status === "left"
    ) {
      stopInteractiveGuest({
        notify: false,
      });
      setInteractiveStatus("Left");
    } else {
      setInteractiveStatus("Ready");
    }
  } catch {
    setInteractiveStatus("Offline");
    if (ui.raiseHandButton) {
      ui.raiseHandButton.disabled = true;
    }
  }
}

function startInteractivePolling() {
  window.clearInterval(state.interactiveTimer);
  refreshInteractive();
  state.interactiveTimer = window.setInterval(
    refreshInteractive,
    1600
  );
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
  startInteractivePolling();
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

ui.raiseHandButton?.addEventListener("click", async () => {
  if (!state.sessionId) {
    setInteractiveStatus("Need link");
    return;
  }

  try {
    const name = getAudienceDisplayName();

    if (name) {
      window.localStorage?.setItem(
        "gathercastAudienceName",
        name
      );
    }

    if (ui.raiseHandButton) {
      ui.raiseHandButton.disabled = true;
    }

    setInteractiveStatus("Raising hand...");
    await postInteractive(
      "/api/audience/interactive/raise-hand",
      {
        name,
      }
    );
    setInteractiveStatus("Hand raised");
    window.setTimeout(refreshInteractive, 300);
  } catch (error) {
    setInteractiveStatus(
      error?.message || "Could not raise hand"
    );
    if (ui.raiseHandButton) {
      ui.raiseHandButton.disabled = false;
    }
  }
});

ui.leaveGuestButton?.addEventListener("click", async () => {
  try {
    await postInteractive(
      "/api/audience/interactive/leave"
    );
  } catch {
    // The local camera still needs to close even if the network is gone.
  }

  stopInteractiveGuest({
    notify: false,
  });
  state.interactiveParticipant = {
    status: "left",
  };
  setInteractiveStatus("Left");
  window.setTimeout(refreshInteractive, 300);
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
state.participantId = getOrCreateParticipantId();

window.addEventListener("beforeunload", () => {
  stopInteractiveGuest({
    notify: true,
  });
});

applySession(getSessionFromUrl());
startStatusPolling();
startMessagesPolling();
startInteractivePolling();
