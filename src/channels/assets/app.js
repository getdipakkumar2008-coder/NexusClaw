// WebChat client. Everything shown is inserted with textContent: model output and other people's text are untrusted.
(function () {
  "use strict";

  var KEY = "clawnexus.webchat.secret";
  var log = document.getElementById("log");
  var form = document.getElementById("form");
  var input = document.getElementById("input");
  var sendButton = document.getElementById("send");
  var statusEl = document.getElementById("status");
  var noticeEl = document.getElementById("notice");
  var typingEl = document.getElementById("typing");

  var memory = {};
  function store(name, value) {
    try {
      if (value === undefined) return window.localStorage.getItem(name);
      window.localStorage.setItem(name, value);
    } catch {
      if (value === undefined) return memory[name] || null;
      memory[name] = value;
    }
    return null;
  }

  // An owner link carries its one-time code in the part of the address that is never sent to a server.
  var redeem = null;
  var m = /(?:^|[#&])owner=([A-Za-z0-9_-]{8,100})/.exec(window.location.hash);
  if (m) {
    redeem = m[1];
    window.history.replaceState(null, "", window.location.pathname);
  }

  var socket = null;
  var open = false;
  var retry = 1000;
  var pending = {};

  function setStatus(text) {
    statusEl.textContent = text;
  }
  function showNotice(text) {
    if (!text) {
      noticeEl.hidden = true;
      noticeEl.textContent = "";
      return;
    }
    noticeEl.textContent = text;
    noticeEl.hidden = false;
  }
  function addMessage(who, text, extraClass) {
    var el = document.createElement("div");
    el.className = "msg " + who + (extraClass ? " " + extraClass : "");
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }
  function enable(on) {
    input.disabled = !on;
    sendButton.disabled = !on;
    if (on) input.focus();
  }
  function newId() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID().replace(/-/g, "");
    var a = new Uint8Array(16);
    window.crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
  }

  function roleText(role) {
    if (role === "owner") return "Connected as the owner";
    if (role === "guest") return "Connected";
    return "Not approved yet";
  }

  function connect() {
    var proto = window.location.protocol === "https:" ? "wss://" : "ws://";
    socket = new WebSocket(proto + window.location.host + "/v1/webchat");
    socket.onopen = function () {
      open = true;
      retry = 1000;
      socket.send(JSON.stringify({ t: "hello", secret: store(KEY), redeem: redeem }));
    };
    socket.onmessage = function (ev) {
      var f;
      try {
        f = JSON.parse(ev.data);
      } catch {
        return;
      }
      handle(f);
    };
    socket.onclose = function () {
      open = false;
      enable(false);
      typingEl.hidden = true;
      setStatus("Disconnected. Reconnecting…");
      window.setTimeout(connect, retry);
      retry = Math.min(retry * 2, 15000);
    };
    socket.onerror = function () {
      /* onclose follows */
    };
  }

  function handle(f) {
    if (f.t === "ready") {
      if (f.secret) store(KEY, f.secret);
      setStatus(roleText(f.role));
      var note = "";
      if (f.role === "unpaired") note = "Send a message to get a pairing code. The owner has to approve it before you can chat.";
      if (redeem && !f.redeemed) note = "That owner link is invalid or has expired. Ask for a new one." + (note ? " " + note : "");
      redeem = null;
      showNotice(note);
      enable(true);
    } else if (f.t === "history") {
      log.textContent = "";
      (f.messages || []).forEach(function (h) {
        addMessage(h.from === "assistant" ? "bot" : "you", h.text);
      });
    } else if (f.t === "message") {
      typingEl.hidden = true;
      addMessage("bot", f.text);
    } else if (f.t === "typing") {
      typingEl.hidden = !f.on;
    } else if (f.t === "ack") {
      var el = pending[f.id];
      if (el) {
        el.classList.remove("pending");
        delete pending[f.id];
      }
      if (f.role) setStatus(roleText(f.role));
      if (f.status === "pairing") showNotice("The owner has to approve the code above before you can chat. Send another message once they have.");
      else if (f.status === "accepted") showNotice("");
      else if (f.status === "limited") showNotice("You are sending messages too quickly. Please wait a moment.");
      else if (f.status === "busy") showNotice("The assistant is still busy with your earlier messages.");
      else if (f.status === "unavailable") showNotice("The assistant is not ready yet.");
      else if (f.status === "ignored") showNotice("That message was not delivered.");
    }
  }

  function submit() {
    var text = input.value.trim();
    if (!text || !open) return;
    var id = newId();
    pending[id] = addMessage("you", text, "pending");
    socket.send(JSON.stringify({ t: "message", id: id, text: text }));
    input.value = "";
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    submit();
  });
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });

  connect();
})();
