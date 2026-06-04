const statusText = {
    not_started: "未开始",
    running: "运行中",
    retry_wait: "等待重试",
    completed: "已完成",
    all_done: "全部完成",
    stopped: "已停止",
    failed: "执行失败",
};

const state = {
    data: null,
    selectedProfileId: "",
    selectedTaskId: "",
    activeView: "dashboard",
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("\"", "&quot;")
        .replaceAll("'", "&#039;");
}

function formatTime(value) {
    if (!value) return "-";
    try {
        return new Intl.DateTimeFormat("zh-CN", {
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
        }).format(new Date(value));
    } catch {
        return value;
    }
}

function toast(message) {
    const node = $("#toast");
    node.textContent = message;
    node.hidden = false;
    clearTimeout(node.timer);
    node.timer = setTimeout(() => {
        node.hidden = true;
    }, 3200);
}

async function api(path, options = {}) {
    const response = await fetch(path, {
        headers: { "content-type": "application/json" },
        ...options,
        body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "请求失败");
    return payload;
}

function profileOptions(selected = "") {
    const profiles = state.data?.profiles || [];
    return profiles
        .filter((profile) => profile.enabled !== false)
        .map((profile) => `<option value="${escapeHtml(profile.id)}" ${profile.id === selected ? "selected" : ""}>${escapeHtml(profile.name)} · ${escapeHtml(profile.agentType)}</option>`)
        .join("");
}

function directoryOptions(selected = "") {
    return (state.data?.directories || [])
        .map((directory) => `<option value="${escapeHtml(directory)}" ${directory === selected ? "selected" : ""}>${escapeHtml(directory)}</option>`)
        .join("");
}

function taskOptions(selected = "") {
    return (state.data?.tasks || [])
        .map((task) => `<option value="${escapeHtml(task.id)}" ${task.id === selected ? "selected" : ""}>${escapeHtml(task.title)}</option>`)
        .join("");
}

function getSelectedTask() {
    return (state.data?.tasks || []).find((task) => task.id === state.selectedTaskId) || state.data?.tasks?.[0] || null;
}

function renderMetrics() {
    const tasks = state.data?.tasks || [];
    const profiles = state.data?.profiles || [];
    const running = tasks.filter((task) => task.status === "running" || task.isRunning).length;
    const done = tasks.filter((task) => task.status === "all_done").length;
    const retry = tasks.filter((task) => task.status === "retry_wait").length;
    $("#metrics").innerHTML = [
        ["Profiles", profiles.length, "可用运行配置"],
        ["运行中", running, "当前活跃任务"],
        ["等待重试", retry, "429 或其他输出"],
        ["全部完成", done, "已停止循环"],
    ].map(([label, value, caption]) => `
        <div class="metric">
            <span>${label}</span>
            <b>${value}</b>
            <span>${caption}</span>
        </div>
    `).join("");
}

function renderTasks() {
    const tasks = state.data?.tasks || [];
    const empty = `<div class="empty">暂无任务。</div>`;
    const cards = tasks.map((task) => `
        <article class="task-card">
            <div>
                <p class="task-title">${escapeHtml(task.title)}</p>
                <div class="meta">
                    <span>${escapeHtml(task.targetFileName)}</span>
                    <span>${escapeHtml(task.directory)}</span>
                    <span>重试 ${task.retryCount || 0}</span>
                </div>
            </div>
            <span class="badge ${escapeHtml(task.status)}">${statusText[task.status] || task.status}</span>
        </article>
    `).join("");
    $("#taskBoard").innerHTML = cards || empty;
    $("#taskList").innerHTML = tasks.map((task) => `
        <article class="task-card">
            <div>
                <p class="task-title">${escapeHtml(task.title)}</p>
                <div class="meta">
                    <span>${escapeHtml(task.targetFileName)}</span>
                    <span>Profile ${escapeHtml(findProfileName(task.runProfileId || task.decomposeProfileId))}</span>
                    <span>${formatTime(task.updatedAt)}</span>
                </div>
            </div>
            <button class="ghost" type="button" data-open-task="${escapeHtml(task.id)}">打开</button>
        </article>
    `).join("") || empty;
    $("#taskCount").textContent = `${tasks.length} 个任务`;
}

function renderEvents() {
    const events = state.data?.events || [];
    $("#eventFeed").innerHTML = events.map((event) => `
        <article class="event-item">
            <time>${formatTime(event.createdAt)} · ${escapeHtml(event.type)}</time>
            <div>${escapeHtml(event.message)}</div>
        </article>
    `).join("") || `<div class="empty">暂无事件。</div>`;
}

function findProfileName(id) {
    return (state.data?.profiles || []).find((profile) => profile.id === id)?.name || "-";
}

function renderProfiles() {
    const profiles = state.data?.profiles || [];
    $("#profileList").innerHTML = profiles.map((profile) => `
        <article class="profile-card">
            <p class="profile-title">${escapeHtml(profile.name)}</p>
            <div class="meta">
                <span>${escapeHtml(profile.agentType)}</span>
                <span>${escapeHtml(profile.command)}</span>
                <span>${profile.enabled === false ? "禁用" : "启用"}</span>
            </div>
            <div class="meta">
                <span>${escapeHtml(profile.args || "-")}</span>
                <span>ENV ${profile.envKeys?.length || 0}</span>
            </div>
            <button class="ghost" type="button" data-edit-profile="${escapeHtml(profile.id)}">编辑</button>
        </article>
    `).join("") || `<div class="empty">暂无 Profile。</div>`;
}

function renderSelectors() {
    const firstProfile = state.data?.profiles?.find((profile) => profile.enabled !== false);
    const firstTask = state.data?.tasks?.[0];
    if (!state.selectedProfileId && firstProfile) state.selectedProfileId = firstProfile.id;
    if (!state.selectedTaskId && firstTask) state.selectedTaskId = firstTask.id;

    $$("select[name='directory']").forEach((select) => {
        const selected = select.value || state.data?.directories?.[0] || "";
        select.innerHTML = directoryOptions(selected);
    });
    $$("select[name='decomposeProfileId']").forEach((select) => {
        select.innerHTML = profileOptions(select.value || state.selectedProfileId);
    });
    $("#editorTask").innerHTML = taskOptions($("#editorTask").value || state.selectedTaskId);
    $("#runTask").innerHTML = taskOptions($("#runTask").value || state.selectedTaskId);
    $("#runProfile").innerHTML = profileOptions($("#runProfile").value || state.selectedProfileId);
}

function renderDirectories() {
    const directories = state.data?.directories || [];
    $("#directoryList").innerHTML = directories.map((directory, index) => `
        <div class="directory-item">
            <span>${escapeHtml(directory)}</span>
            <button class="ghost" type="button" data-delete-dir="${encodeURIComponent(directory)}" ${index === 0 ? "disabled" : ""}>移除</button>
        </div>
    `).join("");
}

function renderRunDetail() {
    const task = getSelectedTask();
    if (!task) {
        $("#runDetail").innerHTML = `<div class="empty">未选择任务。</div>`;
        return;
    }
    $("#runDetail").innerHTML = [
        ["状态", statusText[task.status] || task.status],
        ["工作目录", task.directory],
        ["任务文件", task.filePath],
        ["最近启动", formatTime(task.lastRunAt)],
        ["下次运行", formatTime(task.nextRunAt)],
        ["退出码", task.lastExitCode ?? "-"],
        ["最近命令", task.lastCommand || "-"],
        ["最近输出", task.lastOutput || "-"],
    ].map(([label, value]) => `
        <div class="detail-row">
            <span>${label}</span>
            <span>${escapeHtml(value)}</span>
        </div>
    `).join("");
}

function renderAll() {
    renderMetrics();
    renderTasks();
    renderEvents();
    renderProfiles();
    renderSelectors();
    renderDirectories();
    renderRunDetail();
}

async function refresh() {
    state.data = await api("/api/state");
    renderAll();
}

function resetProfileForm(profile = null) {
    const form = $("#profileForm");
    form.reset();
    form.elements.id.value = profile?.id || "";
    form.elements.name.value = profile?.name || "";
    form.elements.agentType.value = profile?.agentType || "claude";
    form.elements.command.value = profile?.command || "claude";
    form.elements.args.value = profile?.args || "-p {prompt}";
    form.elements.envText.value = profile?.envText || "";
    form.elements.promptTemplate.value = profile?.promptTemplate || "";
    form.elements.timeoutSeconds.value = profile?.timeoutSeconds || 1800;
    form.elements.enabled.checked = profile?.enabled !== false;
    form.elements.nonInteractive.checked = profile?.nonInteractive !== false;
    state.selectedProfileId = profile?.id || "";
}

async function loadFile(taskId) {
    const task = (state.data?.tasks || []).find((item) => item.id === taskId);
    if (!task) return;
    const result = await api(`/api/tasks/${encodeURIComponent(taskId)}/file`);
    $("#fileEditor").value = result.content;
    $("#editorPath").textContent = result.filePath;
    state.selectedTaskId = taskId;
    $("#editorTask").value = taskId;
    $("#runTask").value = taskId;
}

async function loadLog(taskId) {
    if (!taskId) {
        $("#logView").textContent = "";
        return;
    }
    const result = await api(`/api/tasks/${encodeURIComponent(taskId)}/log`);
    $("#logView").textContent = result.content || "暂无日志。";
}

function switchView(view) {
    state.activeView = view;
    $$(".nav").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
    $$(".view").forEach((node) => node.classList.toggle("active", node.id === view));
}

function bindEvents() {
    $$(".nav").forEach((button) => {
        button.addEventListener("click", () => switchView(button.dataset.view));
    });
    $("[data-refresh]").addEventListener("click", () => refresh().then(() => toast("已刷新")));

    $("#newProfile").addEventListener("click", () => resetProfileForm());
    $("#toggleEnv").addEventListener("click", () => {
        $("#profileForm textarea[name='envText']").classList.toggle("revealed");
    });
    $("#profileList").addEventListener("click", (event) => {
        const id = event.target.dataset.editProfile;
        if (!id) return;
        const profile = state.data.profiles.find((item) => item.id === id);
        resetProfileForm(profile);
    });
    $("#profileForm").addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const body = Object.fromEntries(new FormData(form).entries());
        body.enabled = form.elements.enabled.checked;
        body.nonInteractive = form.elements.nonInteractive.checked;
        body.timeoutSeconds = Number(body.timeoutSeconds || 1800);
        await api("/api/profiles", { method: "POST", body });
        await refresh();
        toast("Profile 已保存");
    });
    $("#duplicateProfile").addEventListener("click", () => {
        const form = $("#profileForm");
        form.elements.id.value = "";
        form.elements.name.value = `${form.elements.name.value || "profile"}-copy`;
    });
    $("#deleteProfile").addEventListener("click", async () => {
        const id = $("#profileForm").elements.id.value;
        if (!id) return toast("请选择 Profile");
        await api(`/api/profiles/${encodeURIComponent(id)}`, { method: "DELETE" });
        resetProfileForm();
        await refresh();
        toast("Profile 已删除");
    });

    $("#taskForm").addEventListener("submit", async (event) => {
        event.preventDefault();
        const body = Object.fromEntries(new FormData(event.currentTarget).entries());
        const result = await api("/api/tasks", { method: "POST", body });
        state.selectedTaskId = result.task.id;
        await refresh();
        await loadFile(result.task.id);
        switchView("editor");
        toast("任务文件已生成");
    });

    $("#taskList").addEventListener("click", async (event) => {
        const id = event.target.dataset.openTask;
        if (!id) return;
        await loadFile(id);
        switchView("editor");
    });
    $("#editorTask").addEventListener("change", (event) => loadFile(event.target.value));
    $("#loadFile").addEventListener("click", () => loadFile($("#editorTask").value));
    $("#saveFile").addEventListener("click", async () => {
        const id = $("#editorTask").value;
        if (!id) return toast("请选择任务");
        await api(`/api/tasks/${encodeURIComponent(id)}/file`, {
            method: "PUT",
            body: { content: $("#fileEditor").value },
        });
        await refresh();
        toast("任务文件已保存");
    });

    $("#runTask").addEventListener("change", async (event) => {
        state.selectedTaskId = event.target.value;
        await loadLog(state.selectedTaskId);
        renderRunDetail();
    });
    $("#runProfile").addEventListener("change", (event) => {
        state.selectedProfileId = event.target.value;
    });
    $("#startTask").addEventListener("click", async () => {
        const taskId = $("#runTask").value;
        const profileId = $("#runProfile").value;
        if (!taskId || !profileId) return toast("请选择任务和 Profile");
        await api(`/api/tasks/${encodeURIComponent(taskId)}/start`, {
            method: "POST",
            body: { profileId },
        });
        await refresh();
        await loadLog(taskId);
        toast("任务已启动");
    });
    $("#stopTask").addEventListener("click", async () => {
        const taskId = $("#runTask").value;
        if (!taskId) return toast("请选择任务");
        await api(`/api/tasks/${encodeURIComponent(taskId)}/stop`, { method: "POST" });
        await refresh();
        await loadLog(taskId);
        toast("任务已停止");
    });
    $("#decomposeTask").addEventListener("click", async () => {
        const taskId = $("#runTask").value;
        const profileId = $("#runProfile").value;
        if (!taskId || !profileId) return toast("请选择任务和 Profile");
        await api(`/api/tasks/${encodeURIComponent(taskId)}/decompose`, {
            method: "POST",
            body: { profileId },
        });
        await refresh();
        await loadFile(taskId);
        await loadLog(taskId);
        toast("拆解命令已完成");
    });
    $("#copyLog").addEventListener("click", async () => {
        await navigator.clipboard.writeText($("#logView").textContent || "");
        toast("日志已复制");
    });

    $("#directoryForm").addEventListener("submit", async (event) => {
        event.preventDefault();
        const body = Object.fromEntries(new FormData(event.currentTarget).entries());
        await api("/api/directories", { method: "POST", body });
        event.currentTarget.reset();
        await refresh();
        toast("目录已添加");
    });
    $("#directoryList").addEventListener("click", async (event) => {
        const encoded = event.target.dataset.deleteDir;
        if (!encoded) return;
        await api(`/api/directories/${encoded}`, { method: "DELETE" });
        await refresh();
        toast("目录已移除");
    });
}

function tickClock() {
    $("#serverClock").textContent = new Intl.DateTimeFormat("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    }).format(new Date());
}

async function boot() {
    bindEvents();
    tickClock();
    setInterval(tickClock, 1000);
    await refresh();
    const firstProfile = state.data?.profiles?.[0];
    resetProfileForm(firstProfile || null);
    const firstTask = state.data?.tasks?.[0];
    if (firstTask) {
        await loadFile(firstTask.id);
        await loadLog(firstTask.id);
    }
    setInterval(async () => {
        try {
            await refresh();
            const currentTask = $("#runTask").value || state.selectedTaskId;
            if (currentTask && state.activeView === "runtime") await loadLog(currentTask);
        } catch (error) {
            toast(error.message);
        }
    }, 2000);
}

window.addEventListener("error", (event) => toast(event.message));
boot().catch((error) => toast(error.message));
