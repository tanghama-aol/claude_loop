let browserStorage = null;
try {
    browserStorage = window.localStorage;
} catch {
    browserStorage = null;
}

const i18n = AgentLoopI18n.createI18n({
    storage: browserStorage,
    navigatorLanguage: navigator.language,
    documentRef: document,
});
const t = (key, params = {}) => i18n.t(key, params);
const MEDIA_FORMAT_OPTIONS = {
    image: ["png", "jpg", "webp", "gif", "avif"],
    video: ["mp4", "webm", "mov", "mkv", "m4v"],
};
const TERMINAL_EVENT_TYPES = new Set(["stdout", "stderr", "error"]);
const COMMAND_EVENT_TYPES = new Set(["command", "prompt", "profile_config"]);
const WARNING_EVENT_TYPES = new Set(["retry_wait", "profile_switched", "timeout", "no_output", "availability_wait", "rate_limit_wait"]);
const ERROR_EVENT_TYPES = new Set(["stderr", "error", "process_error", "task_failed", "generation_failed"]);
const RESULT_EVENT_TYPES = new Set(["task_completed", "task_all_done", "generation_completed", "cycle_stats"]);
const STOP_EVENT_TYPES = new Set(["task_stopped", "user_stopped"]);
const LOG_METADATA_KEYS = [
    "pid",
    "exitCode",
    "signal",
    "durationMs",
    "outputChunks",
    "stdoutBytes",
    "stderrBytes",
    "retryCount",
    "delayMs",
    "intervalMinutes",
    "nextCheckAt",
    "stallCount",
    "failureStreak",
    "failureReason",
    "runToken",
    "reason",
    "directory",
    "cwd",
    "cycle",
    "success",
    "inputTokens",
    "outputTokens",
    "cacheCreationTokens",
    "cacheReadTokens",
    "costUsd",
    "totalCostUsd",
    "averageIntervalMs",
];
const MAX_LEGACY_LOG_RENDER_CHARS = 256 * 1024;
const LOG_PAGE_SIZE = 200;
const MAX_LOG_EVENTS = 400;
const MAX_LOG_RENDER_CHARS = 512 * 1024;
const timeFormatters = new Map();

const state = {
    data: null,
    selectedProfileId: "",
    selectedTaskId: "",
    scheduleTaskId: "",
    fileRequestId: 0,
    refreshRequestId: 0,
    creatingTask: false,
    deduplicatingTasks: false,
    // 任务页右侧编辑器：taskId 为空表示「创建任务」模式，否则编辑该任务并自动保存。
    taskEditor: { taskId: "", timer: null, saving: false, dirty: false, lastSavedAt: null, error: "" },
    deletingTaskIds: new Set(),
    responseEtags: new Map(),
    pollTimer: null,
    pollInFlight: false,
    pollFailures: 0,
    dashboardHighlightTimer: null,
    activeView: "dashboard",
    runtimeTabsSignature: "",
    log: {
        taskId: "",
        runId: "",
        events: [],
        content: "",
        contentBytes: 0,
        contentReturnedBytes: 0,
        contentOmittedBytes: 0,
        contentTruncated: false,
        runs: [],
        format: "empty",
        status: "missing",
        warnings: [],
        nextCursor: 0,
        loading: false,
        error: "",
        following: true,
        requestId: 0,
        abortController: null,
        renderVersion: 0,
        totalEvents: 0,
        firstCursor: 0,
        hasMoreBefore: false,
        hasMoreAfter: false,
        historyMode: false,
        sourceSignature: "",
    },
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
        const locale = i18n.getLocale();
        if (!timeFormatters.has(locale)) {
            timeFormatters.set(locale, new Intl.DateTimeFormat(locale, {
                month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
            }));
        }
        return timeFormatters.get(locale).format(new Date(value));
    } catch {
        return value;
    }
}

function translatedOr(key, fallback, params = {}) {
    const translated = t(key, params);
    return translated === key ? fallback : translated;
}

function formatDuration(value) {
    const milliseconds = Number(value);
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return String(value ?? "-");
    if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
    if (milliseconds < 60000) return `${(milliseconds / 1000).toFixed(milliseconds < 10000 ? 1 : 0)} s`;
    const minutes = Math.floor(milliseconds / 60000);
    const seconds = Math.round((milliseconds % 60000) / 1000);
    return `${minutes}m ${seconds}s`;
}

function formatLogBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return String(value ?? "-");
    return formatBytes(bytes);
}

function eventTypeLabel(type) {
    const normalized = String(type || "system").trim().toLowerCase() || "system";
    const fallback = normalized
        .split("_")
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
    return translatedOr(`logEvent.${normalized}`, fallback || "System");
}

function phaseLabel(phase) {
    const normalized = String(phase || "run").trim().toLowerCase() || "run";
    return translatedOr(`logPhase.${normalized}`, normalized);
}

function streamLabel(stream) {
    const normalized = String(stream || "").trim().toLowerCase();
    return normalized ? translatedOr(`logStream.${normalized}`, normalized) : "";
}

function logEventKind(event) {
    const type = String(event?.type || "system").toLowerCase();
    const stream = String(event?.stream || "").toLowerCase();
    if (ERROR_EVENT_TYPES.has(type) || stream === "stderr" || stream === "error") return "error";
    if (RESULT_EVENT_TYPES.has(type)) return "result";
    if (STOP_EVENT_TYPES.has(type)) return "stopped";
    if (WARNING_EVENT_TYPES.has(type)) return "warning";
    if (COMMAND_EVENT_TYPES.has(type)) return "input";
    if (type === "stdout" || stream === "stdout") return "agent";
    if (["task_created", "task_updated", "task_file_saved", "task_items_appended", "task_queued", "task_archived"].includes(type)) return "setup";
    if (["agent_selected", "generation_started", "process_started", "first_output", "process_exit", "task_started", "task_scheduled", "availability_check", "profile_available"].includes(type)) return "stage";
    return "system";
}

function eventProfileSummary(profile) {
    if (!profile || typeof profile !== "object") return "";
    return [profile.name, profile.provider || profile.agentType, profile.modelName]
        .map((value) => String(value || "").trim())
        .filter(Boolean)
        .join(" · ");
}

function sameEventProfile(left, right) {
    return String(left?.profile?.id || left?.profile?.name || "")
        === String(right?.profile?.id || right?.profile?.name || "");
}

function joinLogChunks(left, right) {
    const first = String(left || "");
    const second = String(right || "");
    if (!first) return second;
    if (!second) return first;
    return first.endsWith("\n") || second.startsWith("\n") ? `${first}${second}` : `${first}\n${second}`;
}

function legacyLogPreview(value) {
    const content = String(value || "");
    if (content.length <= MAX_LEGACY_LOG_RENDER_CHARS) {
        return { content, truncated: false };
    }
    return {
        content: content.slice(-MAX_LEGACY_LOG_RENDER_CHARS),
        truncated: true,
    };
}

function coalesceLogEvents(events) {
    const groups = [];
    for (const rawEvent of events || []) {
        const event = rawEvent && typeof rawEvent === "object" ? { ...rawEvent } : null;
        if (!event) continue;
        const type = String(event.type || "system").toLowerCase();
        const previous = groups[groups.length - 1];
        const canMerge = previous
            && TERMINAL_EVENT_TYPES.has(type)
            && String(previous.type || "").toLowerCase() === type
            && String(previous.stream || "") === String(event.stream || "")
            && String(previous.runId || "") === String(event.runId || "")
            && String(previous.phase || "") === String(event.phase || "")
            && sameEventProfile(previous, event);
        if (!canMerge) {
            groups.push({
                ...event,
                _chunkCount: 1,
                _lastSequence: Number(event.sequence || 0),
                _lastTimestamp: event.timestamp || null,
            });
            continue;
        }
        previous.text = joinLogChunks(previous.text, event.text);
        previous._chunkCount += 1;
        previous._lastSequence = Number(event.sequence || previous._lastSequence || 0);
        previous._lastTimestamp = event.timestamp || previous._lastTimestamp;
    }
    return groups;
}

function metadataLabel(key) {
    return translatedOr(`logMeta.${key}`, key);
}

function metadataValue(key, value) {
    if (key === "durationMs" || key === "delayMs") return formatDuration(value);
    if (key === "nextCheckAt") return formatTime(value);
    if (key === "stdoutBytes" || key === "stderrBytes") return formatLogBytes(value);
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function visibleLogMetadata(event) {
    const metadata = event?.metadata && typeof event.metadata === "object" && !Array.isArray(event.metadata)
        ? event.metadata
        : {};
    return LOG_METADATA_KEYS
        .filter((key) => Object.prototype.hasOwnProperty.call(metadata, key) && metadata[key] !== null && metadata[key] !== "")
        .map((key) => [key, metadataValue(key, metadata[key])]);
}

function logSequenceLabel(event) {
    const start = Number(event?.sequence || 0);
    const end = Number(event?._lastSequence || start);
    if (!start) return "";
    return start === end ? `#${start}` : `#${start}–${end}`;
}

function renderLogEventText(event) {
    const text = String(event?.text ?? "");
    const lines = text ? text.split(/\r?\n/).length : 0;
    const isLong = text.length > 900 || lines > 12;
    const pre = `<pre class="log-event-text">${escapeHtml(text || "-")}</pre>`;
    if (!isLong) return pre;
    const lead = (text.split(/\r?\n/).find((line) => line.trim()) || "")
        .trim()
        .slice(0, 110);
    const summary = translatedOr("runtime.expandLog", `${lines} lines`, { count: lines });
    const open = logEventKind(event) === "agent" || logEventKind(event) === "error" ? " open" : "";
    return `
        <details class="log-event-details"${open}>
            <summary><span>${escapeHtml(summary)}</span>${lead ? `<code>${escapeHtml(lead)}</code>` : ""}</summary>
            ${pre}
        </details>
    `;
}

function renderLogEventExtras(event) {
    const metadata = event?.metadata && typeof event.metadata === "object" && !Array.isArray(event.metadata)
        ? event.metadata
        : {};
    const items = Array.isArray(metadata.items) ? metadata.items : [];
    const artifacts = Array.isArray(metadata.artifacts) ? metadata.artifacts : [];
    const blocks = [];
    if (items.length > 0) {
        blocks.push(`
            <section class="log-event-list">
                <strong>${escapeHtml(t("runtime.appendedItemsLabel"))}</strong>
                <ol>${items.slice(0, 100).map((item) => `<li>${escapeHtml(typeof item === "string" ? item : item?.text || item?.title || JSON.stringify(item))}</li>`).join("")}</ol>
                ${items.length > 100 ? `<span>${escapeHtml(t("runtime.moreItems", { count: items.length - 100 }))}</span>` : ""}
            </section>
        `);
    }
    if (artifacts.length > 0) {
        blocks.push(`
            <div class="log-event-artifacts"><b>${escapeHtml(t("runtime.artifactsLabel"))}</b>${artifacts.map((item) => `<code>${escapeHtml(item)}</code>`).join("")}</div>
        `);
    }
    return blocks.join("");
}

function renderLogEvent(event) {
    const kind = logEventKind(event);
    const profile = eventProfileSummary(event.profile);
    const stream = streamLabel(event.stream);
    const metadata = visibleLogMetadata(event);
    const chunkLabel = Number(event._chunkCount || 1) > 1
        ? translatedOr("runtime.logChunks", `${event._chunkCount} chunks`, { count: event._chunkCount })
        : "";
    return `
        <article class="log-event log-event-${escapeHtml(kind)}" data-event-type="${escapeHtml(event.type || "system")}" data-sequence="${escapeHtml(event.sequence || "")}">
            <div class="log-event-rail" aria-hidden="true">
                <span class="log-event-dot"></span>
                <span class="log-event-sequence">${escapeHtml(logSequenceLabel(event))}</span>
            </div>
            <div class="log-event-body">
                <header class="log-event-head">
                    <div class="log-event-identity">
                        <span class="log-event-label">${escapeHtml(eventTypeLabel(event.type))}</span>
                        <span class="log-event-phase">${escapeHtml(phaseLabel(event.phase))}</span>
                        ${stream ? `<span class="log-stream-chip log-stream-${escapeHtml(event.stream)}">${escapeHtml(stream)}</span>` : ""}
                        ${chunkLabel ? `<span class="log-chunk-count">${escapeHtml(chunkLabel)}</span>` : ""}
                    </div>
                    <time datetime="${escapeHtml(event.timestamp || "")}">${escapeHtml(formatTime(event.timestamp))}</time>
                </header>
                ${profile ? `<div class="log-event-profile"><span class="agent-orb"></span>${escapeHtml(profile)}</div>` : ""}
                ${renderLogEventText(event)}
                ${renderLogEventExtras(event)}
                ${metadata.length ? `
                    <div class="log-event-metadata">
                        ${metadata.map(([key, value]) => `<span><b>${escapeHtml(metadataLabel(key))}</b>${escapeHtml(value)}</span>`).join("")}
                    </div>
                ` : ""}
            </div>
        </article>
    `;
}

function isLogNearBottom(node, threshold = 56) {
    if (!node) return true;
    return node.scrollHeight - node.scrollTop - node.clientHeight <= threshold;
}

function setLogFollowing(following, scroll = false) {
    state.log.following = Boolean(following);
    const view = $("#logView");
    if (scroll && view) view.scrollTop = view.scrollHeight;
    const button = $("#followLog");
    if (!button) return;
    button.classList.toggle("paused", !state.log.following);
    button.setAttribute("aria-pressed", String(state.log.following));
    button.textContent = state.log.following
        ? t("runtime.pauseFollow")
        : t("runtime.followLatest");
}

function runOptionLabel(run) {
    const status = statusLabel(run?.status || "running");
    const time = formatTime(run?.startedAt || run?.scheduledAt || run?.lastEventAt);
    const events = Number(run?.eventCount || 0);
    return `${time} · ${status} · ${translatedOr("runtime.eventCount", `${events} events`, { count: events })}`;
}

function runSummaryLabel(run) {
    if (!run) return t("runtime.allRuns");
    const status = statusLabel(run.status || "running");
    return `${formatTime(run.startedAt || run.scheduledAt || run.lastEventAt)} · ${status}`;
}

function renderLogRunOptions() {
    const select = $("#logRunSelect");
    if (!select) return;
    const selected = state.log.runId || "";
    const options = [
        `<option value="" ${selected ? "" : "selected"}>${escapeHtml(t("runtime.allRuns"))}</option>`,
        ...(state.log.runs || []).map((run) => `
            <option value="${escapeHtml(run.runId)}" ${run.runId === selected ? "selected" : ""}>${escapeHtml(runOptionLabel(run))}</option>
        `),
    ];
    select.innerHTML = options.join("");
    select.disabled = !state.log.taskId || state.log.loading;
}

function renderLogNotice() {
    const notice = $("#logNotice");
    if (!notice) return;
    const warningMessages = (state.log.warnings || [])
        .map((warning) => warning?.message || warning?.code || "")
        .filter(Boolean);
    const messages = state.log.error ? [state.log.error] : warningMessages;
    if (messages.length === 0) {
        notice.hidden = true;
        notice.textContent = "";
        notice.className = "log-notice";
        return;
    }
    notice.hidden = false;
    notice.className = `log-notice ${state.log.error ? "log-notice-error" : "log-notice-warning"}`;
    notice.textContent = messages.join(" · ");
}

function renderConversationLog({ forceFollow = false } = {}) {
    const view = $("#logView");
    if (!view) return;
    const previousScrollTop = view.scrollTop;
    const shouldFollow = forceFollow || state.log.following;
    view.setAttribute("aria-busy", String(state.log.loading));
    const renderKey = JSON.stringify([state.log.taskId, state.log.runId, state.log.renderVersion, state.log.error,
        state.log.events.length === 0 && !state.log.content && state.log.loading, i18n.getLanguage()]);

    if (view.dataset.renderKey !== renderKey) {
        view.dataset.renderKey = renderKey;
        renderConversationBody(view);
    }

    const eventCount = state.log.events.length;
    const format = translatedOr(`logFormat.${state.log.format}`, state.log.format || "empty");
    const runLabel = state.log.runId
        ? runSummaryLabel((state.log.runs || []).find((run) => run.runId === state.log.runId) || { runId: state.log.runId })
        : t("runtime.allRuns");
    $("#logSummary").textContent = state.log.taskId
        ? `${t("runtime.eventWindow", { count: eventCount, total: state.log.totalEvents || eventCount })} · ${runLabel} · ${format}`
        : t("runtime.noTask");
    $("#logCursor").textContent = state.log.taskId
        ? `${translatedOr("runtime.cursor", "Cursor", { value: state.log.nextCursor || 0 })} · ${state.log.loading ? t("runtime.syncing") : t("runtime.synced")}`
        : "";
    $("#olderLog").disabled = state.log.loading || !state.log.hasMoreBefore || !state.log.firstCursor;
    renderLogRunOptions();
    renderLogNotice();
    setLogFollowing(state.log.following);

    if (shouldFollow) view.scrollTop = view.scrollHeight;
    else view.scrollTop = previousScrollTop;
}

function renderConversationBody(view) {
    if (state.log.loading && state.log.events.length === 0 && !state.log.content) {
        view.innerHTML = `
            <div class="log-state log-state-loading">
                <span class="loading-pulse"></span>
                <strong>${escapeHtml(t("runtime.logLoading"))}</strong>
                <span>${escapeHtml(t("runtime.logLoadingHint"))}</span>
            </div>
        `;
    } else if (state.log.error && state.log.events.length === 0 && !state.log.content) {
        view.innerHTML = `
            <div class="log-state log-state-error">
                <strong>${escapeHtml(t("runtime.logFailed"))}</strong>
                <span>${escapeHtml(state.log.error)}</span>
            </div>
        `;
    } else if (state.log.events.length > 0) {
        const groupedEvents = coalesceLogEvents(state.log.events);
        view.innerHTML = `
            <div class="conversation-intro">
                <span class="conversation-kicker">${escapeHtml(t("runtime.workflowKicker"))}</span>
                <strong>${escapeHtml(translatedOr("runtime.workflowLoaded", "Workflow loaded", { count: state.log.events.length }))}</strong>
                <span>${escapeHtml(t("runtime.workflowHint"))}</span>
            </div>
            <div class="log-timeline">
                ${groupedEvents.map(renderLogEvent).join("")}
            </div>
        `;
    } else if (state.log.content) {
        view.innerHTML = `
            <div class="conversation-intro legacy-intro">
                <span class="conversation-kicker">${escapeHtml(t("runtime.legacyKicker"))}</span>
                <strong>${escapeHtml(t("runtime.legacyLog"))}</strong>
                <span>${escapeHtml(t("runtime.legacyLogHint"))}</span>
            </div>
            <pre class="legacy-log-view">${escapeHtml(state.log.content)}</pre>
        `;
    } else {
        view.innerHTML = `
            <div class="log-state log-state-empty">
                <strong>${escapeHtml(t("log.empty"))}</strong>
                <span>${escapeHtml(t("runtime.logEmptyHint"))}</span>
            </div>
        `;
    }

}

function logPlainText() {
    if (state.log.events.length === 0) return state.log.content || "";
    return state.log.events.map((event) => {
        const profile = eventProfileSummary(event.profile);
        const heading = [event.timestamp, event.type, profile].filter(Boolean).join(" · ");
        return `[${heading}]\n${String(event.text || "")}`;
    }).join("\n\n");
}

function parseScheduleInput(value) {
    const raw = String(value || "").trim();
    if (!raw) return null;
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return null;
    return date;
}

function datetimeLocalValue(date) {
    const pad = (value) => String(value).padStart(2, "0");
    return [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate()),
    ].join("-") + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function syncScheduleInput() {
    const input = $("#scheduleStartAt");
    if (!input) return;
    const minimum = new Date(Date.now() + 60000);
    input.min = datetimeLocalValue(minimum);
}

function selectedScheduleMode() {
    return $("#scheduleMode")?.value === "profile_available" ? "profile_available" : "fixed_time";
}

function scheduleModeLabel(mode) {
    if (mode === "profile_available") return t("runtime.scheduleMode.profileAvailable");
    if (mode === "fixed_time") return t("runtime.scheduleMode.fixedTime");
    if (mode === "immediate") return t("runtime.scheduleMode.immediate");
    return "-";
}

function syncScheduleMode() {
    const mode = selectedScheduleMode();
    const timeField = $("#scheduleTimeField");
    const timeInput = $("#scheduleStartAt");
    const hint = $("#scheduleModeHint");
    const usesFixedTime = mode === "fixed_time";
    if (timeField) timeField.hidden = !usesFixedTime;
    if (timeInput) timeInput.disabled = !usesFixedTime;
    if (hint) {
        hint.textContent = usesFixedTime
            ? t("runtime.scheduleHint.fixedTime")
            : t("runtime.scheduleHint.profileAvailable");
    }
}

function syncTaskScheduleControls(task, force = false) {
    const taskId = String(task?.id || "");
    if (!force && state.scheduleTaskId === taskId) return;
    state.scheduleTaskId = taskId;
    const modeSelect = $("#scheduleMode");
    const timeInput = $("#scheduleStartAt");
    if (modeSelect) {
        modeSelect.value = task?.scheduleMode === "profile_available" ? "profile_available" : "fixed_time";
    }
    if (timeInput) {
        const scheduledAt = task?.scheduledStartAt ? new Date(task.scheduledStartAt) : null;
        timeInput.value = scheduledAt && !Number.isNaN(scheduledAt.getTime())
            ? datetimeLocalValue(scheduledAt)
            : "";
    }
    syncScheduleMode();
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
    const { conditional = false, ...requestOptions } = options;
    const etag = conditional ? state.responseEtags.get(path) : null;
    const response = await fetch(path, {
        ...requestOptions,
        headers: { "content-type": "application/json", ...requestOptions.headers, ...(etag ? { "if-none-match": etag } : {}) },
        body: requestOptions.body ? JSON.stringify(requestOptions.body) : undefined,
    });
    if (response.status === 304) return null;
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || t("api.requestFailed"));
    if (conditional && response.headers.get("etag")) state.responseEtags.set(path, response.headers.get("etag"));
    return payload;
}

function modalityLabel(modality) {
    const key = `modality.${modality}`;
    const translated = t(key);
    return translated === key ? modality : translated;
}

function profileSupports(profile, modality = "text") {
    const outputs = Array.isArray(profile?.outputModalities) && profile.outputModalities.length
        ? profile.outputModalities
        : ["text"];
    return outputs.includes(modality);
}

function profileOptions(selected = "", outputModality = "") {
    const profiles = state.data?.profiles || [];
    const selectedIds = new Set((Array.isArray(selected) ? selected : [selected])
        .map((id) => String(id || ""))
        .filter(Boolean));
    return profiles
        .filter((profile) => profile.enabled !== false && (!outputModality || profileSupports(profile, outputModality)))
        .map((profile) => {
            const provider = profile.provider || profile.agentType;
            const outputs = (profile.outputModalities || ["text"]).map(modalityLabel).join("+");
            return `<option value="${escapeHtml(profile.id)}" ${selectedIds.has(profile.id) ? "selected" : ""}>${escapeHtml(profile.name)} · ${escapeHtml(provider)} · ${escapeHtml(outputs)}</option>`;
        })
        .join("");
}

function formatBytes(value) {
    const bytes = Number(value || 0);
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function directoryOptions(selected = "") {
    return (state.data?.directories || [])
        .map((directory) => `<option value="${escapeHtml(directory)}" ${directory === selected ? "selected" : ""}>${escapeHtml(directory)}</option>`)
        .join("");
}

function syncTaskProjectDirectory() {
    const form = $("#taskForm");
    if (!form) return;
    const project = (state.data?.projects || []).find((item) => item.id === form.elements.projectId?.value);
    const directory = form.elements.directory;
    if (!directory) return;
    if (project?.directory) {
        directory.value = project.directory;
        directory.disabled = true;
    } else {
        directory.disabled = false;
    }
}

function projectOptions(selected = "", includeUnbound = false) {
    const unbound = includeUnbound
        ? `<option value="" ${selected ? "" : "selected"}>${escapeHtml(t("project.unbound"))}</option>`
        : "";
    return unbound + (state.data?.projects || [])
        .map((project) => `<option value="${escapeHtml(project.id)}" ${project.id === selected ? "selected" : ""}>${escapeHtml(project.name)}${project.directory ? ` · ${escapeHtml(project.directory)}` : ` · ${escapeHtml(t("project.unboundLabel"))}`}</option>`)
        .join("");
}

function taskOptions(selected = "", includeArchived = true) {
    return (state.data?.tasks || [])
        .filter((task) => includeArchived || !task.archived)
        .map((task) => `<option value="${escapeHtml(task.id)}" ${task.id === selected ? "selected" : ""}>${escapeHtml(task.title)}</option>`)
        .join("");
}

function selectedValues(select) {
    return Array.from(select?.selectedOptions || [])
        .map((option) => option.value)
        .filter(Boolean);
}

function taskProfileIds(task) {
    const ids = Array.isArray(task?.runProfileIds) ? task.runProfileIds : [];
    return ids.length ? ids : [task?.runProfileId || task?.decomposeProfileId || ""].filter(Boolean);
}

function taskRuntimeState(task) {
    if (task?.runtimeState) return task.runtimeState;
    if (task?.isAgentRunning || task?.activeProcess) return "agent_running";
    if (task?.isRunning) return "idle_waiting";
    return "loop_not_started";
}

function taskRuntimeLabel(task) {
    if (task?.status === "queued") return t("runtimeState.queue_waiting");
    if (task?.status === "scheduled" && task?.scheduleMode === "profile_available") {
        return t("runtimeState.waitingAvailability");
    }
    if (task?.status === "scheduled") return t("runtimeState.scheduled");
    const runtimeState = taskRuntimeState(task);
    const key = `runtimeState.${runtimeState}`;
    const translated = t(key);
    return translated === key ? runtimeState : translated;
}

function taskDisplayStatus(task) {
    if (["all_done", "completed", "failed", "stopped", "not_started"].includes(String(task?.status || ""))) {
        return statusLabel(task.status);
    }
    return taskRuntimeLabel(task);
}

function statusLabel(status) {
    const key = `status.${status}`;
    const translated = t(key);
    return translated === key ? status : translated;
}

function processSummary(processInfo) {
    if (!processInfo) return "-";
    const pid = processInfo.pid ? `PID ${processInfo.pid}` : "PID -";
    const profile = [processInfo.profileName, processInfo.provider || processInfo.agentType, processInfo.modelName].filter(Boolean).join(" · ");
    return [pid, profile].filter(Boolean).join(" · ");
}

function profileNames(ids) {
    const names = (Array.isArray(ids) ? ids : [ids])
        .filter(Boolean)
        .map((id) => findProfileName(id));
    return names.length ? names.join(" -> ") : "-";
}

function successText(value) {
    return value ? t("ping.successText") : t("ping.failureText");
}

function getSelectedTask() {
    return (state.data?.tasks || []).find((task) => task.id === state.selectedTaskId) || state.data?.tasks?.[0] || null;
}

function dashboardEventTarget(event) {
    if (event?.taskId) return { view: "runtime", taskId: String(event.taskId) };
    const type = String(event?.type || "").toLowerCase();
    if (type === "ping") return { view: "pings" };
    if (type === "profile" || type === "profile_selected") return { view: "profiles" };
    if (type === "directory") return { view: "settings" };
    if (["project", "task", "queued", "queue_error", "archive"].includes(type)) return { view: "tasks" };
    return null;
}

function renderMetrics() {
    const tasks = (state.data?.tasks || []).filter((task) => !task.archived);
    const profiles = state.data?.profiles || [];
    const agentRunning = tasks.filter((task) => taskRuntimeState(task) === "agent_running").length;
    const idleWaiting = tasks.filter((task) => taskRuntimeState(task) === "idle_waiting").length;
    const queueWaiting = tasks.filter((task) => taskRuntimeState(task) === "queue_waiting").length;
    const loopNotStarted = tasks.filter((task) => taskRuntimeState(task) === "loop_not_started").length;
    $("#metrics").innerHTML = [
        { label: t("metric.profiles.label"), value: profiles.length, caption: t("metric.profiles.caption"), view: "profiles" },
        { label: t("metric.agentRunning.label"), value: agentRunning, caption: t("metric.agentRunning.caption"), view: "tasks", runtimeState: "agent_running" },
        { label: t("metric.idleWaiting.label"), value: idleWaiting, caption: t("metric.idleWaiting.caption"), view: "tasks", runtimeState: "idle_waiting" },
        { label: t("metric.queueWaiting.label"), value: queueWaiting, caption: t("metric.queueWaiting.caption"), view: "tasks", runtimeState: "queue_waiting" },
        { label: t("metric.loopNotStarted.label"), value: loopNotStarted, caption: t("metric.loopNotStarted.caption"), view: "tasks", runtimeState: "loop_not_started" },
    ].map(({ label, value, caption, view, runtimeState = "" }) => `
        <button class="metric dashboard-card" type="button" data-dashboard-view="${escapeHtml(view)}" data-dashboard-runtime-state="${escapeHtml(runtimeState)}" aria-label="${escapeHtml(t("dashboard.openCard", { name: label }))}">
            <span>${label}</span>
            <b>${value}</b>
            <span>${caption}</span>
            <span class="dashboard-card-arrow" aria-hidden="true">&#8599;</span>
        </button>
    `).join("");
}

function renderTasks() {
    const tasks = state.data?.tasks || [];
    const currentTasks = tasks.filter((task) => !task.archived);
    const empty = `<div class="empty">${escapeHtml(t("empty.tasks"))}</div>`;
    const cards = currentTasks.map((task) => {
        const runtimeState = taskRuntimeState(task);
        const processMeta = task.activeProcess ? `<span>${escapeHtml(processSummary(task.activeProcess))}</span>` : "";
        return `
        <article class="task-card clickable-task" data-open-task="${escapeHtml(task.id)}" data-runtime-state="${escapeHtml(runtimeState)}" tabindex="0" role="button" aria-label="${escapeHtml(t("dashboard.openTask", { name: task.title }))}">
            <div>
                <p class="task-title">${escapeHtml(task.title)}</p>
                <div class="meta">
                    <span class="modality-chip ${escapeHtml(task.taskType || "text")}">${escapeHtml(modalityLabel(task.taskType || "text"))}</span>
                    ${task.projectId ? `<button class="project-jump" type="button" data-open-project="${escapeHtml(task.projectId)}" aria-label="${escapeHtml(t("dashboard.openProject", { name: task.projectName || t("task.project") }))}">${escapeHtml(task.projectName || t("task.project"))}</button>` : ""}
                    <span>${escapeHtml(task.targetFileName)}</span>
                    <span>${escapeHtml(task.directory)}</span>
                    <span>${escapeHtml(profileNames(taskProfileIds(task)))}</span>
                    <span>${escapeHtml(t("task.meta.result", { value: statusLabel(task.status) }))}</span>
                    ${processMeta}
                    ${(task.taskType || "text") !== "text" ? `<span>${escapeHtml(t("task.meta.artifacts", { count: task.artifactCount || 0 }))}</span>` : ""}
                    <span>${escapeHtml(t("task.meta.retry", { count: task.retryCount || 0 }))}</span>
                </div>
            </div>
            <span class="badge ${escapeHtml(runtimeState)}">${escapeHtml(taskDisplayStatus(task))}</span>
        </article>
    `;
    }).join("");
    $("#taskBoard").innerHTML = cards || empty;
    const projects = state.data?.projects || [];
    const projectMarkup = projects.map((project) => {
        const projectTasks = tasks.filter((task) => task.projectId === project.id);
        const current = projectTasks.filter((task) => !task.archived);
        const archived = projectTasks.filter((task) => task.archived);
        const renderTreeTask = (task) => {
            const runtimeState = taskRuntimeState(task);
            const status = task.archived ? statusLabel(task.status) : taskDisplayStatus(task);
            const queueMeta = task.queuePosition ? `<span>${escapeHtml(t("runtime.queuePosition", { position: task.queuePosition }))}</span>` : "";
            return `
                <article class="tree-task ${task.archived ? "tree-task-archived" : ""} ${task.id === state.taskEditor.taskId ? "tree-task-selected" : ""} clickable-task" data-open-task="${escapeHtml(task.id)}" aria-current="${task.id === state.taskEditor.taskId ? "true" : "false"}" data-runtime-state="${escapeHtml(runtimeState)}" tabindex="0" role="button" aria-label="${escapeHtml(t("dashboard.openTask", { name: task.title }))}">
                    <div class="tree-task-main">
                        <span class="tree-branch">--</span>
                        <div>
                            <p class="task-title">${escapeHtml(task.title)}</p>
                            <div class="meta">
                                <span class="modality-chip ${escapeHtml(task.taskType || "text")}">${escapeHtml(modalityLabel(task.taskType || "text"))}</span>
                                <span>${escapeHtml(task.targetFileName || "-")}</span>
                                <span>${escapeHtml(status)}</span>
                                ${queueMeta}
                                <span>${escapeHtml(formatTime(task.updatedAt))}</span>
                            </div>
                        </div>
                    </div>
                    <div class="task-actions">
                        <span class="badge ${escapeHtml(task.archived ? "completed" : runtimeState)}">${escapeHtml(status)}</span>
                        <button class="ghost" type="button" data-open-history="${escapeHtml(task.id)}" data-open-task="${escapeHtml(task.id)}">${escapeHtml(t("common.logs"))}</button>
                        ${task.archived ? "" : `<button class="ghost" type="button" data-archive-task="${escapeHtml(task.id)}">${escapeHtml(t("task.archive"))}</button>`}
                        <button class="danger" type="button" data-delete-task="${escapeHtml(task.id)}" aria-label="${escapeHtml(t("task.deleteLabel", { name: task.title }))}" ${taskCanDelete(task) ? "" : `disabled title="${escapeHtml(t("task.deleteBusy"))}"`}>${escapeHtml(t("common.delete"))}</button>
                    </div>
                </article>`;
        };
        return `
            <section class="project-tree" data-project-id="${escapeHtml(project.id)}" tabindex="-1">
                <header class="project-tree-head">
                    <div>
                        <h3>${escapeHtml(project.name)}</h3>
                        <p class="pathline">${escapeHtml(project.directory || t("project.unboundLabel"))}</p>
                    </div>
                    <span class="hint">${escapeHtml(t("project.taskCount", { count: projectTasks.length }))}</span>
                </header>
                <div class="project-tree-group">
                    <div class="tree-group-label">${escapeHtml(t("project.current"))}</div>
                    ${current.map(renderTreeTask).join("") || `<div class="tree-empty">${escapeHtml(t("project.empty"))}</div>`}
                </div>
                <div class="project-tree-group archive-group">
                    <div class="tree-group-label">${escapeHtml(t("project.archive"))}</div>
                    ${archived.map(renderTreeTask).join("") || `<div class="tree-empty">${escapeHtml(t("project.empty"))}</div>`}
                </div>
            </section>`;
    }).join("");
    $("#taskList").innerHTML = projectMarkup || empty;
    $("#taskCount").textContent = i18n.count("task.count", tasks.length);
    $("#deduplicateTasks").disabled = state.deduplicatingTasks || currentTasks.length < 2;
}

function renderEvents() {
    const events = state.data?.events || [];
    $("#eventFeed").innerHTML = events.map((event) => {
        const target = dashboardEventTarget(event);
        const targetAttributes = target
            ? ` data-dashboard-view="${escapeHtml(target.view)}" data-dashboard-task="${escapeHtml(target.taskId || "")}" tabindex="0" role="button" aria-label="${escapeHtml(t("dashboard.openEvent"))}"`
            : "";
        return `
        <article class="event-item${target ? " dashboard-event" : ""}"${targetAttributes}>
            <time>${formatTime(event.createdAt)} · ${escapeHtml(event.type)}</time>
            <div>${escapeHtml(event.message)}</div>
        </article>
    `;
    }).join("") || `<div class="empty">${escapeHtml(t("empty.events"))}</div>`;
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
                <span>${escapeHtml(profile.provider || "custom")}</span>
                <span>${escapeHtml(profile.agentType)}</span>
                <span>${escapeHtml(profile.command)}</span>
                <span>${escapeHtml(profile.enabled === false ? t("profile.state.disabled") : t("profile.state.enabled"))}</span>
            </div>
            <div class="meta">
                <span>${escapeHtml(profile.args || "-")}</span>
                <span>ENV ${profile.envKeys?.length || 0}</span>
            </div>
            <div class="meta">
                ${(profile.inputModalities || ["text"]).map((item) => `<span class="modality-chip ${escapeHtml(item)}">IN ${escapeHtml(modalityLabel(item))}</span>`).join("")}
                ${(profile.outputModalities || ["text"]).map((item) => `<span class="modality-chip ${escapeHtml(item)}">OUT ${escapeHtml(modalityLabel(item))}</span>`).join("")}
            </div>
            <div class="meta">
                <span>${escapeHtml(t("profile.card.model", { value: profile.modelName || "-" }))}</span>
                <span>Base ${escapeHtml(profile.baseUrl || "-")}</span>
                <span>Token ${profile.apiTokenConfigured ? escapeHtml(profile.apiTokenPreview || t("profile.card.tokenConfigured")) : "-"}</span>
                <span>${escapeHtml(profile.pingEnabled === false
                    ? t("profile.card.testOff")
                    : t("profile.card.testInterval", { minutes: profile.pingIntervalMinutes || 60 }))}</span>
                <span>${escapeHtml(t("profile.card.config", { value: profile.configDirectory || "-" }))}</span>
                <span>${escapeHtml(t("profile.card.workDir", { value: profile.defaultDirectory || "-" }))}</span>
            </div>
            <button class="ghost" type="button" data-edit-profile="${escapeHtml(profile.id)}">${escapeHtml(t("common.edit"))}</button>
        </article>
    `).join("") || `<div class="empty">${escapeHtml(t("empty.profiles"))}</div>`;
}

function formatPingDuration(value) {
    if (value === null || value === undefined || value === "") return "-";
    return formatDuration(value);
}

function formatPingTokens(value) {
    if (value === null || value === undefined || value === "") return "-";
    const count = Number(value);
    if (!Number.isFinite(count) || count < 0) return "-";
    return new Intl.NumberFormat(i18n.getLocale()).format(Math.round(count));
}

function pingFirstOutputLatency(record) {
    const rawMeasured = record?.firstOutputLatencyMs;
    const measured = rawMeasured === null || rawMeasured === undefined || rawMeasured === ""
        ? NaN
        : Number(rawMeasured);
    if (Number.isFinite(measured) && measured >= 0) return measured;
    const createdAt = new Date(record?.createdAt || "").getTime();
    const firstOutputAt = new Date(record?.firstOutputAt || "").getTime();
    if (Number.isFinite(createdAt) && Number.isFinite(firstOutputAt) && firstOutputAt >= createdAt) {
        return firstOutputAt - createdAt;
    }
    return null;
}

function renderPingCells(record) {
    const result = record.success
        ? `
            <span class="ping-result-cell" role="cell">
                <span class="badge ping_success">${escapeHtml(successText(true))}</span>
                <span class="ping-expand-hint">${escapeHtml(t("ping.expandHint"))}</span>
                <span class="ping-chevron" aria-hidden="true">⌄</span>
            </span>`
        : `
            <span class="ping-result-cell ping-result-failure" role="cell">
                <span class="badge ping_failed">${escapeHtml(successText(false))}</span>
                <span class="ping-failure-reason">${escapeHtml(record.failureReason || t("ping.failureUnknown"))}</span>
            </span>`;
    return `
        <span role="cell">${escapeHtml(record.minute || formatTime(record.createdAt))}</span>
        <span role="cell" class="ping-model">${escapeHtml(record.model || `${record.profileName} (${record.agentType})`)}</span>
        <span role="cell" class="ping-metric">${escapeHtml(formatPingDuration(record.success ? pingFirstOutputLatency(record) : null))}</span>
        <span role="cell" class="ping-metric">${escapeHtml(formatPingDuration(record.durationMs))}</span>
        <span role="cell" class="ping-metric">${escapeHtml(formatPingTokens(record.success ? record.inputTokens : null))}</span>
        <span role="cell" class="ping-metric">${escapeHtml(formatPingTokens(record.success ? record.outputTokens : null))}</span>
        ${result}
    `;
}

function renderPingRecord(record, openRecordIds) {
    if (!record.success) {
        return `<div class="ping-record ping-record-failed" data-ping-record-id="${escapeHtml(record.id || "")}">
            <div class="ping-row" role="row">${renderPingCells(record)}</div>
        </div>`;
    }
    const inputText = record.inputText || record.prompt || "-";
    const outputText = record.outputText || record.outputTail || "-";
    const open = openRecordIds.has(String(record.id || "")) ? " open" : "";
    return `<details class="ping-record ping-record-success" data-ping-record-id="${escapeHtml(record.id || "")}"${open}>
        <summary class="ping-row" role="row">${renderPingCells(record)}</summary>
        <div class="ping-io-details">
            <section class="ping-io-block">
                <p>${escapeHtml(t("ping.detail.input"))}</p>
                <pre>${escapeHtml(inputText)}</pre>
            </section>
            <section class="ping-io-block">
                <p>${escapeHtml(t("ping.detail.output"))}</p>
                <pre>${escapeHtml(outputText)}</pre>
                ${record.outputTruncated ? `<span class="ping-detail-note">${escapeHtml(t("ping.detail.truncated"))}</span>` : ""}
            </section>
        </div>
    </details>`;
}

function renderPingProfilePicker() {
    const listNode = $("#pingProfileList");
    const summaryNode = $("#pingProfileSummary");
    if (!listNode) return;
    const selectedIds = new Set(state.data?.pingSettings?.profileIds || []);
    const candidates = (state.data?.profiles || []).filter((profile) => profile.pingEligible === true);
    if (summaryNode) {
        summaryNode.textContent = t("ping.profiles.summary", {
            selected: candidates.filter((profile) => selectedIds.has(profile.id)).length,
            total: candidates.length,
        });
    }
    listNode.innerHTML = candidates.map((profile) => `
        <label class="checkline">
            <input type="checkbox" name="pingProfileIds" value="${escapeHtml(profile.id)}"${selectedIds.has(profile.id) ? " checked" : ""}>
            <span>${escapeHtml(profile.name)}</span>
            <span class="hint">${escapeHtml(profile.agentType)} · ${escapeHtml(t("ping.profiles.interval", { minutes: profile.pingIntervalMinutes || 60 }))}${profile.enabled === false ? ` ${escapeHtml(t("ping.profiles.disabled"))}` : ""}</span>
        </label>
    `).join("") || `<div class="empty">${escapeHtml(t("ping.profiles.empty"))}</div>`;
}

function renderPings() {
    const records = state.data?.pingRecords || [];
    const days = state.data?.pingDays || [];
    const pingDaysNode = $("#pingDays");
    const openRecordIds = new Set($$(".ping-record[open]", pingDaysNode)
        .map((node) => String(node.dataset.pingRecordId || "")));
    const pingEnabled = state.data?.pingSettings?.enabled !== false;
    const runButton = $("#runPing");
    const pingToggle = $("#pingEnabled");
    if (runButton) runButton.disabled = state.data?.pingRunning === true || !pingEnabled;
    if (pingToggle) pingToggle.checked = pingEnabled;
    renderPingProfilePicker();
    const baseSummary = records.length
        ? `${i18n.count("ping.records", records.length)} | ${t("ping.latest", { value: records[0].minute || formatTime(records[0].createdAt) })}`
        : i18n.count("ping.records", 0);
    $("#pingSummary").textContent = `${pingEnabled ? t("ping.enabled") : t("ping.disabled")} | ${t("ping.questions", { count: state.data?.pingQuestionCount || 0 })} | ${baseSummary}`;
    pingDaysNode.innerHTML = days.map((day) => `
        <article class="ping-day">
            <div class="ping-day-head">
                <div>
                    <p class="ping-date">${escapeHtml(day.date)}</p>
                    <div class="meta">
                        <span>${escapeHtml(t("ping.total", { count: day.total }))}</span>
                        <span>${escapeHtml(t("ping.success", { count: day.success }))}</span>
                        <span>${escapeHtml(t("ping.failed", { count: day.failed }))}</span>
                    </div>
                </div>
            </div>
            <div class="ping-table" role="table" aria-label="${escapeHtml(t("ping.recordsLabel", { date: day.date }))}">
                <div class="ping-row ping-row-head" role="row">
                    <span role="columnheader">${escapeHtml(t("ping.column.minute"))}</span>
                    <span role="columnheader">${escapeHtml(t("ping.column.model"))}</span>
                    <span role="columnheader">${escapeHtml(t("ping.column.firstOutput"))}</span>
                    <span role="columnheader">${escapeHtml(t("ping.column.duration"))}</span>
                    <span role="columnheader">${escapeHtml(t("ping.column.inputTokens"))}</span>
                    <span role="columnheader">${escapeHtml(t("ping.column.outputTokens"))}</span>
                    <span role="columnheader">${escapeHtml(t("ping.column.success"))}</span>
                </div>
                ${day.records.map((record) => renderPingRecord(record, openRecordIds)).join("")}
            </div>
        </article>
    `).join("") || `<div class="empty">${escapeHtml(t("empty.pings"))}</div>`;
}

function renderSelectors() {
    const firstProfile = state.data?.profiles?.find((profile) => profile.enabled !== false);
    const firstTask = state.data?.tasks?.[0];
    if (!state.selectedProfileId && firstProfile) state.selectedProfileId = firstProfile.id;
    if (!state.selectedTaskId && firstTask) state.selectedTaskId = firstTask.id;
    const selectedTask = getSelectedTask();
    const taskFormType = $("#taskForm")?.elements.taskType?.value || "text";
    const editingTask = state.taskEditor.taskId ? (state.data?.tasks || []).find((task) => task.id === state.taskEditor.taskId) : null;

    $$("#taskForm select[name='directory']").forEach((select) => {
        const selected = select.value || state.data?.directories?.[0] || "";
        select.innerHTML = directoryOptions(selected);
    });
    const taskProject = $("#taskProject");
    if (taskProject) {
        const selectedProject = taskProject.value || (editingTask || selectedTask)?.projectId || state.data?.projects?.[0]?.id || "";
        taskProject.innerHTML = projectOptions(selectedProject);
        taskProject.value = selectedProject;
    }
    const projectDirectory = $("#projectForm select[name='directory']");
    if (projectDirectory) {
        const selectedDirectory = projectDirectory.value || "";
        projectDirectory.innerHTML = `<option value="">${escapeHtml(t("project.unbound"))}</option>${directoryOptions(selectedDirectory)}`;
        projectDirectory.value = selectedDirectory;
    }
    $$("select[name='decomposeProfileId']").forEach((select) => {
        select.innerHTML = profileOptions(select.value || state.selectedProfileId, "text");
    });
    $$("select[name='runProfileIds']").forEach((select) => {
        const selected = selectedValues(select);
        const fallback = selected.length ? selected : [state.selectedProfileId].filter(Boolean);
        select.innerHTML = profileOptions(fallback, taskFormType);
    });
    $("#editorTask").innerHTML = taskOptions(state.selectedTaskId || $("#editorTask").value);
    $("#runTask").innerHTML = taskOptions(state.selectedTaskId || $("#runTask").value, true);
    const currentRunProfiles = selectedValues($("#runProfiles"));
    const runProfileIds = currentRunProfiles.length
        ? currentRunProfiles
        : taskProfileIds(selectedTask).length
            ? taskProfileIds(selectedTask)
            : [state.selectedProfileId].filter(Boolean);
    $("#runProfiles").innerHTML = profileOptions(runProfileIds, selectedTask?.taskType || "text");
    $("#decomposeProfile").innerHTML = profileOptions($("#decomposeProfile").value || selectedTask?.decomposeProfileId || state.selectedProfileId, "text");
    syncTaskProjectDirectory();
    syncTaskScheduleControls(selectedTask);
}

function renderProjects() {
    const projects = state.data?.projects || [];
    const node = $("#projectList");
    if (!node) return;
    node.innerHTML = projects.map((project) => `
        <article class="project-card dashboard-project-link" data-open-project="${escapeHtml(project.id)}" tabindex="0" role="button" aria-label="${escapeHtml(t("dashboard.openProject", { name: project.name }))}">
            <div>
                <p class="project-title">${escapeHtml(project.name)}</p>
                <div class="meta">
                    <span>${escapeHtml(project.directory || t("project.unboundLabel"))}</span>
                    <span>${escapeHtml(t("project.taskCount", { count: (project.currentTaskCount || 0) + (project.archivedTaskCount || 0) }))}</span>
                </div>
            </div>
            <div class="task-actions">
                <button class="ghost" type="button" data-edit-project="${escapeHtml(project.id)}">${escapeHtml(t("project.edit"))}</button>
                <button class="ghost" type="button" data-delete-project="${escapeHtml(project.id)}" ${(project.currentTaskCount || 0) + (project.archivedTaskCount || 0) > 0 || projects.length <= 1 ? "disabled" : ""}>${escapeHtml(t("project.delete"))}</button>
            </div>
        </article>
    `).join("");
}

function renderDirectories() {
    const directories = state.data?.directories || [];
    $("#directoryList").innerHTML = directories.map((directory, index) => `
        <div class="directory-item">
            <span>${escapeHtml(directory)}</span>
            <button class="ghost" type="button" data-delete-dir="${encodeURIComponent(directory)}" ${index === 0 ? "disabled" : ""}>${escapeHtml(t("common.remove"))}</button>
        </div>
    `).join("");
}

function taskCanAppend(task) {
    if (!task || task.archived || task.isRunning || task.loopActive) return false;
    return !["queued", "running", "scheduled", "retry_wait"].includes(String(task.status || ""));
}

function taskCanDelete(task) {
    return Boolean(task && task.canDelete !== false && !state.deletingTaskIds.has(task.id)
        && !task.isRunning && !task.loopActive && !task.activeProcess
        && !["queued", "running", "scheduled", "retry_wait"].includes(String(task.status || "")));
}

// 运行页 tab 只列出「已启动」的任务：循环活跃，或处于排队 / 预约 / 等待重试。
function taskIsStarted(task) {
    if (!task || task.archived) return false;
    if (task.loopActive || task.isRunning || task.isAgentRunning) return true;
    return ["queued", "running", "scheduled", "retry_wait"].includes(String(task.status || ""));
}

function renderRuntimeContext(task) {
    const subtitle = $("#runtimeTaskSubtitle");
    const badge = $("#runtimeStatusBadge");
    const appendButton = $("#appendTaskButton");
    const appendItems = $("#appendTaskItems");
    const appendStandard = $("#appendCompletionStandard");
    const eligibility = $("#appendEligibility");
    const archiveButton = $("#archiveTask");
    const deleteButton = $("#deleteTask");
    const runtimeEditor = $("#runtimeFileEditor");
    const runtimeFileHint = $("#runtimeFileHint");
    const runtimeButtons = [$("#startTask"), $("#scheduleTask"), $("#decomposeTask"), $("#stopTask")].filter(Boolean);
    if (!task) {
        if (subtitle) subtitle.textContent = t("runtime.noTask");
        if (badge) {
            badge.className = "badge loop_not_started";
            badge.textContent = "-";
        }
        if (appendButton) appendButton.disabled = true;
        if (appendItems) appendItems.disabled = true;
        if (appendStandard) appendStandard.disabled = true;
        if (eligibility) {
            eligibility.className = "append-eligibility unavailable";
            eligibility.textContent = t("runtime.appendUnavailable");
        }
        if (archiveButton) archiveButton.disabled = true;
        if (deleteButton) deleteButton.disabled = true;
        if (runtimeEditor) runtimeEditor.disabled = true;
        if (runtimeFileHint) runtimeFileHint.textContent = t("editor.noTask");
        runtimeButtons.forEach((button) => { button.disabled = true; });
        return;
    }

    if (subtitle) subtitle.textContent = `${task.targetFileName || task.title} · ${task.directory || "-"}`;
    if (badge) {
        badge.className = `badge ${taskRuntimeState(task)}`;
        badge.textContent = taskDisplayStatus(task);
    }
    const archived = task.archived === true;
    const busy = task.isRunning || task.loopActive || ["queued", "running", "scheduled", "retry_wait"].includes(String(task.status || ""));
    if (archiveButton) archiveButton.disabled = archived || busy;
    if (deleteButton) {
        deleteButton.disabled = !taskCanDelete(task);
        deleteButton.title = taskCanDelete(task) ? "" : t("task.deleteBusy");
    }
    if (runtimeEditor) runtimeEditor.disabled = archived;
    if (runtimeFileHint) runtimeFileHint.textContent = archived ? t("runtime.fileArchived") : t("runtime.fileEditable");
    if (runtimeButtons[0]) runtimeButtons[0].disabled = archived || busy;
    if (runtimeButtons[1]) runtimeButtons[1].disabled = archived || busy;
    if (runtimeButtons[2]) runtimeButtons[2].disabled = archived || busy;
    if (runtimeButtons[3]) runtimeButtons[3].disabled = archived || !busy;
    const canAppend = taskCanAppend(task);
    if (appendButton) appendButton.disabled = !canAppend;
    if (appendItems) appendItems.disabled = !canAppend;
    if (appendStandard) appendStandard.disabled = !canAppend;
    if (eligibility) {
        eligibility.className = `append-eligibility ${canAppend ? "available" : "unavailable"}`;
        eligibility.textContent = canAppend ? t("runtime.appendAvailable") : t("runtime.appendBusy");
    }
}

// ---- 运行统计：token / 轮次 / 间隔 / 费用 与时间轴曲线 ----
// 图表为内联 SVG，无依赖。配色经 dataviz 校验：输入 #2b5fa3、输出 #c47a13；成功 / 失败沿用状态色并配图标与文字。
const STATS_SERIES_COLORS = { input: "#2b5fa3", output: "#c47a13", cost: "#0f7d5c", success: "#0f7d5c", failure: "#ba2d2d" };

function formatTokens(value) {
    const count = Number(value) || 0;
    if (count >= 1e6) return `${(count / 1e6).toFixed(2)}M`;
    if (count >= 1e3) return `${(count / 1e3).toFixed(1)}K`;
    return String(count);
}

function formatUsd(value) {
    const amount = Number(value) || 0;
    return amount >= 1 ? `$${amount.toFixed(2)}` : `$${amount.toFixed(4)}`;
}

function formatDurationMs(value) {
    const ms = Number(value);
    if (!Number.isFinite(ms) || ms < 0) return "-";
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
}

function formatClock(value) {
    try {
        return new Intl.DateTimeFormat(i18n.getLocale(), { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
    } catch {
        return "";
    }
}

function statsTimeAxis(cycles) {
    const starts = cycles.map((cycle) => new Date(cycle.startedAt).getTime()).filter(Number.isFinite);
    const ends = cycles.map((cycle) => new Date(cycle.endedAt || cycle.startedAt).getTime()).filter(Number.isFinite);
    const min = Math.min(...starts);
    const max = Math.max(...ends, ...starts);
    return { min, max: max > min ? max : min + 60000 };
}

function svgPath(points) {
    return points.map((point, index) => `${index === 0 ? "M" : "L"}${point[0].toFixed(1)} ${point[1].toFixed(1)}`).join(" ");
}

// 折线图：series = [{ key, label, color, points: [[timeMs, value]] }]，单一 y 轴。
function renderStatsLineChart({ title, series, axis, formatValue, unit = "" }) {
    const width = 520;
    const height = 170;
    const pad = { top: 18, right: 14, bottom: 26, left: 54 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const maxValue = Math.max(1e-9, ...series.flatMap((item) => item.points.map((point) => point[1])));
    const x = (time) => pad.left + ((time - axis.min) / (axis.max - axis.min)) * plotW;
    const y = (value) => pad.top + plotH - (value / maxValue) * plotH;
    const gridLines = [0, 0.5, 1].map((ratio) => {
        const value = maxValue * ratio;
        return `<line x1="${pad.left}" x2="${width - pad.right}" y1="${y(value).toFixed(1)}" y2="${y(value).toFixed(1)}" class="stats-grid"></line>
            <text x="${pad.left - 6}" y="${(y(value) + 4).toFixed(1)}" class="stats-axis-label" text-anchor="end">${escapeHtml(formatValue(value))}</text>`;
    }).join("");
    const ticks = [axis.min, (axis.min + axis.max) / 2, axis.max].map((time, index) => `
        <text x="${x(time).toFixed(1)}" y="${height - 8}" class="stats-axis-label" text-anchor="${index === 0 ? "start" : index === 2 ? "end" : "middle"}">${escapeHtml(formatClock(time))}</text>`).join("");
    const lines = series.map((item) => {
        const last = item.points[item.points.length - 1];
        return `
        <path d="${svgPath(item.points.map((point) => [x(point[0]), y(point[1])]))}" fill="none" stroke="${item.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></path>
        ${item.points.map((point) => `<circle cx="${x(point[0]).toFixed(1)}" cy="${y(point[1]).toFixed(1)}" r="3" fill="${item.color}" stroke="var(--panel)" stroke-width="2"><title>${escapeHtml(`${item.label} · ${formatClock(point[0])} · ${formatValue(point[1])}${unit}`)}</title></circle>`).join("")}
        ${last ? `<text x="${Math.min(x(last[0]) + 6, width - pad.right).toFixed(1)}" y="${(y(last[1]) - 6).toFixed(1)}" class="stats-series-label" text-anchor="end">${escapeHtml(`${item.label} ${formatValue(last[1])}${unit}`)}</text>` : ""}`;
    }).join("");
    const legend = series.length > 1
        ? `<div class="stats-legend">${series.map((item) => `<span><i style="background:${item.color}"></i>${escapeHtml(item.label)}</span>`).join("")}</div>`
        : "";
    return `
        <figure class="stats-chart">
            <figcaption>${escapeHtml(title)}</figcaption>
            <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}" preserveAspectRatio="none">
                ${gridLines}${ticks}${lines}
            </svg>
            ${legend}
        </figure>`;
}

// 每轮结果图：按时间轴放置每轮的耗时柱，成功为绿柱加 ✓，失败为红柱加 ✕。
function renderStatsCycleChart({ title, cycles, axis }) {
    const width = 520;
    const height = 150;
    const pad = { top: 18, right: 14, bottom: 26, left: 54 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const maxDuration = Math.max(1000, ...cycles.map((cycle) => Number(cycle.durationMs) || 0));
    const x = (time) => pad.left + ((time - axis.min) / (axis.max - axis.min)) * plotW;
    const barWidth = Math.max(4, Math.min(14, plotW / Math.max(1, cycles.length) - 2));
    const bars = cycles.map((cycle) => {
        const start = new Date(cycle.startedAt).getTime();
        const duration = Number(cycle.durationMs) || 0;
        const barHeight = Math.max(3, (duration / maxDuration) * plotH);
        const left = Math.min(x(start), width - pad.right - barWidth);
        const top = pad.top + plotH - barHeight;
        const color = cycle.success ? STATS_SERIES_COLORS.success : STATS_SERIES_COLORS.failure;
        const label = `${t("stats.cycle", { index: cycle.cycle })} · ${cycle.success ? t("stats.success") : t("stats.failure")} · ${formatDurationMs(duration)} · ${t("stats.reason")}: ${cycle.reason || "-"} · in ${formatTokens(cycle.inputTokens)} / out ${formatTokens(cycle.outputTokens)} · ${formatUsd(cycle.costUsd)}`;
        return `
        <g>
            <rect x="${left.toFixed(1)}" y="${top.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="2" fill="${color}"><title>${escapeHtml(label)}</title></rect>
            <text x="${(left + barWidth / 2).toFixed(1)}" y="${Math.max(12, top - 4).toFixed(1)}" class="stats-mark" text-anchor="middle" fill="${color}">${cycle.success ? "✓" : "✕"}</text>
        </g>`;
    }).join("");
    const gridLines = [0, 1].map((ratio) => {
        const value = maxDuration * ratio;
        const yPos = pad.top + plotH - ratio * plotH;
        return `<line x1="${pad.left}" x2="${width - pad.right}" y1="${yPos.toFixed(1)}" y2="${yPos.toFixed(1)}" class="stats-grid"></line>
            <text x="${pad.left - 6}" y="${(yPos + 4).toFixed(1)}" class="stats-axis-label" text-anchor="end">${escapeHtml(formatDurationMs(value))}</text>`;
    }).join("");
    const ticks = [axis.min, (axis.min + axis.max) / 2, axis.max].map((time, index) => `
        <text x="${x(time).toFixed(1)}" y="${height - 8}" class="stats-axis-label" text-anchor="${index === 0 ? "start" : index === 2 ? "end" : "middle"}">${escapeHtml(formatClock(time))}</text>`).join("");
    return `
        <figure class="stats-chart">
            <figcaption>${escapeHtml(title)}</figcaption>
            <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}" preserveAspectRatio="none">
                ${gridLines}${ticks}${bars}
            </svg>
            <div class="stats-legend">
                <span><i style="background:${STATS_SERIES_COLORS.success}"></i>✓ ${escapeHtml(t("stats.success"))}</span>
                <span><i style="background:${STATS_SERIES_COLORS.failure}"></i>✕ ${escapeHtml(t("stats.failure"))}</span>
            </div>
        </figure>`;
}

function renderTaskStats(task, { heading = "" } = {}) {
    const stats = task?.stats;
    const cycles = Array.isArray(task?.cycles) ? task.cycles.filter((cycle) => cycle && cycle.startedAt) : [];
    if (!task || !stats || !stats.cycles) {
        return `<div class="stats-empty">${escapeHtml(t("stats.empty"))}</div>`;
    }
    const tiles = [
        [t("stats.cycles"), `${stats.cycles}`, t("stats.cyclesCaption", { success: stats.successes, failure: stats.failures })],
        [t("stats.inputTokens"), formatTokens(stats.inputTokens), t("stats.cacheCaption", { write: formatTokens(stats.cacheCreationTokens), read: formatTokens(stats.cacheReadTokens) })],
        [t("stats.outputTokens"), formatTokens(stats.outputTokens), t("stats.totalTokens", { total: formatTokens(stats.totalTokens) })],
        [t("stats.averageInterval"), stats.averageIntervalMs === null ? "-" : formatDurationMs(stats.averageIntervalMs), t("stats.averageDuration", { value: formatDurationMs(stats.averageDurationMs) })],
        [t("stats.elapsed"), formatDurationMs(stats.elapsedMs), t("stats.elapsedCaption", { start: formatTime(stats.firstStartedAt), end: formatTime(stats.lastEndedAt) })],
        [t("stats.cost"), formatUsd(stats.costUsd), t("stats.costCaption", { model: stats.pricing?.model || "claude-fable-5-1" })],
    ].map(([label, value, caption]) => `
        <div class="stats-tile">
            <span>${escapeHtml(label)}</span>
            <b>${escapeHtml(value)}</b>
            <span>${escapeHtml(caption)}</span>
        </div>`).join("");
    let charts = "";
    if (cycles.length) {
        const axis = statsTimeAxis(cycles);
        let cost = 0;
        let input = 0;
        let output = 0;
        const costPoints = [];
        const inputPoints = [];
        const outputPoints = [];
        for (const cycle of cycles) {
            const time = new Date(cycle.endedAt || cycle.startedAt).getTime();
            cost += Number(cycle.costUsd) || 0;
            input += Number(cycle.inputTokens) || 0;
            output += Number(cycle.outputTokens) || 0;
            costPoints.push([time, cost]);
            inputPoints.push([time, input]);
            outputPoints.push([time, output]);
        }
        charts = `
            <div class="stats-charts">
                ${renderStatsLineChart({ title: t("stats.chart.cost"), axis, formatValue: formatUsd, series: [{ key: "cost", label: t("stats.cost"), color: STATS_SERIES_COLORS.cost, points: costPoints }] })}
                ${renderStatsLineChart({ title: t("stats.chart.tokens"), axis, formatValue: formatTokens, series: [
                    { key: "input", label: t("stats.inputTokens"), color: STATS_SERIES_COLORS.input, points: inputPoints },
                    { key: "output", label: t("stats.outputTokens"), color: STATS_SERIES_COLORS.output, points: outputPoints },
                ] })}
                ${renderStatsCycleChart({ title: t("stats.chart.cycles"), cycles, axis })}
            </div>`;
    }
    const unparsed = cycles.filter((cycle) => cycle.usageFound === false).length;
    const note = unparsed ? `<p class="stats-note">${escapeHtml(t("stats.unparsedNote", { count: unparsed }))}</p>` : "";
    return `
        ${heading ? `<div class="stats-head"><strong>${escapeHtml(heading)}</strong><span class="hint">${escapeHtml(t("stats.pricingHint"))}</span></div>` : ""}
        <div class="stats-tiles">${tiles}</div>
        ${charts}
        ${note}`;
}

// 总览：列出当前活动任务（Agent 运行中 / 循环等待中）的统计；没有活动任务时展示最近一次运行的任务。
function renderDashboardStats() {
    const node = $("#dashboardStats");
    if (!node) return;
    const tasks = (state.data?.tasks || []).filter((task) => !task.archived);
    const active = tasks.filter((task) => task.isRunning || ["running", "retry_wait", "completed"].includes(String(task.status || "")) && task.loopActive);
    const shown = active.length ? active : tasks.filter((task) => task.stats?.cycles).sort((a, b) => String(b.lastRunAt || "").localeCompare(String(a.lastRunAt || ""))).slice(0, 1);
    if (!shown.length) {
        node.innerHTML = `<div class="stats-empty">${escapeHtml(t("stats.noActiveTask"))}</div>`;
        return;
    }
    node.innerHTML = shown.map((task) => `
        <section class="stats-block" data-open-task="${escapeHtml(task.id)}">
            ${renderTaskStats(task, { heading: `${task.title} · ${taskDisplayStatus(task)}` })}
        </section>`).join("");
}

function renderRunDetail() {
    const task = getSelectedTask();
    renderRuntimeContext(task);
    if ($("#runtimeStats")) $("#runtimeStats").innerHTML = renderTaskStats(task);
    if (!task) {
        $("#runDetail").innerHTML = `<div class="empty">${escapeHtml(t("empty.noTaskSelected"))}</div>`;
        return;
    }
    const processInfo = task.activeProcess || null;
    const processRows = processInfo
        ? [
            [t("detail.agentProcess"), processSummary(processInfo)],
            [t("detail.processStarted"), formatTime(processInfo.startedAt)],
            [t("detail.processOutput"), processInfo.lastOutputAt ? `${formatTime(processInfo.lastOutputAt)} · ${processInfo.outputChunks || 0} chunks` : "-"],
            [t("detail.processDirectory"), processInfo.cwd || "-"],
            [t("detail.processCommand"), processInfo.commandSummary || "-", "block"],
        ]
        : [[t("detail.agentProcess"), "-"]];
    const taskType = task.taskType || "text";
    const artifacts = Array.isArray(task.artifacts) ? task.artifacts : [];
    const rows = [
        [t("detail.runtimeStatus"), taskDisplayStatus(task)],
        [t("detail.taskResult"), statusLabel(task.status)],
        [t("task.project"), (state.data?.projects || []).find((project) => project.id === task.projectId)?.name || "-"],
        ...(task.queuePosition ? [[t("runtime.queueWaiting"), t("runtime.queuePosition", { position: task.queuePosition })]] : []),
        [t("detail.taskType"), modalityLabel(taskType)],
        [t("detail.scheduleMode"), scheduleModeLabel(task.scheduleMode)],
        [t("detail.scheduledStart"), formatTime(task.scheduledStartAt)],
        [t("detail.availabilityChecked"), formatTime(task.availabilityLastCheckedAt)],
        [t("detail.currentProfile"), findProfileName(task.runProfileId)],
        [t("detail.profileList"), profileNames(taskProfileIds(task))],
        [t("detail.lastAgent"), task.lastProfileName
            ? [task.lastProfileName, task.lastProfileProvider || task.lastProfileAgentType, task.lastProfileModelName].filter(Boolean).join(" · ")
            : "-"],
        ...processRows,
        [t("detail.workingDirectory"), task.directory],
        [t("detail.taskFile"), task.filePath],
        ...(task.archived ? [[t("task.archive"), task.archiveDirectory || "-"]] : []),
        ...(taskType === "text" ? [] : [
            [t("detail.artifactDirectory"), task.artifactDirectory || "-"],
            [t("detail.outputTarget"), [task.outputFileName, task.resolution, task.aspectRatio].filter(Boolean).join(" · ") || "-"],
        ]),
        [t("detail.lastStarted"), formatTime(task.lastRunAt)],
        [t("detail.lastOutput"), formatTime(task.lastOutputAt)],
        [t(task.status === "scheduled" && task.scheduleMode === "profile_available"
            ? "detail.nextAvailabilityCheck"
            : "detail.nextRun"), formatTime(task.runtimeNextRunAt || task.nextRunAt)],
        [t("detail.exitCode"), task.lastExitCode ?? "-"],
        [t("detail.outputStats"), `${task.lastOutputChunks || 0} chunks / stdout ${task.lastStdoutBytes || 0} bytes / stderr ${task.lastStderrBytes || 0} bytes`],
        [t("detail.lastCommand"), task.lastCommand || "-", "block"],
        [t("detail.lastPrompt"), task.lastPrompt || "-", "block"],
        [t("detail.outputTail"), task.lastOutput || "-", "block"],
    ];
    const artifactSection = taskType === "text" ? "" : `
        <section class="artifact-section">
            <div class="artifact-section-head">
                <strong>${escapeHtml(t("artifact.heading"))}</strong>
                <span class="hint">${escapeHtml(t("artifact.count", { count: artifacts.length }))}</span>
            </div>
            <div class="artifact-gallery">
                ${artifacts.map((artifact) => `
                    <article class="artifact-card">
                        ${artifact.mediaType === "video"
                            ? `<video controls preload="metadata" src="${escapeHtml(artifact.url)}"></video>`
                            : `<img loading="lazy" src="${escapeHtml(artifact.url)}" alt="${escapeHtml(artifact.name)}">`}
                        <div class="artifact-caption">
                            <a href="${escapeHtml(artifact.url)}" target="_blank" rel="noopener">${escapeHtml(artifact.relativePath || artifact.name)}</a>
                            <span>${escapeHtml(formatBytes(artifact.size))} · ${escapeHtml(formatTime(artifact.mtime))}</span>
                        </div>
                    </article>
                `).join("") || `<div class="empty">${escapeHtml(t("artifact.empty"))}</div>`}
            </div>
        </section>
    `;
    $("#runDetail").innerHTML = rows.map(([label, value, kind]) => `
        <div class="detail-row ${kind === "block" ? "detail-row-block" : ""}">
            <span>${label}</span>
            ${kind === "block" ? `<pre class="detail-pre">${escapeHtml(value)}</pre>` : `<span>${escapeHtml(value)}</span>`}
        </div>
    `).join("") + artifactSection;
}

function renderRuntimeTabs() {
    const bar = $("#runtimeTabsBar");
    const node = $("#runtimeTabs");
    if (!bar || !node) return;
    const tasks = (state.data?.tasks || []).filter(taskIsStarted);
    bar.hidden = tasks.length === 0;
    const signature = `${state.selectedTaskId}#${tasks
        .map((task) => `${task.id}:${taskRuntimeState(task)}:${taskDisplayStatus(task)}`)
        .join("|")}`;
    if (signature === state.runtimeTabsSignature) return;
    state.runtimeTabsSignature = signature;
    node.innerHTML = tasks.map((task) => {
        const active = task.id === state.selectedTaskId;
        return `
        <button class="runtime-tab${active ? " active" : ""}" type="button" role="tab" data-runtime-tab="${escapeHtml(task.id)}" data-runtime-state="${escapeHtml(taskRuntimeState(task))}" aria-selected="${active ? "true" : "false"}" aria-label="${escapeHtml(t("runtime.tabsSwitch", { name: task.title }))}">
            <span class="runtime-tab-title">${escapeHtml(task.title)}</span>
            <span class="runtime-tab-state">${escapeHtml(taskDisplayStatus(task))}</span>
        </button>`;
    }).join("");
}

// tab 点击与「任务」下拉框共用同一套切换动作，保证控制面板、目标文件与日志同步。
async function selectRuntimeTask(taskId) {
    const task = (state.data?.tasks || []).find((item) => item.id === taskId);
    if (!task) return;
    state.selectedTaskId = taskId;
    const runProfileIds = taskProfileIds(task);
    if ($("#runTask")) $("#runTask").value = taskId;
    $("#runProfiles").innerHTML = profileOptions(runProfileIds.length ? runProfileIds : [state.selectedProfileId].filter(Boolean), task.taskType || "text");
    $("#decomposeProfile").innerHTML = profileOptions(task.decomposeProfileId || state.selectedProfileId, "text");
    syncTaskScheduleControls(task, true);
    renderRunDetail();
    renderRuntimeTabs();
    $("#appendTaskFeedback").textContent = "";
    try {
        await loadFile(taskId);
        await loadLog(taskId, { forceFollow: true });
    } catch (error) {
        toast(error.message);
    }
}

function renderAll() {
    renderMetrics();
    renderDashboardStats();
    renderTasks();
    renderEvents();
    renderProfiles();
    if (state.activeView === "pings") renderPings();
    renderSelectors();
    renderRuntimeTabs();
    renderProjects();
    renderDirectories();
    if (state.activeView === "runtime") renderRunDetail();
}

async function refresh({ replacementTaskId = "" } = {}) {
    const requestId = ++state.refreshRequestId;
    const incoming = await api(`/api/state?compact=1${state.activeView === "pings" ? "&includePings=1" : ""}`, { conditional: true });
    if (requestId !== state.refreshRequestId) return;
    const data = incoming || state.data;
    if (!data) return;
    const replacementExists = replacementTaskId && (data.tasks || []).some((task) => task.id === replacementTaskId);
    const selectionRemoved = (state.selectedTaskId && !(data.tasks || []).some((task) => task.id === state.selectedTaskId))
        || (replacementExists && state.selectedTaskId !== replacementTaskId);
    if (!incoming && !selectionRemoved) return;
    state.data = { ...state.data, ...data };
    if (selectionRemoved) {
        state.selectedTaskId = replacementExists ? replacementTaskId : "";
        state.scheduleTaskId = "";
        state.fileRequestId += 1;
        for (const selector of ["#fileEditor", "#runtimeFileEditor", "#appendTaskItems", "#appendCompletionStandard"]) {
            if ($(selector)) $(selector).value = "";
        }
        for (const selector of ["#editorPath", "#runtimeEditorPath"]) {
            if ($(selector)) $(selector).textContent = t("editor.noTask");
        }
        $("#runProfiles").innerHTML = "";
        await loadLog("");
    }
    if (state.taskEditor?.taskId) syncTaskEditorWithState();
    renderAll();
    if (selectionRemoved && state.selectedTaskId) {
        await loadFile(state.selectedTaskId);
        if (state.activeView === "runtime" && state.selectedTaskId) {
            await loadLog(state.selectedTaskId, { runId: "", forceFollow: true });
        }
    }
}

function updateTokenPlaceholder(profile = null) {
    const input = $("#profileForm").elements.apiToken;
    input.placeholder = profile?.apiTokenConfigured
        ? t("profile.tokenConfiguredPlaceholder", { token: profile.apiTokenPreview || "Token" })
        : t("profile.tokenEmptyPlaceholder");
}

function setProfilePingStatus(message = "", kind = "") {
    const node = $("#profilePingStatus");
    if (!node) return;
    node.className = `profile-ping-status${kind ? ` profile-ping-${kind}` : ""}`;
    node.textContent = message;
}

function setCheckedValues(form, name, values) {
    const selected = new Set(Array.isArray(values) && values.length ? values : ["text"]);
    $$(`input[name='${name}']`, form).forEach((input) => {
        input.checked = selected.has(input.value);
    });
}

function resetProfileForm(profile = null) {
    const form = $("#profileForm");
    form.reset();
    form.elements.id.value = profile?.id || "";
    form.elements.name.value = profile?.name || "";
    form.elements.agentType.value = profile?.agentType || "claude";
    form.elements.provider.value = profile?.provider || (profile?.agentType === "codex" ? "openai" : profile?.agentType === "gemini" ? "google" : "anthropic");
    form.elements.command.value = profile?.command || "claude";
    form.elements.args.value = profile?.args || "-p {prompt}";
    form.elements.baseUrl.value = profile?.baseUrl || "";
    form.elements.apiToken.value = "";
    updateTokenPlaceholder(profile);
    form.elements.modelName.value = profile?.modelName || "";
    form.elements.pingIntervalMinutes.value = profile?.pingIntervalMinutes || 60;
    form.elements.defaultDirectory.value = profile ? profile.defaultDirectory || "" : "default_work_dir";
    form.elements.configDirectory.value = profile?.configDirectory || "";
    form.elements.envText.value = profile?.envText || "";
    form.elements.promptTemplate.value = profile?.promptTemplate || "";
    form.elements.mediaPromptTemplate.value = profile?.mediaPromptTemplate || "";
    form.elements.timeoutSeconds.value = profile?.timeoutSeconds || 7200;
    form.elements.enabled.checked = profile?.enabled !== false;
    form.elements.nonInteractive.checked = profile?.nonInteractive !== false;
    form.elements.pingEnabled.checked = profile?.pingEnabled === true;
    setCheckedValues(form, "inputModalities", profile?.inputModalities || ["text"]);
    setCheckedValues(form, "outputModalities", profile?.outputModalities || ["text"]);
    const pingButton = $("#pingProfile");
    if (pingButton) pingButton.disabled = !profile?.id;
    setProfilePingStatus();
    state.selectedProfileId = profile?.id || "";
}

function syncTaskSourceMode() {
    const form = $("#taskForm");
    const mode = form.elements.sourceMode.value || "agent";
    const isAgent = mode === "agent";
    const isUpload = mode === "upload";
    const sourceHelp = {
        agent: t("task.sourceHelp.agent"),
        existing: t("task.sourceHelp.existing"),
        upload: t("task.sourceHelp.upload"),
    };
    $$(".task-generation-field").forEach((node) => {
        node.hidden = !isAgent;
    });
    $$(".task-upload-field").forEach((node) => {
        node.hidden = !isUpload;
    });
    form.elements.requirement.required = isAgent;
    form.elements.decomposeProfileId.required = isAgent;
    form.elements.sourceFile.required = isUpload;
    $("#taskSubmitButton").textContent = isAgent
        ? t("task.submit.generate")
        : isUpload
            ? t("task.submit.import")
            : t("task.submit.load");
    $("#taskSourceHelp").textContent = sourceHelp[mode] || sourceHelp.agent;
}

function syncTaskType() {
    const form = $("#taskForm");
    if (!form) return;
    const taskType = form.elements.taskType.value || "text";
    const mediaSettings = $("#mediaTaskSettings");
    mediaSettings.hidden = taskType === "text";
    $$(".video-only", mediaSettings).forEach((node) => {
        node.hidden = taskType !== "video";
    });

    const formatSelect = form.elements.outputFormat;
    const formats = MEDIA_FORMAT_OPTIONS[taskType] || [];
    const previousFormat = formatSelect.value;
    formatSelect.innerHTML = formats.map((format) => `<option value="${format}">${format.toUpperCase()}</option>`).join("");
    if (formats.includes(previousFormat)) formatSelect.value = previousFormat;

    const previousType = form.dataset.taskType || "text";
    const outputFileInput = form.elements.outputFileName;
    if (taskType !== "text" && (previousType !== taskType || !outputFileInput.value.trim())) {
        const canReplace = !outputFileInput.value.trim() || /^result\.[a-z0-9]+$/i.test(outputFileInput.value.trim());
        if (canReplace) outputFileInput.value = `result.${formats[0] || "bin"}`;
    }
    form.dataset.taskType = taskType;

    const runSelect = form.elements.runProfileIds;
    const selected = selectedValues(runSelect);
    runSelect.innerHTML = profileOptions(selected, taskType);
}

const TASK_EDITOR_LOCKED_FIELDS = ["taskType", "targetFileName", "directory", "sourceMode", "sourceFile", "overwrite"];
const TASK_EDITOR_AUTOSAVE_DELAY_MS = 600;

function taskEditorCanEdit(task) {
    return Boolean(task && !task.archived && taskCanDelete(task));
}

function setTaskEditorStatus(text = "", kind = "") {
    const node = $("#taskEditorStatus");
    if (!node) return;
    node.textContent = text;
    node.className = `hint task-editor-status${kind ? ` is-${kind}` : ""}`;
}

function renderTaskEditorStatus() {
    const editor = state.taskEditor;
    const task = editor.taskId ? (state.data?.tasks || []).find((item) => item.id === editor.taskId) : null;
    if (!task) {
        setTaskEditorStatus(t("task.editor.creating"));
        return;
    }
    if (task.archived) return setTaskEditorStatus(t("task.editor.readonlyArchived"));
    if (!taskEditorCanEdit(task)) return setTaskEditorStatus(t("task.editor.readonlyBusy"));
    if (editor.error) return setTaskEditorStatus(t("task.editor.saveFailed", { error: editor.error }), "error");
    if (editor.saving || editor.dirty) return setTaskEditorStatus(t("task.editor.saving"), "saving");
    if (editor.lastSavedAt) return setTaskEditorStatus(t("task.editor.saved", { time: formatTime(editor.lastSavedAt) }));
    setTaskEditorStatus(t("task.editor.autosave"));
}

function setTaskEditorLocked(form, locked) {
    for (const name of TASK_EDITOR_LOCKED_FIELDS) {
        const field = form.elements[name];
        if (!field) continue;
        if (field.tagName === "SELECT" || field.type === "checkbox" || field.type === "file") field.disabled = locked;
        else field.readOnly = locked;
    }
}

function setTaskEditorReadonly(form, readonly) {
    for (const field of Array.from(form.elements)) {
        if (!field.name || TASK_EDITOR_LOCKED_FIELDS.includes(field.name) || field.name === "taskId") continue;
        if (field.tagName === "SELECT") field.disabled = readonly;
        else if (field.tagName === "INPUT" || field.tagName === "TEXTAREA") field.readOnly = readonly;
    }
}

function fillTaskEditor(task) {
    const form = $("#taskForm");
    form.elements.title.value = task.title || "";
    form.elements.taskType.value = task.taskType || "text";
    form.elements.targetFileName.value = task.targetFileName || "";
    form.elements.projectId.innerHTML = projectOptions(task.projectId || "");
    form.elements.projectId.value = task.projectId || "";
    form.elements.directory.innerHTML = directoryOptions(task.directory || "");
    form.elements.directory.value = task.directory || "";
    form.elements.sourceMode.value = task.sourceMode === "template" ? "existing" : (task.sourceMode || "agent");
    form.elements.decomposeProfileId.innerHTML = profileOptions(task.decomposeProfileId || "", "text");
    form.elements.runProfileIds.innerHTML = profileOptions(taskProfileIds(task), task.taskType || "text");
    form.elements.requirement.value = task.requirement || "";
    form.elements.artifactDirectoryName.value = task.artifactDirectoryName || "";
    form.elements.outputFileName.value = task.outputFileName || "";
    form.elements.aspectRatio.value = task.aspectRatio || "";
    form.elements.resolution.value = task.resolution || "";
    form.elements.durationSeconds.value = task.durationSeconds || 5;
    form.elements.referenceFiles.value = Array.isArray(task.referenceFiles) ? task.referenceFiles.join("\n") : "";
    form.dataset.taskType = task.taskType || "text";
    syncTaskType();
    if (task.outputFormat) form.elements.outputFormat.value = task.outputFormat;
    syncTaskSourceMode();
}

function openTaskEditor(taskId) {
    const task = (state.data?.tasks || []).find((item) => item.id === taskId);
    const form = $("#taskForm");
    if (!task || !form) return false;
    flushTaskAutosave();
    state.taskEditor = { taskId, timer: null, saving: false, dirty: false, lastSavedAt: null, error: "" };
    state.selectedTaskId = taskId;
    form.dataset.mode = "edit";
    form.elements.taskId.value = taskId;
    fillTaskEditor(task);
    setTaskEditorLocked(form, true);
    setTaskEditorReadonly(form, !taskEditorCanEdit(task));
    const title = $("#taskEditorTitle");
    title.dataset.i18n = "task.edit";
    title.textContent = t("task.editor.selected", { name: task.title });
    const notice = $("#taskEditorNotice");
    notice.hidden = false;
    notice.textContent = t("task.editor.lockedFields");
    $("#taskOpenRuntime").hidden = false;
    renderTaskEditorStatus();
    renderTasks();
    return true;
}

function resetTaskEditor() {
    const form = $("#taskForm");
    if (!form) return;
    flushTaskAutosave();
    state.taskEditor = { taskId: "", timer: null, saving: false, dirty: false, lastSavedAt: null, error: "" };
    form.dataset.mode = "create";
    form.reset();
    form.elements.taskId.value = "";
    setTaskEditorLocked(form, false);
    setTaskEditorReadonly(form, false);
    const title = $("#taskEditorTitle");
    title.dataset.i18n = "task.create";
    title.textContent = t("task.create");
    $("#taskEditorNotice").hidden = true;
    $("#taskOpenRuntime").hidden = true;
    renderSelectors();
    syncTaskType();
    syncTaskSourceMode();
    renderTaskEditorStatus();
    renderTasks();
}

function taskEditorPayload(form) {
    const taskType = form.dataset.taskType || form.elements.taskType.value || "text";
    const payload = {
        title: form.elements.title.value,
        requirement: form.elements.requirement.value,
        projectId: form.elements.projectId.value || "",
        decomposeProfileId: form.elements.decomposeProfileId.value || "",
        runProfileIds: selectedValues(form.elements.runProfileIds),
    };
    if (taskType !== "text") {
        Object.assign(payload, {
            artifactDirectoryName: form.elements.artifactDirectoryName.value,
            outputFileName: form.elements.outputFileName.value,
            outputFormat: form.elements.outputFormat.value,
            aspectRatio: form.elements.aspectRatio.value,
            resolution: form.elements.resolution.value,
            durationSeconds: form.elements.durationSeconds.value,
            referenceFiles: form.elements.referenceFiles.value,
        });
    }
    return payload;
}

function scheduleTaskAutosave() {
    const editor = state.taskEditor;
    if (!editor.taskId) return;
    editor.dirty = true;
    editor.error = "";
    clearTimeout(editor.timer);
    editor.timer = setTimeout(() => {
        editor.timer = null;
        saveTaskEditor().catch(() => {});
    }, TASK_EDITOR_AUTOSAVE_DELAY_MS);
    renderTaskEditorStatus();
}

function flushTaskAutosave() {
    const editor = state.taskEditor;
    if (!editor.taskId || !editor.timer) return;
    clearTimeout(editor.timer);
    editor.timer = null;
    saveTaskEditor().catch(() => {});
}

async function saveTaskEditor() {
    const editor = state.taskEditor;
    const form = $("#taskForm");
    const taskId = editor.taskId;
    if (!taskId || !form || form.dataset.mode !== "edit") return;
    if (editor.saving) {
        editor.dirty = true;
        return;
    }
    editor.saving = true;
    editor.dirty = false;
    renderTaskEditorStatus();
    try {
        const result = await api(`/api/tasks/${encodeURIComponent(taskId)}`, { method: "PATCH", body: taskEditorPayload(form) });
        if (state.taskEditor.taskId !== taskId) return;
        editor.lastSavedAt = new Date().toISOString();
        editor.error = "";
        if (result.changed?.length) {
            $("#taskEditorTitle").textContent = t("task.editor.selected", { name: result.task.title });
            await refresh();
        }
    } catch (error) {
        if (state.taskEditor.taskId === taskId) editor.error = error.message;
    } finally {
        if (state.taskEditor.taskId === taskId) {
            editor.saving = false;
            renderTaskEditorStatus();
            if (editor.dirty) scheduleTaskAutosave();
        }
    }
}

// 轮询刷新后：被删除的任务退出编辑；运行状态变化时切换只读。
function syncTaskEditorWithState() {
    const taskId = state.taskEditor.taskId;
    const editingTask = (state.data?.tasks || []).find((task) => task.id === taskId);
    if (!editingTask) {
        resetTaskEditor();
        return;
    }
    setTaskEditorReadonly($("#taskForm"), !taskEditorCanEdit(editingTask));
    renderTaskEditorStatus();
}

function applySelectedTaskFile(file) {
    if (!file) return;
    const form = $("#taskForm");
    if (!form.elements.targetFileName.value.trim()) {
        form.elements.targetFileName.value = file.name;
    }
    if (!form.elements.title.value.trim()) {
        form.elements.title.value = file.name.replace(/\.[^.]+$/, "") || file.name;
    }
}

async function loadFile(taskId) {
    const task = (state.data?.tasks || []).find((item) => item.id === taskId);
    if (!task) return;
    const requestId = ++state.fileRequestId;
    const result = await api(`/api/tasks/${encodeURIComponent(taskId)}/file`);
    if (requestId !== state.fileRequestId || !(state.data?.tasks || []).some((item) => item.id === taskId)) return;
    $("#fileEditor").value = result.content;
    $("#editorPath").textContent = result.filePath;
    if ($("#runtimeFileEditor")) $("#runtimeFileEditor").value = result.content;
    if ($("#runtimeEditorPath")) $("#runtimeEditorPath").textContent = result.filePath;
    state.selectedTaskId = taskId;
    $("#editorTask").value = taskId;
    $("#runTask").value = taskId;
}

async function deleteTask(taskId) {
    const task = (state.data?.tasks || []).find((item) => item.id === taskId);
    if (!task) return;
    if (!taskCanDelete(task)) return toast(t("task.deleteBusy"));
    if (!window.confirm(t("task.deleteConfirm", { name: task.title }))) return;
    state.deletingTaskIds.add(taskId);
    if (state.taskEditor.taskId === taskId) resetTaskEditor();
    renderTasks();
    renderRunDetail();
    try {
        await api(`/api/tasks/${encodeURIComponent(taskId)}`, { method: "DELETE" });
        await refresh();
        toast(t("toast.taskDeleted"));
    } catch (error) {
        toast(error.message);
    } finally {
        state.deletingTaskIds.delete(taskId);
        renderTasks();
        renderRunDetail();
    }
}

function mergeLogEvents(current, incoming) {
    const byKey = new Map();
    for (const event of [...(current || []), ...(incoming || [])]) {
        if (!event || typeof event !== "object") continue;
        const key = event.id || `${event.sequence || 0}:${event.timestamp || ""}:${event.type || ""}`;
        byKey.set(key, event);
    }
    return Array.from(byKey.values()).sort((left, right) => {
        const sequenceDifference = Number(left.sequence || 0) - Number(right.sequence || 0);
        if (sequenceDifference !== 0) return sequenceDifference;
        return String(left.timestamp || "").localeCompare(String(right.timestamp || ""));
    });
}

function boundLogEvents(events) {
    let start = events.length;
    let characters = 0;
    while (start > 0 && events.length - start < MAX_LOG_EVENTS) {
        const length = String(events[start - 1].text || "").length;
        if (start < events.length && characters + length > MAX_LOG_RENDER_CHARS) break;
        characters += length;
        start -= 1;
    }
    return events.slice(start);
}

function cancelLogRequest() {
    const controller = state.log.abortController;
    if (!controller) return;
    state.log.abortController = null;
    state.log.requestId += 1;
    state.log.loading = false;
    controller.abort();
}

async function loadLog(taskId, options = {}) {
    if (options.incremental && state.log.loading) return null;
    cancelLogRequest();
    if (!taskId) {
        state.log.requestId += 1;
        Object.assign(state.log, {
            taskId: "",
            runId: "",
            events: [],
            content: "",
            contentBytes: 0,
            contentReturnedBytes: 0,
            contentOmittedBytes: 0,
            contentTruncated: false,
            runs: [],
            format: "empty",
            status: "missing",
            warnings: [],
            nextCursor: 0,
            loading: false,
            error: "",
            following: true,
            totalEvents: 0,
            firstCursor: 0,
            hasMoreBefore: false,
            hasMoreAfter: false,
            historyMode: false,
            sourceSignature: "",
        });
        renderConversationLog();
        return null;
    }
    const sameTask = state.log.taskId === taskId;
    const requestedRunId = options.runId === undefined
        ? sameTask ? state.log.runId : ""
        : String(options.runId || "");
    const incremental = options.incremental === true
        && sameTask
        && requestedRunId === state.log.runId
        && !state.log.error;
    const afterSequence = incremental ? Number(state.log.nextCursor || 0) : 0;
    const beforeSequence = Math.max(0, Number(options.beforeSequence) || 0);
    const requestId = state.log.requestId + 1;
    const abortController = new AbortController();
    state.log.requestId = requestId;
    state.log.abortController = abortController;
    state.log.taskId = taskId;
    state.log.runId = requestedRunId;
    state.log.loading = true;
    state.log.error = "";
    if (!incremental) {
        state.log.events = [];
        state.log.content = "";
        state.log.contentBytes = 0;
        state.log.contentReturnedBytes = 0;
        state.log.contentOmittedBytes = 0;
        state.log.contentTruncated = false;
        state.log.runs = [];
        state.log.format = "empty";
        state.log.status = "missing";
        state.log.nextCursor = 0;
        state.log.warnings = [];
        state.log.following = !beforeSequence;
        state.log.historyMode = beforeSequence > 0;
        state.log.renderVersion += 1;
        renderConversationLog({ forceFollow: !beforeSequence });
    } else {
        renderLogRunOptions();
    }

    const params = new URLSearchParams();
    params.set("limit", String(LOG_PAGE_SIZE));
    if (requestedRunId) params.set("runId", requestedRunId);
    if (afterSequence > 0) params.set("after", String(afterSequence));
    if (beforeSequence > 0) params.set("before", String(beforeSequence));
    const query = params.toString();
    try {
        const result = await api(`/api/tasks/${encodeURIComponent(taskId)}/log${query ? `?${query}` : ""}`, {
            signal: abortController.signal,
        });
        if (requestId !== state.log.requestId) return null;
        state.log.abortController = null;
        if (incremental && result.latestCursor !== undefined && Number(result.latestCursor) < afterSequence) {
            return loadLog(taskId, { runId: requestedRunId, forceFollow: true });
        }
        const incomingEvents = Array.isArray(result.events) ? result.events : [];
        const previousContent = state.log.content;
        state.log.events = boundLogEvents(incremental
            ? mergeLogEvents(state.log.events, incomingEvents)
            : mergeLogEvents([], incomingEvents));
        const contentPreview = legacyLogPreview(result.content || state.log.content || "");
        state.log.content = contentPreview.content;
        if (!incremental || incomingEvents.length || state.log.content !== previousContent) state.log.renderVersion += 1;
        state.log.totalEvents = Number(result.totalEvents || state.log.events.length);
        state.log.firstCursor = Number(state.log.events[0]?.sequence || 0);
        state.log.hasMoreBefore = result.oldestCursor !== undefined
            ? state.log.firstCursor > Number(result.oldestCursor)
            : result.hasMoreBefore === true;
        state.log.hasMoreAfter = result.hasMoreAfter === true;
        state.log.contentBytes = Number(result.contentBytes || 0);
        state.log.contentReturnedBytes = Number(result.contentReturnedBytes || 0);
        state.log.contentOmittedBytes = Number(result.contentOmittedBytes || 0);
        state.log.contentTruncated = Boolean(result.contentTruncated || contentPreview.truncated);
        state.log.runs = Array.isArray(result.runs) ? result.runs : [];
        state.log.format = String(result.format || "empty");
        state.log.status = String(result.status || "missing");
        state.log.warnings = Array.isArray(result.warnings) ? [...result.warnings] : [];
        if (contentPreview.truncated && !state.log.warnings.some((warning) => warning?.code === "content_truncated")) {
            state.log.warnings.push({
                code: "content_truncated",
                message: translatedOr("runtime.logRenderTruncated", "Large legacy log preview was truncated for responsiveness."),
            });
        }
        const maxEventSequence = state.log.events.reduce(
            (maximum, event) => Math.max(maximum, Number(event.sequence || 0)),
            0,
        );
        state.log.nextCursor = Math.max(
            Number(state.log.nextCursor || 0),
            Number(result.nextCursor || 0),
            maxEventSequence,
        );
        state.log.loading = false;
        state.log.error = "";
        state.log.runId = String(result.runId || requestedRunId || "");
        state.selectedTaskId = taskId;
        const task = (state.data?.tasks || []).find((item) => item.id === taskId);
        state.log.sourceSignature = taskLogSignature(task);
        if ($("#runTask")) $("#runTask").value = taskId;
        renderConversationLog({ forceFollow: options.forceFollow === true || (!incremental && !beforeSequence) });
        return result;
    } catch (error) {
        if (requestId !== state.log.requestId) return null;
        state.log.abortController = null;
        if (error?.name === "AbortError") return null;
        state.log.loading = false;
        state.log.error = error.message || t("runtime.logFailed");
        renderConversationLog();
        if (options.silent === true) return null;
        throw error;
    }
}

function switchView(view) {
    if (view !== "runtime") cancelLogRequest();
    state.activeView = view;
    $$(".nav").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
    $$(".view").forEach((node) => node.classList.toggle("active", node.id === view));
    if (view === "pings" && state.data) {
        renderPings();
        refresh().catch((error) => toast(error.message));
    }
}

function clearDashboardHighlights() {
    if (state.dashboardHighlightTimer) {
        clearTimeout(state.dashboardHighlightTimer);
        state.dashboardHighlightTimer = null;
    }
    $$(".dashboard-target-highlight").forEach((node) => node.classList.remove("dashboard-target-highlight"));
    $$(".dashboard-task-highlight").forEach((node) => node.classList.remove("dashboard-task-highlight"));
}

function revealProjects(projectIds = [], taskIds = []) {
    const wantedProjects = new Set(projectIds.map(String).filter(Boolean));
    const wantedTasks = new Set(taskIds.map(String).filter(Boolean));
    const projectNodes = $$("[data-project-id]", $("#taskList"));
    const taskNodes = $$("[data-open-task]", $("#taskList"));
    clearDashboardHighlights();
    const matchedProjects = projectNodes.filter((node) => wantedProjects.has(String(node.dataset.projectId || "")));
    const matchedTasks = taskNodes.filter((node) => wantedTasks.has(String(node.dataset.openTask || "")));
    matchedProjects.forEach((node) => node.classList.add("dashboard-target-highlight"));
    matchedTasks.forEach((node) => node.classList.add("dashboard-task-highlight"));
    const primary = matchedProjects[0] || matchedTasks[0];
    if (!primary) return;
    const focusTarget = () => {
        primary.scrollIntoView?.({ behavior: "smooth", block: "center" });
        primary.focus?.({ preventScroll: true });
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(focusTarget);
    else focusTarget();
    state.dashboardHighlightTimer = setTimeout(clearDashboardHighlights, 2600);
}

async function openTaskPage(taskId) {
    const task = (state.data?.tasks || []).find((item) => item.id === taskId);
    if (!task) {
        switchView("tasks");
        return false;
    }
    state.selectedTaskId = taskId;
    renderSelectors();
    renderRunDetail();
    renderRuntimeTabs();
    switchView("runtime");
    await loadFile(taskId);
    await loadLog(taskId, { runId: "", forceFollow: true });
    return true;
}

function openProject(projectId) {
    switchView("tasks");
    revealProjects([projectId]);
}

function openDashboardView(view, runtimeState = "") {
    switchView(view);
    if (view !== "tasks" || !runtimeState) return;
    const tasks = (state.data?.tasks || []).filter(
        (task) => !task.archived && taskRuntimeState(task) === runtimeState,
    );
    revealProjects(
        [...new Set(tasks.map((task) => task.projectId).filter(Boolean))],
        tasks.map((task) => task.id),
    );
}

function applyLanguage(language = "") {
    if (language) {
        i18n.setLanguage(language);
    } else {
        i18n.apply();
    }
    $("#languageSelect").value = i18n.getLanguage();
    if (!state.selectedTaskId) $("#editorPath").textContent = t("editor.noTask");
    syncTaskSourceMode();
    syncTaskType();
    syncScheduleMode();
    if (state.taskEditor.taskId) {
        const editingTask = (state.data?.tasks || []).find((task) => task.id === state.taskEditor.taskId);
        if (editingTask) $("#taskEditorTitle").textContent = t("task.editor.selected", { name: editingTask.title });
        $("#taskEditorNotice").textContent = t("task.editor.lockedFields");
    }
    renderTaskEditorStatus();
    const profileId = $("#profileForm").elements.id.value;
    const profile = (state.data?.profiles || []).find((item) => item.id === profileId) || null;
    updateTokenPlaceholder(profile);
    if (state.data) renderAll();
    renderConversationLog();
    tickClock();
}

function bindEvents() {
    $$(".nav").forEach((button) => {
        button.addEventListener("click", () => {
            const view = button.dataset.view;
            switchView(view);
            if (view !== "runtime") return;
            const taskId = $("#runTask").value || state.selectedTaskId;
            if (taskId && (state.log.taskId !== taskId || state.log.status === "missing")) {
                loadLog(taskId, { forceFollow: true }).catch((error) => toast(error.message));
            }
        });
    });
    $("#languageSelect").addEventListener("change", (event) => applyLanguage(event.target.value));
    $("[data-refresh]").addEventListener("click", () => refresh().then(() => toast(t("toast.refreshed"))));
    $("#metrics").addEventListener("click", (event) => {
        const target = event.target.closest?.("[data-dashboard-view]");
        if (!target) return;
        openDashboardView(target.dataset.dashboardView, target.dataset.dashboardRuntimeState || "");
    });
    const openDashboardEvent = async (target) => {
        const taskId = target?.dataset?.dashboardTask;
        if (taskId) {
            try {
                await openTaskPage(taskId);
            } catch (error) {
                toast(error.message);
            }
            return;
        }
        const view = target?.dataset?.dashboardView;
        if (view) openDashboardView(view);
    };
    $("#eventFeed").addEventListener("click", (event) => {
        const target = event.target.closest?.("[data-dashboard-view]");
        if (target) openDashboardEvent(target);
    });
    $("#eventFeed").addEventListener("keydown", (event) => {
        if (!["Enter", " "].includes(event.key)) return;
        const target = event.target.closest?.("[data-dashboard-view]");
        if (!target) return;
        event.preventDefault();
        openDashboardEvent(target);
    });

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
        const formData = new FormData(form);
        const body = Object.fromEntries(formData.entries());
        body.inputModalities = formData.getAll("inputModalities").filter(Boolean);
        body.outputModalities = formData.getAll("outputModalities").filter(Boolean);
        if (!body.inputModalities.includes("text")) return toast(t("toast.textInputRequired"));
        if (body.outputModalities.length === 0) return toast(t("toast.outputModalityRequired"));
        body.enabled = form.elements.enabled.checked;
        body.nonInteractive = form.elements.nonInteractive.checked;
        body.timeoutSeconds = Number(body.timeoutSeconds || 7200);
        body.pingEnabled = form.elements.pingEnabled.checked;
        body.pingIntervalMinutes = Number(body.pingIntervalMinutes || 60);
        const result = await api("/api/profiles", { method: "POST", body });
        form.elements.id.value = result.profile?.id || body.id || "";
        const pingButton = $("#pingProfile");
        if (pingButton) pingButton.disabled = !form.elements.id.value;
        await refresh();
        toast(t("toast.profileSaved"));
    });
    $("#pingProfile").addEventListener("click", async () => {
        const form = $("#profileForm");
        const button = $("#pingProfile");
        const id = String(form.elements.id.value || "").trim();
        if (!id) {
            setProfilePingStatus(t("profile.pingUnsaved"), "error");
            return;
        }
        button.disabled = true;
        setProfilePingStatus(t("profile.pingTesting"), "pending");
        try {
            const result = await api(`/api/profiles/${encodeURIComponent(id)}/ping`, { method: "POST" });
            const record = result.record || {};
            if (record.success) {
                const message = t("profile.pingSuccess", { duration: formatDuration(record.durationMs) });
                setProfilePingStatus(message, "success");
                toast(message);
            } else {
                const reason = record.failureReason || record.outputTail || `exitCode ${record.exitCode ?? "-"}`;
                const message = t("profile.pingFailure", { reason });
                setProfilePingStatus(message, "error");
                toast(message);
            }
            await refresh();
        } catch (error) {
            setProfilePingStatus(error.message, "error");
            toast(error.message);
        } finally {
            button.disabled = !form.elements.id.value;
        }
    });
    $("#duplicateProfile").addEventListener("click", () => {
        const form = $("#profileForm");
        form.elements.id.value = "";
        form.elements.name.value = `${form.elements.name.value || "profile"}-copy`;
        const pingButton = $("#pingProfile");
        if (pingButton) pingButton.disabled = true;
        setProfilePingStatus();
    });
    $("#deleteProfile").addEventListener("click", async () => {
        const id = $("#profileForm").elements.id.value;
        if (!id) return toast(t("toast.selectProfile"));
        await api(`/api/profiles/${encodeURIComponent(id)}`, { method: "DELETE" });
        resetProfileForm();
        await refresh();
        toast(t("toast.profileDeleted"));
    });

    $("#taskSourceMode").addEventListener("change", syncTaskSourceMode);
    $("#taskType").addEventListener("change", syncTaskType);
    $("#taskProject").addEventListener("change", syncTaskProjectDirectory);
    $("#taskForm input[name='sourceFile']").addEventListener("change", (event) => {
        applySelectedTaskFile(event.target.files?.[0]);
    });
    $("#taskForm").addEventListener("input", (event) => {
        if ($("#taskForm").dataset.mode !== "edit") return;
        if (TASK_EDITOR_LOCKED_FIELDS.includes(event.target?.name)) return;
        scheduleTaskAutosave();
    });
    $("#taskForm").addEventListener("change", (event) => {
        if ($("#taskForm").dataset.mode !== "edit") return;
        if (TASK_EDITOR_LOCKED_FIELDS.includes(event.target?.name)) return;
        scheduleTaskAutosave();
    });
    $("#newTaskButton").addEventListener("click", () => {
        resetTaskEditor();
        $("#taskForm").elements.title.focus();
    });
    $("#taskOpenRuntime").addEventListener("click", async () => {
        const taskId = state.taskEditor.taskId;
        if (!taskId) return;
        flushTaskAutosave();
        try {
            await openTaskPage(taskId);
        } catch (error) {
            toast(error.message);
        }
    });
    $("#taskForm").addEventListener("submit", async (event) => {
        event.preventDefault();
        if ($("#taskForm").dataset.mode === "edit") {
            flushTaskAutosave();
            return;
        }
        if (state.creatingTask) return;
        state.creatingTask = true;
        const submitButton = $("#taskSubmitButton");
        submitButton.disabled = true;
        try {
            const form = event.currentTarget;
            const formData = new FormData(form);
            const body = Object.fromEntries(formData.entries());
            delete body.sourceFile;
            body.projectId = form.elements.projectId.value || "";
            body.directory = form.elements.directory.value || "";
            body.runProfileIds = formData.getAll("runProfileIds").filter(Boolean);
            body.overwrite = form.elements.overwrite.checked;
            body.sourceMode = form.elements.sourceMode.value || "agent";
            if (body.sourceMode === "upload") {
                const file = form.elements.sourceFile.files?.[0];
                if (!file) return toast(t("toast.selectTaskFile"));
                applySelectedTaskFile(file);
                if (!String(body.targetFileName || "").trim()) body.targetFileName = file.name;
                if (!String(body.title || "").trim()) body.title = file.name.replace(/\.[^.]+$/, "") || file.name;
                body.sourceContent = await file.text();
            }
            const result = await api("/api/tasks", { method: "POST", body });
            state.selectedTaskId = result.task.id;
            await refresh();
            await loadFile(result.task.id);
            openTaskEditor(result.task.id);
            if (result.deduplicated) {
                toast(t("toast.taskReused"));
            } else if (result.generation?.failed) {
                toast(t("toast.generationFailed", { code: result.generation.exitCode ?? "-" }));
            } else if (body.sourceMode === "existing") {
                toast(t("toast.taskLoaded"));
            } else if (body.sourceMode === "upload") {
                toast(t("toast.taskImported"));
            } else {
                toast(t("toast.taskGenerated"));
            }
        } catch (error) {
            toast(error.message);
        } finally {
            state.creatingTask = false;
            submitButton.disabled = false;
        }
    });

    $("#deduplicateTasks").addEventListener("click", async () => {
        if (state.deduplicatingTasks) return;
        if (!window.confirm(t("task.deduplicateConfirm"))) return;
        state.deduplicatingTasks = true;
        $("#deduplicateTasks").disabled = true;
        const selectedTaskId = state.selectedTaskId;
        try {
            const result = await api("/api/tasks/deduplicate", { method: "POST" });
            const replacement = result.duplicates.find((entry) => entry.taskId === selectedTaskId);
            await refresh({ replacementTaskId: replacement?.keptTaskId || "" });
            toast(result.deletedCount || result.skippedCount
                ? t("toast.tasksDeduplicated", { count: result.deletedCount, skipped: result.skippedCount })
                : t("toast.noDuplicateTasks"));
        } catch (error) {
            toast(error.message);
        } finally {
            state.deduplicatingTasks = false;
            renderTasks();
        }
    });

    $("#taskList").addEventListener("click", async (event) => {
        const target = event.target.closest ? event.target.closest("[data-open-history], [data-open-task], [data-edit-task], [data-archive-task], [data-delete-task]") : event.target;
        if (target?.disabled) return;
        const deleteId = target?.dataset?.deleteTask;
        if (deleteId) {
            event.stopPropagation();
            await deleteTask(deleteId);
            return;
        }
        const historyId = target?.dataset?.openHistory;
        const openId = target?.dataset?.openTask;
        const editId = target?.dataset?.editTask;
        const archiveId = target?.dataset?.archiveTask;
        if (archiveId) {
            event.stopPropagation();
            try {
                await api(`/api/tasks/${encodeURIComponent(archiveId)}/archive`, { method: "POST" });
                state.selectedTaskId = archiveId;
                await refresh();
                await loadFile(archiveId);
                await loadLog(archiveId, { runId: "", forceFollow: true });
                switchView("runtime");
                toast(t("toast.taskArchived"));
            } catch (error) {
                toast(error.message);
            }
            return;
        }
        const taskId = historyId || openId || editId;
        if (!taskId) return;
        try {
            if (historyId) {
                await openTaskPage(taskId);
                return;
            }
            openTaskEditor(taskId);
        } catch (error) {
            toast(error.message);
        }
    });
    $("#dashboardStats")?.addEventListener("click", async (event) => {
        const target = event.target.closest?.("[data-open-task]");
        if (!target) return;
        try {
            await openTaskPage(target.dataset.openTask);
        } catch (error) {
            toast(error.message);
        }
    });
    $("#taskBoard").addEventListener("click", async (event) => {
        const projectTarget = event.target.closest ? event.target.closest("[data-open-project]") : null;
        if (projectTarget) {
            event.stopPropagation();
            openProject(projectTarget.dataset.openProject);
            return;
        }
        const target = event.target.closest ? event.target.closest("[data-open-task]") : event.target;
        const taskId = target?.dataset?.openTask;
        if (!taskId) return;
        try {
            await openTaskPage(taskId);
        } catch (error) {
            toast(error.message);
        }
    });
    for (const node of [$("#taskList"), $("#taskBoard")]) {
        node.addEventListener("keydown", (event) => {
            if (!["Enter", " "].includes(event.key) || event.target.closest("button")) return;
            const target = event.target.closest("[data-open-task]");
            if (!target) return;
            event.preventDefault();
            target.click();
        });
    }
    $("#editorTask").addEventListener("change", (event) => loadFile(event.target.value));
    $("#loadFile").addEventListener("click", () => loadFile($("#editorTask").value));
    $("#saveFile").addEventListener("click", async () => {
        const id = $("#editorTask").value;
        if (!id) return toast(t("toast.selectTask"));
        await api(`/api/tasks/${encodeURIComponent(id)}/file`, {
            method: "PUT",
            body: { content: $("#fileEditor").value },
        });
        if ($("#runtimeFileEditor")) $("#runtimeFileEditor").value = $("#fileEditor").value;
        await refresh();
        toast(t("toast.taskSaved"));
    });

    $("#runTask").addEventListener("change", async (event) => {
        await selectRuntimeTask(event.target.value);
    });
    $("#runtimeTabs").addEventListener("click", async (event) => {
        const button = event.target.closest?.("[data-runtime-tab]");
        const taskId = button?.dataset?.runtimeTab || "";
        if (!taskId || taskId === state.selectedTaskId) return;
        await selectRuntimeTask(taskId);
    });
    $("#logRunSelect").addEventListener("change", async (event) => {
        const taskId = $("#runTask").value || state.selectedTaskId;
        if (!taskId) return;
        setLogFollowing(true);
        try {
            await loadLog(taskId, { runId: event.target.value, forceFollow: true });
        } catch (error) {
            toast(error.message);
        }
    });
    $("#logView").addEventListener("scroll", (event) => {
        if (state.log.loading) return;
        setLogFollowing(!state.log.historyMode && isLogNearBottom(event.currentTarget));
    }, { passive: true });
    $("#followLog").addEventListener("click", async () => {
        if (state.log.following) return setLogFollowing(false);
        try {
            await loadLog(state.log.taskId, { forceFollow: true });
        } catch (error) {
            toast(error.message);
        }
    });
    $("#olderLog").addEventListener("click", async () => {
        if (!state.log.hasMoreBefore || !state.log.firstCursor || state.log.loading) return;
        try {
            await loadLog(state.log.taskId, { beforeSequence: state.log.firstCursor });
        } catch (error) {
            toast(error.message);
        }
    });
    $("#runProfiles").addEventListener("change", (event) => {
        state.selectedProfileId = selectedValues(event.target)[0] || state.selectedProfileId;
    });
    $("#decomposeProfile").addEventListener("change", (event) => {
        state.selectedProfileId = event.target.value || state.selectedProfileId;
    });
    $("#scheduleMode").addEventListener("change", syncScheduleMode);
    $("#startTask").addEventListener("click", async () => {
        const taskId = $("#runTask").value;
        const profileIds = selectedValues($("#runProfiles"));
        if (!taskId || profileIds.length === 0) return toast(t("toast.selectTaskProfile"));
        const result = await api(`/api/tasks/${encodeURIComponent(taskId)}/start`, {
            method: "POST",
            body: { profileIds, scheduleMode: "immediate" },
        });
        await refresh();
        await loadLog(taskId, { runId: "", forceFollow: true });
        toast(result.queued
            ? t("toast.taskQueued", { position: result.queuePosition || "-" })
            : t("toast.taskStarted"));
    });
    $("#scheduleTask").addEventListener("click", async () => {
        const taskId = $("#runTask").value;
        const profileIds = selectedValues($("#runProfiles"));
        const scheduleMode = selectedScheduleMode();
        if (!taskId || profileIds.length === 0) return toast(t("toast.selectTaskProfile"));
        const body = { profileIds, scheduleMode };
        if (scheduleMode === "fixed_time") {
            const startAt = parseScheduleInput($("#scheduleStartAt").value);
            if (!startAt) return toast(t("toast.selectSchedule"));
            if (startAt.getTime() <= Date.now()) return toast(t("toast.selectFutureSchedule"));
            body.startAt = startAt.toISOString();
        }
        const result = await api(`/api/tasks/${encodeURIComponent(taskId)}/start`, {
            method: "POST",
            body,
        });
        await refresh();
        await loadLog(taskId, { runId: "", forceFollow: true });
        toast(result.queued
            ? t("toast.taskQueued", { position: result.queuePosition || "-" })
            : t(scheduleMode === "profile_available"
            ? "toast.taskAvailabilityScheduled"
            : "toast.taskScheduled"));
    });
    $("#stopTask").addEventListener("click", async () => {
        const taskId = $("#runTask").value;
        if (!taskId) return toast(t("toast.selectTask"));
        await api(`/api/tasks/${encodeURIComponent(taskId)}/stop`, { method: "POST" });
        await refresh();
        await loadLog(taskId, { runId: "", forceFollow: true });
        toast(t("toast.taskStopped"));
    });
    $("#decomposeTask").addEventListener("click", async () => {
        const taskId = $("#runTask").value;
        const profileId = $("#decomposeProfile").value || selectedValues($("#runProfiles"))[0];
        if (!taskId || !profileId) return toast(t("toast.selectTaskProfile"));
        const result = await api(`/api/tasks/${encodeURIComponent(taskId)}/generate`, {
            method: "POST",
            body: { profileId },
        });
        await refresh();
        await loadFile(taskId);
        await loadLog(taskId, { runId: "", forceFollow: true });
        toast(result.failed
            ? t("toast.generateFailed", { code: result.exitCode ?? "-" })
            : t("toast.taskGenerated"));
    });
    $("#copyLog").addEventListener("click", async () => {
        await navigator.clipboard.writeText(logPlainText());
        toast(t("toast.logCopied"));
    });
    $("#appendTaskButton").addEventListener("click", async () => {
        const taskId = $("#runTask").value || state.selectedTaskId;
        const feedback = $("#appendTaskFeedback");
        const button = $("#appendTaskButton");
        const completionStandard = $("#appendCompletionStandard").value.trim();
        const items = $("#appendTaskItems").value
            .split(/\r?\n/)
            .map((line) => line.trim().replace(/^(?:[-*+]\s*(?:\[[ xX]\]\s*)?|\d+[.)]\s*)/, ""))
            .filter(Boolean)
            .map((text) => completionStandard ? { text, completionStandard } : { text });
        if (!taskId) return toast(t("toast.selectTask"));
        if (items.length === 0) {
            feedback.textContent = t("runtime.appendEmpty");
            return toast(t("runtime.appendEmpty"));
        }
        button.disabled = true;
        feedback.className = "field-note append-feedback-pending";
        feedback.textContent = t("runtime.appending");
        try {
            const result = await api(`/api/tasks/${encodeURIComponent(taskId)}/items`, {
                method: "POST",
                body: { items },
            });
            state.selectedTaskId = taskId;
            await refresh();
            await loadFile(taskId);
            await loadLog(taskId, { runId: "", forceFollow: true });
            $("#appendTaskItems").value = "";
            $("#appendCompletionStandard").value = "";
            feedback.className = "field-note append-feedback-success";
            feedback.textContent = translatedOr("runtime.appended", `${result.items?.length || items.length} items appended`, {
                count: result.items?.length || items.length,
            });
            toast(feedback.textContent);
        } catch (error) {
            feedback.className = "field-note append-feedback-error";
            feedback.textContent = error.message;
            toast(error.message);
        } finally {
            renderRuntimeContext(getSelectedTask());
        }
    });
    $("#appendTaskItems").addEventListener("keydown", (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            $("#appendTaskButton").click();
        }
    });

    $("#runtimeLoadFile").addEventListener("click", async () => {
        const taskId = $("#runTask").value || state.selectedTaskId;
        if (!taskId) return toast(t("toast.selectTask"));
        try {
            await loadFile(taskId);
        } catch (error) {
            toast(error.message);
        }
    });
    $("#runtimeSaveFile").addEventListener("click", async () => {
        const taskId = $("#runTask").value || state.selectedTaskId;
        const editor = $("#runtimeFileEditor");
        if (!taskId || !editor) return toast(t("toast.selectTask"));
        try {
            await api(`/api/tasks/${encodeURIComponent(taskId)}/file`, {
                method: "PUT",
                body: { content: editor.value },
            });
            $("#fileEditor").value = editor.value;
            await refresh();
            toast(t("toast.taskSaved"));
        } catch (error) {
            toast(error.message);
        }
    });
    $("#archiveTask").addEventListener("click", async () => {
        const taskId = $("#runTask").value || state.selectedTaskId;
        const task = (state.data?.tasks || []).find((item) => item.id === taskId);
        if (!task || task.archived) return;
        try {
            await api(`/api/tasks/${encodeURIComponent(taskId)}/archive`, { method: "POST" });
            await refresh();
            await loadFile(taskId);
            await loadLog(taskId, { runId: "", forceFollow: true });
            toast(t("toast.taskArchived"));
        } catch (error) {
            toast(error.message);
        }
    });
    $("#deleteTask").addEventListener("click", () => deleteTask($("#runTask").value || state.selectedTaskId));

    $("#pingEnabled").addEventListener("change", async (event) => {
        await api("/api/pings/settings", {
            method: "POST",
            body: { enabled: event.target.checked },
        });
        await refresh();
        toast(event.target.checked ? t("toast.pingEnabled") : t("toast.pingDisabled"));
    });

    $("#pingProfileList").addEventListener("change", async (event) => {
        if (!(event.target instanceof HTMLInputElement) || event.target.name !== "pingProfileIds") return;
        const profileIds = $$("#pingProfileList input[name='pingProfileIds']:checked").map((node) => node.value);
        try {
            await api("/api/pings/settings", { method: "POST", body: { profileIds } });
            await refresh();
            toast(t("toast.pingProfilesSaved", { count: profileIds.length }));
        } catch (error) {
            renderPingProfilePicker();
            toast(error.message);
        }
    });

    $("#runPing").addEventListener("click", async () => {
        const button = $("#runPing");
        button.disabled = true;
        try {
            const result = await api("/api/pings/run", { method: "POST" });
            await refresh();
            toast(t("toast.pingComplete", {
                success: result.records.filter((record) => record.success).length,
                total: result.records.length,
            }));
        } finally {
            button.disabled = false;
        }
    });

    $("#directoryForm").addEventListener("submit", async (event) => {
        event.preventDefault();
        const body = Object.fromEntries(new FormData(event.currentTarget).entries());
        await api("/api/directories", { method: "POST", body });
        event.currentTarget.reset();
        await refresh();
        toast(t("toast.directoryAdded"));
    });
    $("#directoryList").addEventListener("click", async (event) => {
        const encoded = event.target.dataset.deleteDir;
        if (!encoded) return;
        await api(`/api/directories/${encoded}`, { method: "DELETE" });
        await refresh();
        toast(t("toast.directoryRemoved"));
    });
    $("#projectForm").addEventListener("submit", async (event) => {
        event.preventDefault();
        const body = Object.fromEntries(new FormData(event.currentTarget).entries());
        try {
            await api("/api/projects", { method: "POST", body });
            event.currentTarget.reset();
            $("#projectSubmit").textContent = t("project.create");
            await refresh();
            toast(body.id ? t("project.edit") : t("toast.projectCreated"));
        } catch (error) {
            toast(error.message);
        }
    });
    $("#projectList").addEventListener("click", async (event) => {
        const target = event.target.closest?.("[data-edit-project], [data-delete-project], [data-open-project]");
        const editId = target?.dataset?.editProject;
        if (editId) {
            const project = (state.data?.projects || []).find((item) => item.id === editId);
            if (!project) return;
            const form = $("#projectForm");
            form.elements.id.value = project.id;
            form.elements.name.value = project.name;
            form.elements.directory.value = project.directory || "";
            $("#projectSubmit").textContent = t("project.edit");
            form.elements.name.focus();
            return;
        }
        const id = target?.dataset?.deleteProject;
        if (!id) {
            const projectId = target?.dataset?.openProject;
            if (projectId) openProject(projectId);
            return;
        }
        try {
            await api(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
            await refresh();
            toast(t("toast.projectDeleted"));
        } catch (error) {
            toast(error.message);
        }
    });
    $("#projectList").addEventListener("keydown", (event) => {
        if (!["Enter", " "].includes(event.key) || event.target.closest("button")) return;
        const target = event.target.closest?.("[data-open-project]");
        if (!target) return;
        event.preventDefault();
        openProject(target.dataset.openProject);
    });
}

function tickClock() {
    if (document.hidden) return;
    const key = `clock:${i18n.getLocale()}`;
    if (!timeFormatters.has(key)) {
        timeFormatters.set(key, new Intl.DateTimeFormat(i18n.getLocale(), {
            hour: "2-digit", minute: "2-digit", second: "2-digit",
        }));
    }
    $("#serverClock").textContent = timeFormatters.get(key).format(new Date());
    syncScheduleInput();
}

function taskLogSignature(task) {
    return task ? `${task.id}:${task.logSize || 0}:${task.updatedAt || ""}:${task.status}` : "";
}

async function poll() {
    if (state.pollInFlight || document.hidden) return;
    clearTimeout(state.pollTimer);
    state.pollInFlight = true;
    try {
        await refresh();
        const currentTask = $("#runTask").value || state.selectedTaskId;
        const task = (state.data?.tasks || []).find((item) => item.id === currentTask);
        if (task && state.activeView === "runtime" && state.log.following && !state.log.historyMode
            && (state.log.sourceSignature !== taskLogSignature(task) || state.log.hasMoreAfter)) {
            await loadLog(currentTask, { incremental: true, silent: true });
        }
        state.pollFailures = 0;
    } catch (error) {
        state.pollFailures += 1;
        if (state.pollFailures === 1) toast(error.message);
    } finally {
        state.pollInFlight = false;
        if (!document.hidden) {
            const active = (state.data?.tasks || []).some((task) => task.isRunning
                || ["running", "queued", "scheduled", "retry_wait"].includes(task.status));
            const delay = state.pollFailures ? Math.min(30000, 5000 * state.pollFailures)
                : state.activeView === "runtime" && state.log.following && state.log.hasMoreAfter ? 100
                    : active ? 2000 : 5000;
            state.pollTimer = setTimeout(poll, delay);
        }
    }
}

async function boot() {
    applyLanguage();
    bindEvents();
    setInterval(tickClock, 1000);
    await refresh();
    const firstProfile = state.data?.profiles?.[0];
    resetProfileForm(firstProfile || null);
    syncTaskType();
    renderTaskEditorStatus();
    const firstTask = state.data?.tasks?.[0];
    if (firstTask) {
        await loadFile(firstTask.id);
    }
    state.pollTimer = setTimeout(poll, 2000);
    document.addEventListener("visibilitychange", () => {
        clearTimeout(state.pollTimer);
        if (document.hidden) cancelLogRequest();
        else poll();
    });
}

window.addEventListener("error", (event) => toast(event.message));
boot().catch((error) => toast(error.message));
