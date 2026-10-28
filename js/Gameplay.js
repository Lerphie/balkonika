// Gameplay.js — optional deterministic game helpers. No Babylon, DOM UI creation or wall clock.
// Call update/step from the owning fixed tick; positions and collisions are game state.

/** @typedef {{x:number, y:number, w:number, h:number}} GameRect */
/** @typedef {{tick:number, context:string, name:string|null, value:number, initial?:true, cancel?:true}} InputActionEvent */

class InputActions {
    /** @param {Record<string, Record<string,string>>} [bindings] */
    constructor(bindings = {}) {
        this.bindings = Object.assign({ game: {}, menu: {}, editor: {} }, bindings);
        this.context = 'game';
        this.tick = 0;
        this.values = new Map();
        this.sources = new Map();
        this.listeners = new Set();
        /** @type {InputActionEvent[]} */ this.recorded = [];
        /** @type {InputActionEvent[]|null} */ this.tape = null;
        this.recording = false;
        this.cursor = 0;
        this._detach = null;
        this._pressed = new Set();
        this._released = new Set();
        this._pendingPressed = new Map();
        this._pendingReleased = new Map();
        /** @type {number|null} */ this._edgeTick = null;
        this._initialDepth = 0;
    }
    value(name) { return this.values.get(name) || 0; }
    down(name) { return this.value(name) > 0; }
    // Read after step(tick). Multiple readers see the same edges throughout that tick.
    pressed(name) { return this._pressed.has(name); }
    released(name) { return this._released.has(name); }
    axis(negative, positive) { return this.value(positive) - this.value(negative); }
    /** @param {(event:InputActionEvent)=>void} listener */
    onChange(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    _emit(name, value, initial = false) {
        /** @type {InputActionEvent} */ const event = { tick: this.tick, context: this.context, name, value };
        if (initial || this._initialDepth) event.initial = true;
        if (this.recording) this.recorded.push({ ...event });
        if (event.initial) this._initialDepth++;
        try { for (const listener of this.listeners) listener({ ...event }); }
        finally { if (event.initial) this._initialDepth--; }
    }
    set(name, value) {
        if (typeof name !== 'string' || !name || !Number.isFinite(value) || Math.abs(value) > 1) throw new Error('INPUT_ACTION_INVALID');
        const before = this.value(name);
        if (before === value) return;
        // Events between ticks belong to the next tick, including a complete short tap.
        // Replay applies events at their recorded tick and uses this same boundary.
        const pending = value > 0 && before <= 0 ? this._pendingPressed :
            value <= 0 && before > 0 ? this._pendingReleased : null;
        if (!this._initialDepth && pending && !pending.has(name)) pending.set(name, this.tick + 1);
        this.values.set(name, value); this._emit(name, value);
    }
    _clearEdges() {
        this._pressed.clear(); this._released.clear();
        this._pendingPressed.clear(); this._pendingReleased.clear();
    }
    clear() {
        this.sources.clear();
        for (const name of this.values.keys()) this.set(name, 0);
        // Focus/context cancellation must not turn an old click into a future action.
        this._clearEdges();
        // A cancellation differs from a normal release: replay must discard the edges too.
        // This tape control record is not another onChange/context notification.
        if (this.recording) this.recorded.push({ tick: this.tick, context: this.context, name: null, value: 0, cancel: true });
    }
    // Call from game.restore after ArcApp has restored its clock; live input is not saved state.
    reset(tick = 0) {
        if (!Number.isSafeInteger(tick) || tick < 0) throw new Error('INPUT_TICK_INVALID');
        this.recording = false; this.tape = null; this.recorded = []; this.cursor = 0;
        this.clear(); this.tick = tick; this._edgeTick = null;
        return this;
    }
    setContext(context) {
        if (!Object.prototype.hasOwnProperty.call(this.bindings, context)) throw new Error('INPUT_CONTEXT_UNKNOWN');
        if (this.context === context) return;
        this.clear(); this.context = context; this._emit(null, 0);
    }
    _key(event, down, code) {
        if (this.tape) return;
        const held = this.sources.get(code);
        if (!down) {
            if (held) {
                this.sources.delete(code);
                if (![...this.sources.values()].includes(held)) this.set(held, 0);
            }
            return;
        }
        const target = event.target;
        if (event.ctrlKey || event.metaKey || event.altKey || (target &&
            (/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName) || target.isContentEditable ||
             (target.closest && target.closest('button,input,textarea,select,[contenteditable="true"]'))))) return;
        const action = this.bindings[this.context][code];
        if (!action) return;
        event.preventDefault();
        this.sources.set(code, action); this.set(action, 1);
    }
    // Pointer buttons use Mouse0/Mouse1/Mouse2. Keyboard codes use KeyboardEvent.code.
    /** @param {Window|HTMLElement} [target] */
    attach(target = window) {
        this.detach();
        const handlers = {
            keydown: e => this._key(e, true, e.code), keyup: e => this._key(e, false, e.code),
            pointerdown: e => this._key(e, true, 'Mouse' + e.button),
            pointerup: e => this._key(e, false, 'Mouse' + e.button),
            pointercancel: () => this.clear(), blur: () => this.clear()
        };
        for (const [name, handler] of Object.entries(handlers)) target.addEventListener(name, handler);
        this._detach = () => { for (const [name, handler] of Object.entries(handlers)) target.removeEventListener(name, handler); };
        return this;
    }
    detach() { if (this._detach) this._detach(); this._detach = null; this.clear(); }
    startRecording() {
        this.tape = null; this.recorded = []; this.recording = true;
        this._emit(null, 0, true);
        for (const [name, value] of this.values) if (value) this._emit(name, value, true);
    }
    stopRecording() { this.recording = false; return this.recorded.map(event => ({ ...event })); }
    /** @param {InputActionEvent[]} events */
    replay(events) {
        let previous = -1;
        for (const e of events) {
            if (!Number.isSafeInteger(e.tick) || e.tick < previous || !Object.prototype.hasOwnProperty.call(this.bindings, e.context) ||
                !(e.name === null || typeof e.name === 'string' && e.name) || !Number.isFinite(e.value) || Math.abs(e.value) > 1 ||
                e.initial !== undefined && e.initial !== true ||
                e.cancel !== undefined && (e.cancel !== true || e.name !== null || e.value !== 0 || e.initial !== undefined)) throw new Error('INPUT_REPLAY_INVALID');
            previous = e.tick;
        }
        this.recording = false; this.clear();
        this.tape = events.map(event => ({ ...event })); this.cursor = 0; this.tick = 0; this._edgeTick = null;
    }
    stopReplay() { this.tape = null; this.clear(); }
    step(tick) {
        if (!Number.isSafeInteger(tick) || tick < this.tick) throw new Error('INPUT_TICK_INVALID');
        if (tick === this._edgeTick) return;
        this._pressed.clear(); this._released.clear();
        const tape = this.tape;
        if (tape) while (this.cursor < tape.length && tape[this.cursor].tick <= tick) {
            const e = tape[this.cursor++];
            this.tick = e.tick; this.setContext(e.context);
            if (this.tape !== tape) return;
            if (e.cancel) this.clear();
            else if (e.name !== null) {
                if (e.initial) {
                    // Captured held state is not a new press. Older tapes remain transitions.
                    if (this.value(e.name) !== e.value) { this.values.set(e.name, e.value); this._emit(e.name, e.value, true); }
                } else this.set(e.name, e.value);
            }
            // A change listener may reset, stop or replace playback. Its new state wins.
            if (this.tape !== tape) return;
        }
        this.tick = tick;
        for (const [name, due] of this._pendingPressed) if (due <= tick) { this._pressed.add(name); this._pendingPressed.delete(name); }
        for (const [name, due] of this._pendingReleased) if (due <= tick) { this._released.add(name); this._pendingReleased.delete(name); }
        this._edgeTick = tick;
    }
}

/** @satisfies {Record<string, any>} */
const Collision2D = {
    /** @param {GameRect} a @param {GameRect} b */
    overlaps(a, b) { return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y; },
    circleRect(circle, rect) {
        const x = Math.max(rect.x, Math.min(rect.x + rect.w, circle.x));
        const y = Math.max(rect.y, Math.min(rect.y + rect.h, circle.y));
        return (x - circle.x) ** 2 + (y - circle.y) ** 2 <= circle.r ** 2;
    },
    /** @param {GameRect} area @param {GameRect[]} objects */
    query(area, objects) { return objects.filter(object => this.overlaps(area, object)); },
    // Swept AABB against a static rectangle: fraction of the displacement and contact normal.
    /** @param {GameRect} body @param {number} dx @param {number} dy @param {GameRect} wall */
    sweep(body, dx, dy, wall) {
        const axis = (min, max, lo, hi, d) => {
            if (!d) return max <= lo || min >= hi ? null : [-Infinity, Infinity];
            const a = (lo - max) / d, b = (hi - min) / d;
            return [Math.min(a, b), Math.max(a, b)];
        };
        const x = axis(body.x, body.x + body.w, wall.x, wall.x + wall.w, dx);
        const y = axis(body.y, body.y + body.h, wall.y, wall.y + wall.h, dy);
        if (!x || !y) return null;
        const entry = Math.max(x[0], y[0]), exit = Math.min(x[1], y[1]);
        if (entry < 0 || entry > 1 || entry > exit) return null;
        return { time: entry, nx: x[0] >= y[0] ? -Math.sign(dx) : 0, ny: y[0] > x[0] ? -Math.sign(dy) : 0, object: wall };
    },
    /** @param {{x:number,y:number}} origin @param {{x:number,y:number}} direction @param {number} distance @param {GameRect[]} objects */
    raycast(origin, direction, distance, objects) {
        if (!Number.isFinite(distance) || distance < 0) throw new RangeError('RAY_DISTANCE_INVALID');
        const length = Math.hypot(direction.x, direction.y);
        if (!length || !Number.isFinite(length)) return null;
        const dx = direction.x / length * distance, dy = direction.y / length * distance;
        let nearest = null;
        for (const object of objects) {
            const inside = origin.x >= object.x && origin.x <= object.x + object.w && origin.y >= object.y && origin.y <= object.y + object.h;
            const hit = inside ? { time: 0, nx: 0, ny: 0, object } : this.sweep({ ...origin, w: 0, h: 0 }, dx, dy, object);
            if (hit && (!nearest || hit.time < nearest.time)) nearest = hit;
        }
        return nearest ? { ...nearest, distance: nearest.time * distance, x: origin.x + nearest.time * dx, y: origin.y + nearest.time * dy } : null;
    }
};

/**
 * A game-space point index. Rebuild captures IDs/positions without changing entries.
 * @template {{id:string,x:number,y:number}} T
 */
class SpatialHash2D {
    /** @param {number} cellSize */
    constructor(cellSize) {
        if (!Number.isFinite(cellSize) || cellSize <= 0) throw new RangeError('SPATIAL_CELL_SIZE_INVALID');
        /** @private @type {number} */
        this._cellSize = cellSize;
        /** @private @type {Map<string, Array<{entry:T,id:string,x:number,y:number,cx:number,cy:number}>>} */
        this._buckets = new Map();
        /** @private @type {number} */
        this._size = 0;
    }
    get size() { return this._size; }
    /** @private @param {number} value */
    _cell(value) {
        const cell = Math.floor(value / this._cellSize);
        if (!Number.isSafeInteger(cell)) throw new RangeError('SPATIAL_CELL_COORDINATE_INVALID');
        return cell;
    }
    /** @param {readonly T[]} entries @returns {this} */
    rebuild(entries) {
        if (!Array.isArray(entries)) throw new TypeError('SPATIAL_ENTRIES_INVALID');
        const buckets = new Map(), ids = new Set();
        for (const entry of entries) {
            if (!entry || typeof entry.id !== 'string' || !entry.id ||
                !Number.isFinite(entry.x) || !Number.isFinite(entry.y)) throw new TypeError('SPATIAL_ENTRY_INVALID');
            const id = entry.id, x = entry.x, y = entry.y;
            if (ids.has(id)) throw new Error('SPATIAL_ID_DUPLICATE: ' + id);
            const cx = this._cell(x), cy = this._cell(y), key = cx + ',' + cy;
            ids.add(id);
            if (!buckets.has(key)) buckets.set(key, []);
            buckets.get(key).push({ entry, id, x, y, cx, cy });
        }
        this._buckets = buckets; this._size = entries.length;
        return this;
    }
    /** @returns {this} */
    clear() { this._buckets.clear(); this._size = 0; return this; }
    /** @private @param {number} x @param {number} y @param {number} radius @param {(entry:T)=>boolean} [filter] */
    _validateQuery(x, y, radius, filter) {
        if (![x, y, radius].every(Number.isFinite) || radius < 0) throw new RangeError('SPATIAL_QUERY_INVALID');
        if (filter != null && typeof filter !== 'function') throw new TypeError('SPATIAL_FILTER_INVALID');
    }
    /** @private @param {number} x @param {number} y @param {number} radius */
    *_candidates(x, y, radius) {
        const loX = Math.floor((x - radius) / this._cellSize), hiX = Math.floor((x + radius) / this._cellSize);
        const loY = Math.floor((y - radius) / this._cellSize), hiY = Math.floor((y + radius) / this._cellSize);
        const width = hiX - loX + 1, height = hiY - loY + 1;
        // Large/overflowing ranges scan occupied buckets, never an unbounded empty grid.
        if (![loX, hiX, loY, hiY, width, height].every(Number.isSafeInteger) ||
            width * height > this._buckets.size) {
            for (const bucket of this._buckets.values()) {
                const first = bucket[0];
                if (first.cx >= loX && first.cx <= hiX && first.cy >= loY && first.cy <= hiY) yield* bucket;
            }
        } else {
            // Counts are safe and bounded by occupied bucket count; no unsafe ++ cell loop.
            for (let i = 0; i < width; i++) for (let j = 0; j < height; j++) {
                const bucket = this._buckets.get((loX + i) + ',' + (loY + j));
                if (bucket) yield* bucket;
            }
        }
    }
    /** @param {number} x @param {number} y @param {number} radius
     * @param {(entry:T)=>boolean} [filter] @returns {T[]} */
    queryRadius(x, y, radius, filter) {
        this._validateQuery(x, y, radius, filter);
        const matches = [];
        for (const point of this._candidates(x, y, radius)) {
            const distance = Math.hypot(point.x - x, point.y - y);
            if (distance <= radius && (!filter || filter(point.entry))) matches.push({ point, distance });
        }
        matches.sort((a, b) => a.distance - b.distance || (a.point.id < b.point.id ? -1 : a.point.id > b.point.id ? 1 : 0));
        return matches.map(match => match.point.entry);
    }
    /** Bounded nearest selection; retains only count entries while visiting occupied cells.
     * @param {number} x @param {number} y @param {number} radius @param {number} count
     * @param {(entry:T)=>boolean} [filter] @returns {T[]} */
    nearestN(x, y, radius, count, filter) {
        this._validateQuery(x, y, radius, filter);
        if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('SPATIAL_COUNT_INVALID');
        if (count === 0) return [];
        const heap = [];
        const compare = (a, b) => a.distance - b.distance || (a.point.id < b.point.id ? -1 : a.point.id > b.point.id ? 1 : 0);
        for (const point of this._candidates(x, y, radius)) {
            const distance = Math.hypot(point.x - x, point.y - y);
            if (distance > radius || filter && !filter(point.entry)) continue;
            const candidate = { point, distance };
            if (heap.length < count) {
                heap.push(candidate); let child = heap.length - 1;
                while (child > 0) {
                    const parent = Math.floor((child - 1) / 2);
                    if (compare(heap[child], heap[parent]) <= 0) break;
                    [heap[child], heap[parent]] = [heap[parent], heap[child]]; child = parent;
                }
            } else if (compare(candidate, heap[0]) < 0) {
                heap[0] = candidate; let parent = 0;
                while (parent * 2 + 1 < heap.length) {
                    let child = parent * 2 + 1;
                    if (child + 1 < heap.length && compare(heap[child + 1], heap[child]) > 0) child++;
                    if (compare(heap[parent], heap[child]) >= 0) break;
                    [heap[parent], heap[child]] = [heap[child], heap[parent]]; parent = child;
                }
            }
        }
        heap.sort(compare); return heap.map(match => match.point.entry);
    }
    /** @param {number} x @param {number} y @param {number} radius
     * @param {(entry:T)=>boolean} [filter] @returns {T|null} */
    nearest(x, y, radius, filter) {
        this._validateQuery(x, y, radius, filter);
        let nearest = null, bestDistance = Infinity;
        for (const point of this._candidates(x, y, radius)) {
            const distance = Math.hypot(point.x - x, point.y - y);
            if (distance <= radius && (!filter || filter(point.entry)) &&
                (distance < bestDistance || distance === bestDistance && (!nearest || point.id < nearest.id))) {
                nearest = point; bestDistance = distance;
            }
        }
        return nearest ? nearest.entry : null;
    }
}

class CharacterController {
    /** @param {GameRect} body @param {{speed?:number, solids?:GameRect[]}} [options] */
    constructor(body, options = {}) {
        if (![body.x, body.y, body.w, body.h].every(Number.isFinite) || body.w <= 0 || body.h <= 0) throw new Error('CHARACTER_BODY_INVALID');
        this.body = body; this.speed = options.speed == null ? 180 : options.speed;
        if (!Number.isFinite(this.speed) || this.speed < 0) throw new Error('CHARACTER_SPEED_INVALID');
        this.solids = options.solids || [];
    }
    // Top-down motion: normalize diagonal input and slide along static AABB walls.
    update(direction, dt) {
        if (![direction.x, direction.y, dt].every(Number.isFinite) || dt < 0) throw new Error('CHARACTER_STEP_INVALID');
        const n = Math.max(1, Math.hypot(direction.x, direction.y));
        return this.move(direction.x / n * this.speed * dt, direction.y / n * this.speed * dt);
    }
    move(dx, dy) {
        if (![dx, dy].every(Number.isFinite)) throw new Error('CHARACTER_MOVE_INVALID');
        const body = this.body, x = body.x, y = body.y, hits = [];
        // Resolve existing overlap before sweeping (spawn/teleport inside a wall).
        for (let pass = 0; pass < 4; pass++) {
            let changed = false;
            for (const wall of this.solids) if (wall !== body && Collision2D.overlaps(body, wall)) {
                const candidates = [
                    { x: wall.x - body.x - body.w, y: 0 }, { x: wall.x + wall.w - body.x, y: 0 },
                    { x: 0, y: wall.y - body.y - body.h }, { x: 0, y: wall.y + wall.h - body.y }
                ];
                candidates.sort((a, b) => Math.abs(a.x + a.y) - Math.abs(b.x + b.y));
                body.x += candidates[0].x; body.y += candidates[0].y; changed = true;
            }
            if (!changed) break;
        }
        for (let pass = 0; pass < 3 && (dx || dy); pass++) {
            let nearest = null;
            for (const wall of this.solids) {
                if (wall === body) continue;
                const hit = Collision2D.sweep(body, dx, dy, wall);
                if (hit && (!nearest || hit.time < nearest.time)) nearest = hit;
            }
            if (!nearest) { body.x += dx; body.y += dy; break; }
            body.x += dx * nearest.time; body.y += dy * nearest.time;
            hits.push(nearest);
            dx *= 1 - nearest.time; dy *= 1 - nearest.time;
            if (nearest.nx) dx = 0;
            if (nearest.ny) dy = 0;
        }
        return { x: body.x - x, y: body.y - y, hits };
    }
}

class TickTimers {
    constructor() { this.tick = 0; this.nextId = 1; this.tasks = new Map(); }
    _add(delay, interval, callback) {
        if (!Number.isSafeInteger(delay) || delay < 1 || typeof callback !== 'function') throw new Error('TIMER_INVALID');
        const id = this.nextId++;
        this.tasks.set(id, { id, due: this.tick + delay, interval, callback });
        return id;
    }
    after(ticks, callback) { return this._add(ticks, 0, callback); }
    every(ticks, callback) { return this._add(ticks, ticks, callback); }
    cancel(id) { return this.tasks.delete(id); }
    clear() { this.tasks.clear(); }
    step(count = 1) {
        if (!Number.isSafeInteger(count) || count < 0 || count > 36000) throw new Error('TIMER_STEP_INVALID');
        for (let i = 0; i < count; i++) {
            this.tick++;
            const due = [...this.tasks.values()].filter(task => task.due <= this.tick).sort((a, b) => a.due - b.due || a.id - b.id);
            for (const task of due) if (this.tasks.has(task.id)) {
                if (task.interval) task.due += task.interval; else this.tasks.delete(task.id);
                task.callback(this.tick, task.id);
            }
        }
    }
}

class Tween {
    /** @param {Record<string,number>} target @param {Record<string,number>} to @param {number} duration
     * @param {{ease?:'linear'|'smoothstep', onComplete?:()=>void}} [options] */
    constructor(target, to, duration, options = {}) {
        if (!Number.isFinite(duration) || duration < 0) throw new Error('TWEEN_DURATION_INVALID');
        if (options.ease && !['linear', 'smoothstep'].includes(options.ease)) throw new Error('TWEEN_EASE_INVALID');
        this.target = target; this.to = { ...to }; this.from = {};
        for (const key of Object.keys(to)) {
            if (!Number.isFinite(to[key]) || !Number.isFinite(target[key])) throw new Error('TWEEN_VALUE_INVALID');
            this.from[key] = target[key];
        }
        this.duration = duration; this.elapsed = 0; this.done = false; this.cancelled = false; this.options = options;
    }
    update(dt) {
        if (!Number.isFinite(dt) || dt < 0) throw new Error('TWEEN_DT_INVALID');
        if (this.done || this.cancelled) return this.done;
        this.elapsed = Math.min(this.duration, this.elapsed + dt);
        let p = this.duration ? this.elapsed / this.duration : 1;
        if (this.options.ease === 'smoothstep') p = p * p * (3 - 2 * p);
        for (const key of Object.keys(this.to)) this.target[key] = this.from[key] + (this.to[key] - this.from[key]) * p;
        if (this.elapsed === this.duration) { this.done = true; if (this.options.onComplete) this.options.onComplete(); }
        return this.done;
    }
    cancel() { this.cancelled = true; }
}

class StateMachine {
    /** @param {Record<string,{enter?:(context:any,previous:string)=>void, exit?:(context:any,next:string)=>void, update?:(context:any,dt:number)=>void}>} states */
    constructor(states, initial, context = {}) {
        this.states = states; this.context = context; this.current = ''; this.transitioning = false;
        this.set(initial);
    }
    set(name) {
        if (!Object.prototype.hasOwnProperty.call(this.states, name)) throw new Error('STATE_UNKNOWN: ' + name);
        if (this.transitioning) throw new Error('STATE_REENTRANT_TRANSITION');
        if (this.current === name) return;
        const previous = this.current, before = this.states[previous], next = this.states[name];
        this.transitioning = true;
        try {
            if (before && before.exit) before.exit(this.context, name);
            this.current = name;
            if (next.enter) next.enter(this.context, previous);
        } finally { this.transitioning = false; }
    }
    update(dt) {
        if (!Number.isFinite(dt) || dt < 0) throw new Error('STATE_DT_INVALID');
        const state = this.states[this.current];
        if (state.update) state.update(this.context, dt);
    }
}

/** @satisfies {Record<string, any>} */
const SaveGame = {
    _key(key) { if (typeof key !== 'string' || !key) throw new Error('SAVE_KEY_INVALID'); return 'aigameengine:save:' + key; },
    _backupKey(key) { this._key(key); return 'aigameengine:save-backup:' + key; },
    save(key, data, version = 1) {
        if (!Number.isSafeInteger(version) || version < 1) throw new Error('SAVE_VERSION_INVALID');
        const primary = this._key(key), backup = this._backupKey(key);
        let raw;
        try {
            raw = JSON.stringify({ format: 'ArcSave', version, data }, (name, value) => {
                if (typeof value === 'number' && !Number.isFinite(value) || ['undefined', 'function', 'symbol', 'bigint'].includes(typeof value)) {
                    throw new Error('Save data must contain only finite JSON values');
                }
                return value;
            });
            if (data === undefined) return { ok: false, code: 'SAVE_DATA_INVALID' };
        } catch (e) { return { ok: false, code: 'SAVE_DATA_INVALID', message: String(e) }; }
        // Each Store write is atomic, but two keys are not a transaction. Commit primary
        // first so a failed save never publishes an uncommitted recovery candidate.
        try { if (!Store.set(primary, raw)) return { ok: false, code: 'SAVE_UNAVAILABLE' }; }
        catch (e) { return { ok: false, code: 'SAVE_UNAVAILABLE', message: String(e) }; }
        try { if (Store.set(backup, raw)) return { ok: true, backup: true }; }
        catch (e) { /* The primary is already saved; retain the preceding backup. */ }
        return { ok: true, backup: false, warning: 'SAVE_BACKUP_UNAVAILABLE' };
    },
    /** @param {string} key @param {{version?:number,migrations?:Record<number,(data:any)=>any>,validate?:(data:any)=>boolean}} [options] */
    load(key, options = {}) {
        return this._read(Store.get(this._key(key)), options);
    },
    // Import one explicitly selected namespace; never enumerate storage or alter the source.
    /** @param {string} key @param {string} sourceNamespace
     * @param {{version?:number,migrations?:Record<number,(data:any)=>any>,validate?:(data:any)=>boolean}} [options] */
    importSlot(key, sourceNamespace, options = {}) {
        const primary = this._key(key), backup = this._backupKey(key);
        if (typeof sourceNamespace !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(sourceNamespace)) throw new Error('SAVE_NAMESPACE_INVALID');
        let raw;
        try {
            if (Store.get(primary) != null || Store.get(backup) != null) return { ok: false, code: 'SAVE_DESTINATION_EXISTS' };
            raw = Store.get(sourceNamespace + ':save:' + key);
        } catch (e) { return { ok: false, code: 'SAVE_UNAVAILABLE', message: String(e) }; }
        const source = this._read(raw, options);
        if (!source.ok) return source;
        // User callbacks may have populated the destination during validation.
        try {
            if (Store.get(primary) != null || Store.get(backup) != null) return { ok: false, code: 'SAVE_DESTINATION_EXISTS' };
        } catch (e) { return { ok: false, code: 'SAVE_UNAVAILABLE', message: String(e) }; }
        const saved = this.save(key, source.data, source.version);
        return saved.ok ? { ...saved, imported: true, version: source.version } : saved;
    },
    // Recovery is explicit and read-only. Validate/migrate a copy, then the game chooses
    // whether to apply it and save again. Corrupt primary bytes are preserved until then.
    /** @param {string} key @param {{version?:number,migrations?:Record<number,(data:any)=>any>,validate?:(data:any)=>boolean}} [options] */
    recover(key, options = {}) {
        const result = this._read(Store.get(this._backupKey(key)), options);
        if (!result.ok && result.code === 'SAVE_MISSING') result.code = 'SAVE_BACKUP_MISSING';
        else if (!result.ok && result.code === 'SAVE_CORRUPT') result.code = 'SAVE_BACKUP_CORRUPT';
        return { ...result, source: 'backup' };
    },
    /** @param {string|null} raw @param {{version?:number,migrations?:Record<number,(data:any)=>any>,validate?:(data:any)=>boolean}} options */
    _read(raw, options) {
        const wanted = options.version == null ? 1 : options.version;
        if (!Number.isSafeInteger(wanted) || wanted < 1) throw new Error('SAVE_VERSION_INVALID');
        if (raw == null) return { ok: false, code: 'SAVE_MISSING' };
        try {
            const envelope = JSON.parse(raw);
            if (!envelope || envelope.format !== 'ArcSave' || !Number.isSafeInteger(envelope.version) || envelope.version < 1 ||
                !Object.prototype.hasOwnProperty.call(envelope, 'data')) return { ok: false, code: 'SAVE_CORRUPT' };
            if (envelope.version > wanted) return { ok: false, code: 'SAVE_FUTURE_VERSION' };
            let data = envelope.data;
            for (let v = envelope.version; v < wanted; v++) {
                const migrate = options.migrations && options.migrations[v];
                if (!migrate) return { ok: false, code: 'SAVE_MIGRATION_MISSING', version: v };
                data = migrate(data);
            }
            if (options.validate && !options.validate(data)) return { ok: false, code: 'SAVE_VALIDATION_FAILED' };
            return { ok: true, data, version: wanted };
        } catch (e) { return { ok: false, code: 'SAVE_CORRUPT', message: String(e) }; }
    },
    remove(key) { Store.remove(this._key(key)); Store.remove(this._backupKey(key)); }
};

class ObjectPool {
    /** @param {()=>any} create @param {{max?:number,activate?:(item:any,...args:any[])=>void,reset?:(item:any)=>void,destroy?:(item:any)=>void}} [options] */
    constructor(create, options = {}) {
        this.create = create; this.options = options;
        this.max = options.max == null ? Infinity : options.max;
        if (!(this.max === Infinity || Number.isSafeInteger(this.max) && this.max >= 0)) throw new Error('POOL_LIMIT_INVALID');
        this.free = []; this.active = new Set(); this.disposed = false;
    }
    acquire(...args) {
        if (this.disposed) throw new Error('POOL_DISPOSED');
        if (!this.free.length && this.active.size >= this.max) return null;
        const item = this.free.length ? this.free.pop() : this.create();
        try { if (this.options.activate) this.options.activate(item, ...args); }
        catch (error) { this.free.push(item); throw error; }
        this.active.add(item); return item;
    }
    release(item) {
        if (!this.active.has(item)) return false;
        if (this.options.reset) this.options.reset(item);
        this.active.delete(item); this.free.push(item); return true;
    }
    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        const items = [...this.active, ...this.free]; this.active.clear(); this.free = [];
        let failure = null;
        if (this.options.destroy) for (const item of items) {
            try { this.options.destroy(item); } catch (error) { if (!failure) failure = error; }
        }
        if (failure) throw failure;
    }
}

class GridNavigation {
    /** @param {number} width @param {number} height @param {(x:number,y:number)=>boolean} [blocked] */
    constructor(width, height, blocked = () => false) {
        if (![width, height].every(v => Number.isSafeInteger(v) && v > 0) || width * height > 10000000) throw new Error('GRID_SIZE_INVALID');
        this.width = width; this.height = height; this.blocked = blocked;
    }
    _open(x, y) { return x >= 0 && y >= 0 && x < this.width && y < this.height && !this.blocked(x, y); }
    /** @param {{x:number,y:number}} start @param {{x:number,y:number}} goal @param {{diagonal?:boolean,maxVisited?:number}} [options] */
    findPath(start, goal, options = {}) {
        if (![start.x, start.y, goal.x, goal.y].every(Number.isInteger)) throw new Error('GRID_POINT_INVALID');
        if (!this._open(start.x, start.y) || !this._open(goal.x, goal.y)) return [];
        const max = options.maxVisited == null ? this.width * this.height : options.maxVisited;
        if (!Number.isSafeInteger(max) || max < 1) throw new Error('GRID_BUDGET_INVALID');
        const key = (x, y) => y * this.width + x;
        const heuristic = (x, y) => {
            const dx = Math.abs(goal.x - x), dy = Math.abs(goal.y - y);
            return options.diagonal ? Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy) : dx + dy;
        };
        const heap = [], best = new Map(), closed = new Set(), parents = new Map();
        const less = (a, b) => a.f < b.f || a.f === b.f && (a.h < b.h || a.h === b.h && a.key < b.key);
        const push = node => {
            let i = heap.length; heap.push(node);
            while (i > 0) { const p = (i - 1) >> 1; if (!less(node, heap[p])) break; heap[i] = heap[p]; i = p; }
            heap[i] = node;
        };
        const pop = () => {
            const first = heap[0], last = heap.pop();
            if (heap.length) {
                let i = 0;
                while (i * 2 + 1 < heap.length) {
                    let c = i * 2 + 1;
                    if (c + 1 < heap.length && less(heap[c + 1], heap[c])) c++;
                    if (!less(heap[c], last)) break;
                    heap[i] = heap[c]; i = c;
                }
                heap[i] = last;
            }
            return first;
        };
        const startKey = key(start.x, start.y), goalKey = key(goal.x, goal.y);
        best.set(startKey, 0);
        push({ ...start, key: startKey, g: 0, h: heuristic(start.x, start.y), f: heuristic(start.x, start.y) });
        const dirs = options.diagonal ? [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]] : [[1, 0], [0, 1], [-1, 0], [0, -1]];
        while (heap.length && closed.size < max) {
            const node = pop();
            if (closed.has(node.key)) continue;
            if (node.key === goalKey) {
                const path = [];
                for (let k = goalKey; k != null; k = parents.get(k)) path.push({ x: k % this.width, y: Math.floor(k / this.width) });
                return path.reverse();
            }
            closed.add(node.key);
            for (const [dx, dy] of dirs) {
                const x = node.x + dx, y = node.y + dy, k = key(x, y);
                if (!this._open(x, y) || closed.has(k) || dx && dy && (!this._open(node.x + dx, node.y) || !this._open(node.x, node.y + dy))) continue;
                const g = node.g + (dx && dy ? Math.SQRT2 : 1);
                if (best.has(k) && best.get(k) <= g) continue;
                const h = heuristic(x, y); best.set(k, g); parents.set(k, node.key);
                push({ x, y, key: k, g, h, f: g + h });
            }
        }
        return [];
    }
}
