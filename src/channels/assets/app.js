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
  var attachEl = document.getElementById("attach");
  var filesEl = document.getElementById("files");

  // Files the visitor picked and has not sent yet. The Gateway decides what it will really accept; these are only sensible limits.
  var MAX_FILES = 4;
  var MAX_FILE = 8 * 1024 * 1024;
  var CHUNK = 192 * 1024;
  var chosen = [];
  var sending = false;
  var uploads = {}; // files going up right now, by upload id: what the Gateway has said about each
  var WHY = {
    not_paired: "Files can be sent once the owner has approved you.",
    too_large: "That file is too large.",
    limited: "You have sent too many files for now.",
    too_many: "Too many files at once.",
    timeout: "The Gateway did not confirm the file in time.",
    closed: "The connection was lost before the file arrived."
  };

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
  // A file from the assistant is offered as a download. It is never opened or shown in the page.
  function addFile(file) {
    var el = document.createElement("div");
    el.className = "msg bot file";
    try {
      var raw = window.atob(String(file.data));
      var bytes = new Uint8Array(raw.length);
      for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      var link = document.createElement("a");
      link.href = window.URL.createObjectURL(new window.Blob([bytes], { type: "application/octet-stream" }));
      link.download = String(file.name || "file").slice(0, 100);
      link.rel = "noopener";
      link.textContent = "Download " + link.download;
      el.appendChild(link);
    } catch {
      el.textContent = "A file arrived but could not be shown.";
    }
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
  }
  function enable(on) {
    input.disabled = !on;
    sendButton.disabled = !on;
    if (attachEl) attachEl.disabled = !on;
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
      Object.keys(uploads).forEach(function (k) { uploads[k].end("closed"); });
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
      if (f.text) addMessage("bot", f.text);
      (f.files || []).forEach(addFile);
    } else if (f.t === "typing") {
      typingEl.hidden = !f.on;
    } else if (f.t === "file") {
      var going = uploads[f.up];
      if (going) going.end(f.status);
      else if (f.status !== "ready") showNotice(WHY[f.status] || "A file could not be sent.");
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

  function showChosen() {
    if (!filesEl) return;
    filesEl.textContent = "";
    chosen.forEach(function (f) {
      var tag = document.createElement("span");
      tag.textContent = f.name;
      filesEl.appendChild(tag);
    });
    filesEl.hidden = chosen.length === 0;
  }

  function toBase64(bytes) {
    var out = "";
    for (var i = 0; i < bytes.length; i += 8192) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return window.btoa(out);
  }
  function drained() {
    return new Promise(function (resolve) {
      (function check() {
        if (!socket || !(socket.bufferedAmount > 1048576)) resolve();
        else window.setTimeout(check, 50);
      })();
    });
  }
  // A file goes up in pieces so that no single frame is large; the Gateway puts them together and checks them. The
  // message that names the file is sent only after the Gateway has said it is complete ("ready"); if it says anything else,
  // or the connection drops, this fails with the reason and nothing is sent.
  function upload(file) {
    var up = newId();
    var state = { status: "" };
    var settled = new Promise(function (resolve, reject) {
      state.end = function (status) {
        if (state.status) return;
        state.status = status;
        if (status === "ready") resolve();
        else reject(new Error(status));
      };
    });
    settled.catch(function () {});
    uploads[up] = state;
    function finish() {
      delete uploads[up];
    }
    return file
      .arrayBuffer()
      .then(function (buf) {
        var bytes = new Uint8Array(buf);
        var seq = 0;
        function next(at) {
          var end = Math.min(at + CHUNK, bytes.length);
          return drained().then(function () {
            if (state.status && state.status !== "ready") throw new Error(state.status); // refused part-way: stop sending pieces
            if (!open) throw new Error("closed");
            socket.send(JSON.stringify({ t: "file", up: up, name: file.name, seq: seq++, last: end >= bytes.length, data: toBase64(bytes.subarray(at, end)) }));
            return end >= bytes.length ? undefined : next(end);
          });
        }
        return next(0);
      })
      .then(function () {
        var timer;
        var late = new Promise(function (resolve, reject) {
          timer = window.setTimeout(function () { reject(new Error("timeout")); }, 30000);
        });
        return Promise.race([settled, late]).then(
          function () { window.clearTimeout(timer); },
          function (e) { window.clearTimeout(timer); throw e; }
        );
      })
      .then(
        function () { finish(); return up; },
        function (e) { finish(); throw e; }
      );
  }

  function submit() {
    var text = input.value.trim();
    if ((!text && chosen.length === 0) || !open || sending) return;
    var id = newId();
    var files = chosen;
    chosen = [];
    showChosen();
    input.value = "";
    var shown = text + (files.length ? (text ? String.fromCharCode(10) : "") + "Attached: " + files.map(function (f) { return f.name; }).join(", ") : "");
    pending[id] = addMessage("you", shown, "pending");
    if (files.length === 0) return void socket.send(JSON.stringify({ t: "message", id: id, text: text }));
    sending = true;
    // If the files cannot be delivered, nothing was sent: take the message back out of the log and give the visitor
    // their text and their files again, with the reason.
    function giveBack(reason) {
      var el = pending[id];
      if (el && el.parentNode) el.parentNode.removeChild(el);
      delete pending[id];
      if (!input.value) input.value = text;
      chosen = files;
      showChosen();
      showNotice((WHY[reason] || "The files could not be sent.") + " Your message was not sent; it is back in the box.");
    }
    files
      .reduce(function (p, f) {
        return p.then(function (ids) {
          return upload(f).then(function (up) {
            ids.push(up);
            return ids;
          });
        });
      }, Promise.resolve([]))
      .then(function (ids) {
        socket.send(JSON.stringify({ t: "message", id: id, text: text, files: ids }));
      })
      .catch(function (e) {
        giveBack(e && e.message);
      })
      .then(function () {
        sending = false;
      });
  }

  if (attachEl) {
    attachEl.addEventListener("change", function () {
      var picked = Array.prototype.slice.call(attachEl.files || []);
      var kept = picked.filter(function (f) { return f.size > 0 && f.size <= MAX_FILE; }).slice(0, MAX_FILES);
      chosen = kept;
      showNotice(kept.length < picked.length ? "Up to " + MAX_FILES + " files of 8 MB each can be sent; some were left out." : "");
      showChosen();
      attachEl.value = "";
    });
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
