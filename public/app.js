const $ = (selector) => document.querySelector(selector);
const loginView = $("#login-view");
const driveView = $("#drive-view");
const loginForm = $("#login-form");
const loginError = $("#login-error");
const list = $("#file-list");
const transferPanel = $("#transfer-panel");
let activeController = null;
let searchTimer = 0;

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: "same-origin", ...options });
  const data = response.headers.get("content-type")?.includes("application/json")
    ? await response.json().catch(() => ({}))
    : {};
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

function showNotice(message, isError = false) {
  const notice = $("#notice");
  notice.textContent = message;
  notice.className = isError ? "notice error" : "notice";
  notice.hidden = false;
}

function hideNotice() { $("#notice").hidden = true; }

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function fileGlyph(name) {
  const ext = name.includes(".") ? name.split(".").pop().slice(0, 4).toUpperCase() : "FILE";
  return ext || "FILE";
}

async function checkSession() {
  try {
    await api("/api/auth/me");
    loginView.hidden = true;
    driveView.hidden = false;
    $("#signed-in-tools").hidden = false;
    await loadFiles();
  } catch {
    loginView.hidden = false;
    driveView.hidden = true;
    $("#signed-in-tools").hidden = true;
  }
}

async function loadFiles(query = "") {
  try {
    const data = await api(`/api/files${query ? `?q=${encodeURIComponent(query)}` : ""}`);
    list.replaceChildren();
    for (const file of data.files || []) {
      const row = document.createElement("tr");
      const name = document.createElement("td");
      const cell = document.createElement("div");
      cell.className = "file-cell";
      const icon = document.createElement("span");
      icon.className = "file-icon";
      icon.textContent = fileGlyph(file.name);
      const fileName = document.createElement("span");
      fileName.className = "file-name";
      fileName.title = file.name;
      fileName.textContent = file.name;
      cell.append(icon, fileName);
      name.append(cell);
      const size = document.createElement("td");
      size.className = "muted";
      size.textContent = formatBytes(file.size);
      const date = document.createElement("td");
      date.className = "muted";
      date.textContent = new Date(file.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
      const actions = document.createElement("td");
      const buttons = document.createElement("div");
      buttons.className = "row-actions";
      const download = document.createElement("a");
      download.className = "action-button";
      download.href = `/api/files/${encodeURIComponent(file.id)}/download`;
      download.textContent = "Download";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "action-button delete";
      remove.textContent = "Delete";
      remove.addEventListener("click", () => deleteFile(file));
      buttons.append(download, remove);
      actions.append(buttons);
      row.append(name, size, date, actions);
      list.append(row);
    }
    const summary = data.summary || { count: (data.files || []).length, bytes: (data.files || []).reduce((sum, file) => sum + Number(file.size || 0), 0) };
    $("#file-count").textContent = `${(data.files || []).length} SHOWN`;
    $("#stat-files").textContent = Number(summary.count).toLocaleString();
    $("#stat-storage").textContent = formatBytes(Number(summary.bytes));
    $("#empty-state").hidden = Boolean((data.files || []).length) || Boolean(query);
    $(".table-wrap").hidden = !(data.files || []).length;
  } catch (error) {
    if (error.message.includes("Sign in")) return checkSession();
    showNotice(error.message, true);
  }
}

async function deleteFile(file) {
  if (!confirm(`Delete “${file.name}” from Telegram storage?`)) return;
  try {
    await api(`/api/files/${encodeURIComponent(file.id)}`, { method: "DELETE" });
    showNotice("File deleted.");
    await loadFiles($("#search-input").value.trim());
  } catch (error) { showNotice(error.message, true); }
}

function setProgress(name, percent, status) {
  $("#transfer-name").textContent = name;
  $("#transfer-percent").textContent = `${Math.floor(percent)}%`;
  $("#progress-fill").style.width = `${Math.min(percent, 100)}%`;
  $("#transfer-status").textContent = status;
}

async function uploadFile(file) {
  if (file.size < 1 || file.size > 2_000_000_000) {
    showNotice("File must be between 1 byte and 2,000,000,000 bytes.", true);
    return;
  }
  hideNotice();
  transferPanel.hidden = false;
  $("#cancel-upload").hidden = false;
  activeController = new AbortController();
  let uploadId = null;
  let finalizing = false;
  try {
    setProgress(file.name, 0, "Starting secure upload…");
    const init = await api("/api/uploads/init", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: file.name, size: file.size, mimeType: file.type || "application/octet-stream" }),
      signal: activeController.signal,
    });
    uploadId = init.uploadId;
    const partSize = init.partSize;
    const partCount = Math.ceil(file.size / partSize);
    let completed = 0;
    for (let partNumber = 1; partNumber <= partCount; partNumber++) {
      if (activeController.signal.aborted) throw new DOMException("Upload cancelled", "AbortError");
      const start = (partNumber - 1) * partSize;
      const chunk = file.slice(start, Math.min(start + partSize, file.size));
      await api(`/api/uploads/${init.uploadId}/parts/${partNumber}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: chunk,
        signal: activeController.signal,
      });
      completed += chunk.size;
      setProgress(file.name, completed / file.size * 92, `Uploading part ${partNumber} of ${partCount} · ${formatBytes(completed)} of ${formatBytes(file.size)}`);
    }
    setProgress(file.name, 94, "Sending completed file to Telegram…");
    finalizing = true;
    $("#cancel-upload").hidden = true;
    await api(`/api/uploads/${init.uploadId}/finish`, { method: "POST", signal: activeController.signal });
    setProgress(file.name, 100, "Upload complete");
    showNotice(`${file.name} uploaded successfully.`);
    await loadFiles($("#search-input").value.trim());
  } catch (error) {
    if (error.name === "AbortError") {
      if (uploadId && !finalizing) await api(`/api/uploads/${uploadId}/cancel`, { method: "POST" }).catch(() => {});
      showNotice(finalizing ? "The connection ended while Telegram was finalizing. Check the file list before retrying." : "Upload cancelled; temporary upload parts were cleared.");
    }
    else showNotice(error.message, true);
  } finally {
    activeController = null;
    $("#cancel-upload").hidden = true;
    setTimeout(() => { transferPanel.hidden = true; }, 1800);
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.hidden = true;
  const submit = $("#login-submit");
  submit.disabled = true;
  submit.querySelector("span:first-child").textContent = "Verifying access…";
  try {
    await api("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: $("#password").value }),
    });
    $("#password").value = "";
    await checkSession();
  } catch (error) {
    loginError.textContent = error.message;
    loginError.hidden = false;
  } finally {
    submit.disabled = false;
    submit.querySelector("span:first-child").textContent = "Enter your space";
  }
});

$("#toggle-password").addEventListener("click", (event) => {
  const button = event.currentTarget;
  const input = $("#password");
  const reveal = input.type === "password";
  input.type = reveal ? "text" : "password";
  button.textContent = reveal ? "HIDE" : "SHOW";
  button.setAttribute("aria-label", reveal ? "Hide password" : "Show password");
});

$("#logout-button").addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" }).catch(() => {});
  await checkSession();
});

$("#file-input").addEventListener("change", async (event) => {
  const files = Array.from(event.target.files || []);
  event.target.value = "";
  for (const file of files) await uploadFile(file);
});

$("#cancel-upload").addEventListener("click", () => activeController?.abort());
$("#search-input").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadFiles($("#search-input").value.trim()), 220);
});

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" && !driveView.hidden) {
    event.preventDefault();
    $("#search-input").focus();
  }
});

checkSession();
