// Runtime.js — application ownership, reproducible state and lifecycle.
/**
 * @typedef {Object} ArcAppOptions
 * @property {HTMLCanvasElement} canvas
 * @property {LocationObjectDef[]} [objects]
 * @property {UIRecord[]} [layout]
 * @property {(app:ArcApp)=>any} [gameFactory]
 * @property {boolean} [autoStart]
 * @property {boolean} [cameraInput] Attach built-in camera controls while running (default true).
 * @property {boolean} [physicsEnabled] Enable fixed-step physics (default from PHYSICS_ENABLED).
 * @property {number} [physicsGravity] Vertical acceleration in centimeters per second squared.
 * @property {number} [seed]
 * @property {number} [hz]
 * @property {number} [maxSteps]
 * @property {string} [levelId]
 */
class ArcApp {
    /** @param {ArcAppOptions} options */
    constructor(options) {
        this.options = options;
        this.canvas = options.canvas;
        this.clock = new ArcClock(options);
        /** @type {ArcAppState} */ this.state = 'loading';
        this.levelId = options.levelId || 'sample';
        this.error = null;
        this.diagnostics = [];
        /** @type {Location3D | null} */ this.location = null;
        /** @type {CameraController | null} */ this.camera = null;
        /** @type {ArcPhysicsWorld | null} */ this.physics = null;
        /** @type {any} */ this.game = null;
        this.actions = [];
        this.recording = false;
        this._generation = 0;
        this._last = 0;
        this._resumeAfterVisibility = false;
        this._resumeAfterModal = false;
        this._lifecyclePausing = false;
        this._replaying = false;
        this._modalUnsubscribe = null;
        this._cancelPrepare = null;
        this._physicsChange = null;
        this.metrics = { ticks: 0, simulationMs: 0, renderMs: 0, frames: 0 };
        if (!World3D.init(this.canvas)) throw new Error('WEBGL_UNAVAILABLE');
        this.contextLost = false;
        /** @type {Array<() => void>} */ this._contextObservers = [];
        const engine = World3D.engine;
        if (engine.onContextLostObservable && engine.onContextRestoredObservable) {
            const lost = engine.onContextLostObservable.add(() => {
                this.contextLost = true;
                if (this.state === 'running') this._resumeAfterContext = true;
                this._pauseForLifecycle();
            });
            const restored = engine.onContextRestoredObservable.add(() => {
                this.contextLost = false;
                if (this._resumeAfterContext && this.state !== 'disposed') {
                    this._resumeAfterContext = false;
                    this._resumeForLifecycle();
                }
            });
            this._contextObservers.push(() => engine.onContextLostObservable.remove(lost), () => engine.onContextRestoredObservable.remove(restored));
        }
        this._frame = () => this.frame(performance.now());
        this._resize = () => World3D.resize();
        this._visibility = () => {
            if (document.hidden) {
                if (this.state === 'running') this._resumeAfterVisibility = true;
                if (this.state === 'running') this._pauseForLifecycle();
            } else if (this._resumeAfterVisibility) {
                this._resumeAfterVisibility = false;
                this._resumeForLifecycle();
            }
        };
        window.addEventListener('resize', this._resize);
        document.addEventListener('visibilitychange', this._visibility);
        World3D.engine.runRenderLoop(this._frame);
        this.ready = this._load(options);
    }

    async _load(options) {
        const generation = ++this._generation;
        this.state = 'loading';
        try {
            const physicsEnabled = options.physicsEnabled == null ? !!(Object.hasOwn(ArcConfig.fields, 'PHYSICS_ENABLED') && ArcConfig.get('PHYSICS_ENABLED')) : options.physicsEnabled;
            const gravity = options.physicsGravity == null ? (Object.hasOwn(ArcConfig.fields, 'PHYSICS_GRAVITY') ? ArcConfig.get('PHYSICS_GRAVITY') : -981) : options.physicsGravity;
            if (typeof physicsEnabled !== 'boolean' || !Number.isFinite(gravity)) throw new Error('PHYSICS_OPTIONS_INVALID');
            if (typeof ArcSchema !== 'undefined') {
                const findings = [...ArcSchema.validateObjects(options.objects || []), ...ArcSchema.validateUI(options.layout || [])];
                if (findings.length) { this.diagnostics = findings; throw new Error('LEVEL_DATA_INVALID: ' + findings.map(d => d.field).join(', ')); }
            }
            const defs = typeof ArcSchema !== 'undefined' ? ArcSchema.migrateObjects(options.objects || []).objects : JSON.parse(JSON.stringify(options.objects || []));
            const location = this.location = new Location3D({ objects: defs });
            if (typeof ArcPhysicsWorld !== 'undefined') {
                this.physics = new ArcPhysicsWorld(location.view.scene, { gravity });
                location.physics = this.physics;
                this.physics.registerLocation(location);
            } else if (physicsEnabled) throw new Error('PHYSICS_UNAVAILABLE');
            const clockAPI = /** @type {any} */ (Gltf3D);
            if (clockAPI.setManualClock) clockAPI.setManualClock(location.view.scene, true);
            this.camera = new CameraController(location.view, { terrain: location.terrain, bounds: { w: location.width, h: location.height } });
            UI.init(this.canvas, options.layout);
            if (UI.onModalChange) this._modalUnsubscribe = UI.onModalChange(active => {
                // Replay owns stepping; modal presentation must not start the live loop.
                if (this._replaying) return;
                if (active) {
                    if (this.state === 'running') this._resumeAfterModal = true;
                    if (this.state === 'running') this._pauseForLifecycle();
                } else if (this._resumeAfterModal) {
                    this._resumeAfterModal = false;
                    this._resumeForLifecycle();
                }
            });
            const loaded = await location.ready;
            if (loaded === false || !this._isCurrent(generation)) return null;
            if (physicsEnabled) {
                const physics = this.physics;
                const prepared = await this._changePhysics(() => physics.setEnabled(true), generation);
                if (!prepared || !this._isCurrent(generation)) return null;
            }
            const game = (options.gameFactory || (app => new Game(app)))(this);
            if (!this._isCurrent(generation)) {
                if (game && game.dispose) game.dispose();
                return null;
            }
            this.game = game;
            if (game && typeof game.prepare === 'function') {
                const controller = new AbortController(), cancelled = {};
                let cancel;
                const cancellation = new Promise(resolve => { cancel = () => { resolve(cancelled); controller.abort(); }; });
                this._cancelPrepare = cancel;
                // Race even a non-cooperative loader: old ready must settle on level disposal.
                // The loader still owns cleanup after every await and must check the signal.
                const preparation = Promise.resolve().then(() => {
                    if (controller.signal.aborted) return cancelled;
                    return game.prepare({ signal: controller.signal });
                });
                const result = await Promise.race([preparation, cancellation]);
                if (!this._isCurrent(generation) || result === cancelled) return null;
            }
            this.diagnostics = this.validate();
            if (this.diagnostics.some(d => d.severity === 'error')) throw new Error('GAME_CONTRACT_INVALID: ' + this.diagnostics.map(d => d.code).join(', '));
            this.state = 'ready';
            this._last = 0;
            if (options.autoStart !== false) {
                if (document.hidden) this._resumeAfterVisibility = true;
                else if (UI.hasModal) this._resumeAfterModal = true;
                else this.start();
            }
            return this;
        } catch (error) {
            if (!this._isCurrent(generation)) return null;
            this.state = 'error';
            this.error = (error && error.message) || String(error);
            // Failed preparation owns resources just like a cancelled level.
            try { this._releaseLevel(); } catch (cleanupError) { console.error('ArcApp cleanup:', cleanupError); }
            throw error;
        }
    }

    _isCurrent(generation) { return generation === this._generation && this.state !== 'disposed'; }

    // A cancelled level settles even when a backend loader ignores its cancellation.
    async _changePhysics(operation, generation) {
        const cancelled = {};
        let cancel;
        const cancellation = new Promise(resolve => { cancel = () => resolve(cancelled); });
        const change = this._physicsChange = { cancel };
        try {
            const preparation = Promise.resolve().then(() => this._isCurrent(generation) ? operation() : cancelled);
            const result = await Promise.race([preparation, cancellation]);
            return result === cancelled || !this._isCurrent(generation) ? null : result;
        } finally {
            if (this._physicsChange === change) this._physicsChange = null;
        }
    }

    /** @param {boolean} enabled @returns {Promise<ArcApp | null>} */
    async setPhysicsEnabled(enabled) {
        if (typeof enabled !== 'boolean') throw new Error('PHYSICS_ENABLED_INVALID');
        if (this.state !== 'paused' && this.state !== 'ready') throw new Error('PAUSE_BEFORE_PHYSICS_CHANGE');
        if (this.contextLost) throw new Error('WEBGL_CONTEXT_LOST');
        if (this._physicsChange) throw new Error('PHYSICS_LOADING');
        if (!this.physics) throw new Error('PHYSICS_UNAVAILABLE');
        const generation = this._generation, physics = this.physics;
        const result = await this._changePhysics(() => physics.setEnabled(enabled), generation);
        if (!result || !this._isCurrent(generation) || this.physics !== physics) return null;
        this.options = { ...this.options, physicsEnabled: enabled };
        this._last = 0;
        return this;
    }

    start() {
        if (this._physicsChange) throw new Error('PHYSICS_LOADING');
        if (this.state === 'running') return this;
        if (this.state !== 'ready' && this.state !== 'paused') throw new Error('APP_NOT_READY');
        if (this.contextLost) throw new Error('WEBGL_CONTEXT_LOST');
        if (this._replaying) return this;
        if (UI.hasModal) { this._resumeAfterModal = true; return this; }
        this.state = 'running'; this._last = 0;
        if (this.options.cameraInput !== false) this.camera.attach(this.canvas);
        return this;
    }
    pause() {
        // An explicit caller pause overrides every deferred automatic resume.
        if (!this._lifecyclePausing) {
            this._resumeAfterVisibility = false;
            this._resumeAfterModal = false;
            this._resumeAfterContext = false;
        }
        if (this.state === 'running' || this.state === 'ready') {
            this.state = 'paused'; this._last = 0;
            this.camera.detach();
        }
        return this;
    }
    /** @private */
    _pauseForLifecycle() {
        // Preserve the public pause boundary: game-owned wrappers fence Workers.
        const previous = this._lifecyclePausing;
        this._lifecyclePausing = true;
        try { return this.pause(); }
        finally { this._lifecyclePausing = previous; }
    }
    /** @private */
    _resumeForLifecycle() {
        // Transfer an existing resume intent until every lifecycle blocker clears.
        if (this.state === 'disposed') return this;
        if (this.contextLost) { this._resumeAfterContext = true; return this; }
        if (document.hidden) { this._resumeAfterVisibility = true; return this; }
        return this.resume();
    }
    resume() { return this.start(); }
    random() { return this.clock.random(); }

    frame(now) {
        if (this.state === 'disposed') return;
        const generation = this._generation;
        const elapsed = this._last ? Math.max(0, (now - this._last) / 1000) : 0;
        this._last = now;
        try {
            if (this.state === 'running') this.clock.advance(elapsed, dt => this._tick(dt));
            if (!this._isCurrent(generation)) return;
            const t = performance.now();
            World3D.renderFrame();
            this.metrics.renderMs += performance.now() - t;
            this.metrics.frames++;
        } catch (error) {
            if (!this._isCurrent(generation)) return;
            this.state = 'error';
            this.error = (error && error.message) || String(error);
            if (this.camera) this.camera.detach();
            console.error('ArcApp:', error);
        }
    }

    _tick(dt) {
        const generation = this._generation, state = this.state;
        if (!this.game || state === 'disposed' || state === 'loading' || state === 'error') return false;
        const t = performance.now();
        this.game.update(dt);
        if (!this._isCurrent(generation) || this.state !== state || this._physicsChange) return false;
        if (this.physics) this.physics.step(dt);
        if (!this._isCurrent(generation) || this.state !== state) return false;
        this.location.update(dt);
        this.camera.update(dt);
        const clockAPI = /** @type {any} */ (Gltf3D);
        if (clockAPI.advance) clockAPI.advance(this.location.view.scene, dt);
        Sound3D.update(this.camera);
        this.metrics.ticks++;
        this.metrics.simulationMs += performance.now() - t;
        return true;
    }

    advanceTicks(count, render = true) {
        if (this._physicsChange) throw new Error('PHYSICS_LOADING');
        if (this.state !== 'paused' && this.state !== 'ready') throw new Error('PAUSE_BEFORE_STEPPING');
        if (this.contextLost) throw new Error('WEBGL_CONTEXT_LOST');
        const tick = this.clock.advanceTicks(count, dt => this._tick(dt));
        if (render) World3D.renderFrame();
        return tick;
    }

    action(name, value) {
        if (this._physicsChange) throw new Error('PHYSICS_LOADING');
        if (!this.game || !['ready', 'running', 'paused'].includes(this.state)) throw new Error('APP_NOT_READY');
        if (typeof this.game.action !== 'function') throw new Error('GAME_ACTION_UNSUPPORTED');
        const payload = value == null ? value : JSON.parse(JSON.stringify(value));
        const result = this.game.action(name, payload);
        if (this.recording) this.actions.push({ tick: this.clock.tick, name, value: payload });
        return result;
    }
    startRecording() { const initial = this.snapshot(); this.actions = []; this.recording = true; return initial; }
    stopRecording() { this.recording = false; return JSON.parse(JSON.stringify(this.actions)); }
    replay(actions, untilTick) {
        if (this._physicsChange) throw new Error('PHYSICS_LOADING');
        if (this.state !== 'paused' && this.state !== 'ready') throw new Error('PAUSE_BEFORE_REPLAY');
        if (this.contextLost) throw new Error('WEBGL_CONTEXT_LOST');
        if (!Array.isArray(actions)) throw new Error('REPLAY_INVALID');
        let last = this.clock.tick;
        for (const a of actions) {
            if (!a || !Number.isSafeInteger(a.tick) || a.tick < last || a.tick - last > 36000 || typeof a.name !== 'string') throw new Error('REPLAY_ORDER_INVALID');
            last = a.tick;
        }
        if (untilTick != null && (!Number.isSafeInteger(untilTick) || untilTick < last || untilTick - last > 36000)) throw new Error('REPLAY_END_INVALID');
        const recording = this.recording, replaying = this._replaying, generation = this._generation;
        this.recording = false; this._replaying = true;
        try {
            for (const a of actions) {
                this.advanceTicks(a.tick - this.clock.tick, false);
                this.action(a.name, a.value);
            }
            if (untilTick != null) this.advanceTicks(untilTick - this.clock.tick, false);
        } finally {
            this.recording = recording; this._replaying = replaying;
            // Keep an existing resume intent only while its modal is still open.
            // A replaced level owns its own pending intent.
            if (this._isCurrent(generation) && !UI.hasModal) this._resumeAfterModal = false;
        }
        World3D.renderFrame();
        return this.snapshot();
    }

    snapshot() {
        if (this._physicsChange) throw new Error('PHYSICS_LOADING');
        if (!this.game || !this.location || !['ready', 'running', 'paused'].includes(this.state)) throw new Error('APP_NOT_READY');
        const c = this.camera, clockAPI = /** @type {any} */ (Gltf3D);
        return JSON.parse(JSON.stringify({
            schemaVersion: 1, engineVersion: AIGameEngine.version, levelId: this.levelId,
            clock: this.clock.snapshot(), game: this.game.snapshot ? this.game.snapshot() : null,
            objects: this.location.objects.map(r => ({ def: r.def, spinAngle: r.spin ? r.spin.angle : null })),
            camera: { target: c.target, azimuth: c.azimuth, pitch: c.pitch, zoom: c.zoom, zoomTarget: c.zoomTarget, lift: c.lift },
            animations: clockAPI.snapshot ? clockAPI.snapshot(this.location.view.scene) : null,
            physics: this.physics ? this.physics.snapshot() : null
        }));
    }

    /** @param {any} snapshot @returns {any} */
    #validateSnapshotData(snapshot) {
        // Schema 1 is shared by these API-1 runtime versions. Payload and asset
        // validators below still apply before any owner state can change.
        if (!snapshot || snapshot.schemaVersion !== 1 || AIGameEngine.apiVersion !== 1 ||
            (snapshot.engineVersion !== AIGameEngine.version && !(AIGameEngine.version === '0.7.0' && ['0.5.0', '0.6.0'].includes(snapshot.engineVersion))) ||
            snapshot.levelId !== this.levelId ||
            !Array.isArray(snapshot.objects) || snapshot.objects.length !== this.location.objects.length) throw new Error('SNAPSHOT_INCOMPATIBLE');
        const clock = new ArcClock({ hz: this.clock.hz }); clock.restore(snapshot.clock);
        const c = snapshot.camera;
        if (!c || !c.target || ![c.target.x, c.target.y, c.target.h, c.azimuth, c.pitch, c.zoom, c.zoomTarget, c.lift].every(Number.isFinite) || c.zoom <= 0 || c.zoomTarget <= 0) throw new Error('SNAPSHOT_CAMERA_INVALID');
        for (let i = 0; i < snapshot.objects.length; i++) {
            const item = snapshot.objects[i], existing = this.location.objects[i].def;
            if (!item || !item.def || item.def.model !== existing.model || item.def.id !== existing.id ||
                JSON.stringify(item.def.prefab || null) !== JSON.stringify(existing.prefab || null)) throw new Error('SNAPSHOT_ASSET_MISMATCH');
            if (JSON.stringify(item.def.physics || null) !== JSON.stringify(existing.physics || null) ||
                existing.physics && JSON.stringify(item.def.scale) !== JSON.stringify(existing.scale)) throw new Error('SNAPSHOT_PHYSICS_MISMATCH');
            if (item.spinAngle !== null && !Number.isFinite(item.spinAngle)) throw new Error('SNAPSHOT_SPIN_INVALID');
        }
        if (typeof ArcSchema !== 'undefined' && ArcSchema.validateObjects(snapshot.objects.map(item => item.def)).length) throw new Error('SNAPSHOT_OBJECT_INVALID');
        if (this.game.validateSnapshot) this.game.validateSnapshot(snapshot.game);
        const clockAPI = /** @type {any} */ (Gltf3D);
        if (snapshot.animations && clockAPI.validateSnapshot) clockAPI.validateSnapshot(this.location.view.scene, snapshot.animations);
        if (this.physics) {
            this.physics.validateSnapshot(snapshot.physics);
            if (snapshot.physics) {
                const hidden = new Map(snapshot.physics.bodies.map(body => [body.id, body.hidden]));
                for (const item of snapshot.objects) {
                    if (hidden.has(item.def.id) && hidden.get(item.def.id) !== !!item.def.hidden) throw new Error('SNAPSHOT_PHYSICS_HIDDEN_MISMATCH');
                }
            }
        }
        else if (snapshot.physics != null) throw new Error('SNAPSHOT_PHYSICS_UNAVAILABLE');
        return { clockAPI, c };
    }
    // Validation uses a temporary clock and does not enter the restore mutation path.
    /** @param {any} snapshot @returns {true} */
    validateSnapshot(snapshot) {
        if (this._physicsChange) throw new Error('PHYSICS_LOADING');
        if (!this.game || !this.location || !this.camera || !this.clock || !['ready', 'running', 'paused'].includes(this.state)) throw new Error('APP_NOT_READY');
        if (this.contextLost) throw new Error('WEBGL_CONTEXT_LOST');
        this.#validateSnapshotData(snapshot);
        return true;
    }
    restore(snapshot) {
        if (this._physicsChange) throw new Error('PHYSICS_LOADING');
        if (this.state !== 'paused' && this.state !== 'ready') throw new Error('PAUSE_BEFORE_RESTORE');
        if (this.contextLost) throw new Error('WEBGL_CONTEXT_LOST');
        const { clockAPI, c } = this.#validateSnapshotData(snapshot);
        this.clock.restore(snapshot.clock);
        for (let i = 0; i < snapshot.objects.length; i++) {
            const rec = this.location.objects[i], item = snapshot.objects[i];
            rec.def = JSON.parse(JSON.stringify(item.def));
            this.location.placeObject(rec);
            if (this.location.applyHidden) this.location.applyHidden(rec);
            if (this.location.spinPart) this.location.spinPart(rec, 0);
            if (rec.spin && item.spinAngle != null) rec.spin.angle = item.spinAngle;
            if (this.location.spinPart) this.location.spinPart(rec, 0);
        }
        Object.assign(this.camera, c, { target: { ...c.target } });
        this.camera._keys.clear(); this.camera._apply();
        if (this.game.restore) this.game.restore(snapshot.game);
        if (snapshot.animations && clockAPI.restore) clockAPI.restore(this.location.view.scene, snapshot.animations);
        // Game/animation restores may write visual transforms. Physics owns the final pose.
        if (this.physics && snapshot.physics != null) {
            this.physics.restore(snapshot.physics);
            this.options = { ...this.options, physicsEnabled: this.physics.enabled, physicsGravity: this.physics.gravity };
        }
        this._last = 0;
        World3D.renderFrame();
        return this;
    }

    validate() {
        const out = [];
        if (this.location) for (const rec of this.location.objects) {
            if (rec.error) out.push({ severity: 'error', code: 'ASSET_LOAD_FAILED', file: rec.def.model, message: rec.error, hint: 'Restore or replace the model file.' });
        }
        if (this.game && this.game.validate) out.push(...this.game.validate());
        return out;
    }

    loadLevel(options) {
        if (this.state === 'disposed') throw new Error('APP_DISPOSED');
        if (this.contextLost) throw new Error('WEBGL_CONTEXT_LOST');
        this._releaseLevel();
        this._resumeAfterVisibility = false;
        this._resumeAfterContext = false;
        this._last = 0; this.error = null; this.diagnostics = [];
        this.levelId = options.levelId || 'level';
        this.clock = new ArcClock({ ...this.options, ...options });
        this.options = { ...this.options, ...options };
        this.ready = this._load(this.options);
        return this.ready;
    }
    _releaseLevel() {
        ++this._generation;
        let failure = null;
        const attempt = cleanup => { try { cleanup(); } catch (error) { if (!failure) failure = error; } };
        const cancelPrepare = this._cancelPrepare;
        this._cancelPrepare = null;
        if (cancelPrepare) attempt(cancelPrepare);
        const physicsChange = this._physicsChange;
        this._physicsChange = null;
        if (physicsChange) attempt(physicsChange.cancel);
        if (this._modalUnsubscribe) attempt(this._modalUnsubscribe);
        this._modalUnsubscribe = null;
        this._resumeAfterModal = false;
        if (this.camera) attempt(() => this.camera.detach());
        const game = this.game, location = this.location, physics = this.physics;
        let released = false, deferred = false;
        const releaseResources = () => {
            if (game && game.dispose) attempt(() => game.dispose());
            if (physics) attempt(() => physics.dispose());
            if (location) location.physics = null;
            if (location) attempt(() => location.dispose());
            released = true;
            if (deferred && failure) console.error('ArcApp deferred cleanup:', failure);
        };
        // Native collision observers run inside Havok's executeStep. Releasing the
        // scene there would also free its physics engine before the call returns.
        if (physics && physics.deferCleanup) attempt(() => physics.deferCleanup(releaseResources));
        else releaseResources();
        if (!released) {
            deferred = true;
            if (physics) attempt(() => physics.dispose());
        }
        this.location = null; this.camera = null; this.game = null; this.physics = null;
        attempt(() => Sound3D.stopAll()); attempt(() => UI.dispose());
        if (failure) throw failure;
    }
    dispose() {
        if (this.state === 'disposed') return;
        this.state = 'disposed';
        World3D.engine.stopRenderLoop(this._frame);
        window.removeEventListener('resize', this._resize);
        document.removeEventListener('visibilitychange', this._visibility);
        for (const unsubscribe of this._contextObservers) unsubscribe();
        this._contextObservers = [];
        try { this._releaseLevel(); }
        finally { if (window.app === this) window.app = null; }
    }
}

/** @satisfies {Record<string, any>} */
const AIGameEngine = {
    version: '0.7.0',
    apiVersion: 1,
    /** @param {ArcAppOptions} options */
    boot(options) { return new ArcApp(options); }
};
