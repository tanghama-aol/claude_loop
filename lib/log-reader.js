const fs = require("node:fs");

const READ_CHUNK_BYTES = 256 * 1024;

function readAt(handle, position, length) {
    const buffer = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
        const count = fs.readSync(handle, buffer, offset, length - offset, position + offset);
        if (!count) break;
        offset += count;
    }
    return buffer.subarray(0, offset);
}

function fileSignature(stat) {
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

// Keep byte offsets and small event summaries, never the accumulated output text.
// A warm poll indexes only bytes appended since the last complete JSONL line.
function createLogReader({ maxFiles = 8, maxEntries = 200000 } = {}) {
    const cache = new Map();

    function inspect(filePath) {
        let handle;
        try {
            const stat = fs.statSync(filePath);
            const signature = fileSignature(stat);
            const previous = cache.get(filePath);
            if (previous?.signature === signature) {
                cache.delete(filePath);
                cache.set(filePath, previous);
                return previous;
            }
            handle = fs.openSync(filePath, "r");
            const canAppend = previous && previous.dev === stat.dev && previous.ino === stat.ino
                && stat.size > previous.size
                && readAt(handle, 0, previous.head.length).equals(previous.head)
                && readAt(handle, previous.boundaryOffset, previous.boundary.length).equals(previous.boundary);
            const entries = canAppend ? previous.entries.slice() : [];
            let malformedLines = canAppend ? previous.completeMalformedLines : 0;
            let position = canAppend ? previous.offset : 0;
            let lineStart = position;
            let pending = Buffer.alloc(0);
            const parseLine = (line, offset) => {
                const text = line.toString("utf8");
                if (!text.trim()) return null;
                try {
                    const event = JSON.parse(text);
                    if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("Invalid event");
                    return {
                        sequence: Number(event.sequence || 0) || 0,
                        timestamp: String(event.timestamp || ""),
                        runId: String(event.runId || ""),
                        type: String(event.type || ""),
                        offset,
                        length: line.length,
                    };
                } catch {
                    malformedLines += 1;
                    return null;
                }
            };
            while (position < stat.size) {
                const chunk = readAt(handle, position, Math.min(READ_CHUNK_BYTES, stat.size - position));
                if (!chunk.length) break;
                position += chunk.length;
                const buffer = pending.length ? Buffer.concat([pending, chunk]) : chunk;
                let start = 0;
                let end;
                while ((end = buffer.indexOf(10, start)) !== -1) {
                    const entry = parseLine(buffer.subarray(start, end), lineStart);
                    if (entry) entries.push(entry);
                    lineStart += end - start + 1;
                    start = end + 1;
                }
                pending = Buffer.from(buffer.subarray(start));
            }
            const completeMalformedLines = malformedLines;
            const partial = pending.length ? parseLine(pending, lineStart) : null;
            const events = partial ? [...entries, partial] : entries.slice();
            events.sort((left, right) => left.sequence - right.sequence
                || left.timestamp.localeCompare(right.timestamp) || left.offset - right.offset);
            const boundaryOffset = Math.max(0, lineStart - 128);
            const result = {
                filePath, signature, dev: stat.dev, ino: stat.ino, size: stat.size,
                offset: lineStart, entries, events, completeMalformedLines, malformedLines,
                head: readAt(handle, 0, Math.min(128, stat.size)),
                boundaryOffset,
                boundary: readAt(handle, boundaryOffset, lineStart - boundaryOffset),
                exists: true, readError: null,
            };
            cache.delete(filePath);
            cache.set(filePath, result);
            let cachedEntries = Array.from(cache.values()).reduce((sum, item) => sum + item.events.length, 0);
            while (cache.size > 1 && (cache.size > maxFiles || cachedEntries > maxEntries)) {
                const oldestKey = cache.keys().next().value;
                cachedEntries -= cache.get(oldestKey).events.length;
                cache.delete(oldestKey);
            }
            return result;
        } catch (error) {
            cache.delete(filePath);
            return {
                filePath, events: [], malformedLines: 0,
                exists: error.code !== "ENOENT",
                readError: error.code === "ENOENT" ? null : error.message,
            };
        } finally {
            if (handle !== undefined) fs.closeSync(handle);
        }
    }

    function readEvents(filePath, entries) {
        if (!entries.length) return [];
        const handle = fs.openSync(filePath, "r");
        try {
            return entries.map((entry) => JSON.parse(readAt(handle, entry.offset, entry.length).toString("utf8")));
        } finally {
            fs.closeSync(handle);
        }
    }

    return { inspect, readEvents };
}

function selectLogEntries(events, { after = 0, before = 0, limit = 0, maxBytes = 512 * 1024 } = {}) {
    // Logs are ordered by sequence; binary search avoids scanning old history on every poll.
    const lowerBound = (sequence, inclusive) => {
        let low = 0;
        let high = events.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (inclusive ? events[middle].sequence <= sequence : events[middle].sequence < sequence) low = middle + 1;
            else high = middle;
        }
        return low;
    };
    const first = after > 0 ? lowerBound(after, true) : 0;
    const last = before > 0 ? lowerBound(before, false) : events.length;
    let start = first;
    let end = Math.max(first, last);
    if (limit > 0) {
        let bytes = 0;
        if (after > 0) {
            end = first;
            while (end < last && end - first < limit) {
                if (end > first && bytes + events[end].length > maxBytes) break;
                bytes += events[end++].length;
            }
        } else {
            start = end;
            while (start > first && end - start < limit) {
                if (start < end && bytes + events[start - 1].length > maxBytes) break;
                bytes += events[--start].length;
            }
        }
    }
    return {
        entries: events.slice(start, end),
        hasMoreBefore: start > 0,
        hasMoreAfter: end < events.length,
        totalEvents: events.length,
    };
}

module.exports = { createLogReader, selectLogEntries };
