// Dev.js — versioned, allowlisted runtime commands. No source-code evaluation.
// The optional command form appears only with ?arcdev=1; it is not shipped game UI.
/** @satisfies {Record<string, any>} */
const ArcDev = {
    apiVersion: 1,
    /** @type {ArcApp | null} */ app: null,
    _panel: null,
    _removeFocusScope: null,
    _focusShortcut: null,
    commands: ['inspect', 'pause', 'resume', 'step', 'action', 'snapshot', 'restore', 'record', 'replay', 'validate', 'lint', 'benchmark', 'loadLevel', 'quality', 'physics'],
    bind(app) { this.app = app; return this; },
    inspect() {
        const app = this.app;
        if (!app) return { status: 'unbound' };
        const scene = app.location && app.location.view && app.location.view.scene;
        return {
            apiVersion: this.apiVersion, engineVersion: AIGameEngine.version, status: app.state, error: app.error, contextLost: app.contextLost,
            levelId: app.levelId, tick: app.clock.tick, time: app.clock.time, seedState: app.clock.rngState,
            objects: app.location ? app.location.objects.map(r => ({ id: r.def.id || r.def.name, name: r.def.name, model: r.def.model, tag: r.def.tag || '', loaded: !!r.mesh, error: r.error, hidden: !!r.def.hidden })) : [],
            ui: [...UI.elements.values()].map(e => ({ id: e.def.id, kind: e.def.kind, visible: e.visible })),
            game: app.game && app.game.snapshot ? app.game.snapshot() : null,
            physics: app.physics ? app.physics.inspect() : null,
            resources: scene ? { meshes: scene.meshes.length, materials: scene.materials.length, textures: scene.textures.length, skeletons: scene.skeletons.length, animations: scene.animationGroups.length, sounds: Sound3D.playing.size } : null,
            metrics: { ...app.metrics, droppedSeconds: app.clock.droppedSeconds }, diagnostics: app.diagnostics
        };
    },
    async dispatch(request) {
        const command = request && request.command;
        if (!this.commands.includes(command)) return { ok: false, apiVersion: this.apiVersion, error: { code: 'COMMAND_UNKNOWN', hint: 'Choose a listed ArcDev command.' } };
        const app = this.app, args = request.args || {};
        if (!app || app.state === 'disposed') return { ok: false, error: { code: 'APP_NOT_READY', hint: 'Boot the application first.' } };
        try {
            let result;
            switch (command) {
                case 'inspect': result = this.inspect(); break;
                case 'pause': app.pause(); result = { state: app.state }; break;
                case 'resume': app.resume(); result = { state: app.state }; break;
                case 'step': result = { tick: app.advanceTicks(args.ticks == null ? 1 : args.ticks) }; break;
                case 'action': result = app.action(args.name, args.value); break;
                case 'snapshot': result = app.snapshot(); break;
                case 'restore': app.restore(args.snapshot); result = { tick: app.clock.tick }; break;
                case 'record': result = args.stop ? app.stopRecording() : app.startRecording(); break;
                case 'replay': result = app.replay(args.actions, args.untilTick); break;
                case 'validate': result = { findings: app.validate() }; break;
                case 'lint': result = await Debug3D.lint(app.location.view, { silent: true }); break;
                case 'benchmark': result = this.benchmark(args); break;
                case 'quality': result = args.name ? ArcQuality.apply(args.name) : ArcQuality.inspect(); break;
                case 'physics':
                    if (args.enabled !== undefined) await app.setPhysicsEnabled(args.enabled);
                    result = app.physics ? app.physics.inspect() : null; break;
                case 'loadLevel': {
                    const findings = ArcSchema.validateObjects(args.objects || []);
                    if (args.layout) findings.push(...ArcSchema.validateUI(args.layout));
                    if (findings.length) return { ok: false, error: { code: 'LEVEL_INVALID', findings } };
                    await app.loadLevel({ levelId: args.id || 'level', objects: args.objects || [], layout: args.layout || app.options.layout, autoStart: args.autoStart !== false });
                    result = this.inspect(); break;
                }
            }
            return { ok: true, apiVersion: this.apiVersion, command, result };
        } catch (error) {
            return { ok: false, apiVersion: this.apiVersion, command, error: { code: String(error.message || error).split(':')[0], message: String(error.message || error), hint: command === 'step' || command === 'restore' || command === 'replay' ? 'Pause the application and supply a compatible snapshot or tick count.' : 'Inspect application diagnostics and the public contract.' } };
        }
    },
    benchmark(options = {}) {
        const app = this.app, ticks = options.ticks == null ? 120 : options.ticks;
        if (!Number.isInteger(ticks) || ticks < 1 || ticks > 3600) throw new Error('BENCHMARK_TICKS_INVALID');
        const wasRunning = app.state === 'running'; app.pause();
        const state = app.snapshot(), oldMetrics = { ...app.metrics }, muted = Sound3D.muted;
        Sound3D.setMuted(true);
        try {
            const start = performance.now(); app.advanceTicks(ticks, false);
            const simulationMs = (performance.now() - start) / ticks;
            const render = Debug3D.bench({ frames: Math.min(ticks, 120) });
            return { ticks, simulationMs, renderMs: render.ms, width: render.width, height: render.height,
                environment: { userAgent: navigator.userAgent, devicePixelRatio: window.devicePixelRatio || 1, engineVersion: AIGameEngine.version },
                resources: this.inspect().resources };
        } finally {
            app.restore(state); app.metrics = oldMetrics; Sound3D.setMuted(muted);
            if (wasRunning) app.resume();
        }
    },
    mount() {
        if (document.getElementById('arc-dev')) return;
        const panel = document.createElement('details'); panel.id = 'arc-dev';
        panel.style.cssText = 'position:fixed;left:8px;top:8px;z-index:10000;max-width:min(440px,90vw);padding:8px;background:#10202c;color:white;font:14px system-ui;border:1px solid #91afc5;border-radius:6px';
        const summary = document.createElement('summary'); summary.textContent = 'AIGameEngine developer tools'; panel.appendChild(summary);
        const label = document.createElement('label'); label.htmlFor = 'arc-dev-command'; label.textContent = 'Arc command (JSON)'; panel.appendChild(label);
        const input = document.createElement('textarea'); input.id = 'arc-dev-command'; input.rows = 4; input.value = '{"command":"inspect"}';
        input.style.cssText = 'display:block;width:100%;box-sizing:border-box;margin:8px 0'; panel.appendChild(input);
        const run = document.createElement('button'); run.id = 'arc-dev-run'; run.type = 'button'; run.textContent = 'Run command'; run.style.minHeight = '44px'; panel.appendChild(run);
        const output = document.createElement('pre'); output.id = 'arc-dev-result'; output.setAttribute('aria-live', 'polite'); output.style.cssText = 'max-height:40vh;overflow:auto;white-space:pre-wrap'; panel.appendChild(output);
        let sequence = 0;
        run.addEventListener('click', async () => {
            run.disabled = true;
            try { output.textContent = JSON.stringify(await this.dispatch(JSON.parse(input.value)), null, 2); }
            catch (error) { output.textContent = JSON.stringify({ ok: false, error: { code: 'REQUEST_JSON_INVALID', message: error.message } }); }
            finally { output.dataset.sequence = String(++sequence); run.disabled = false; }
        });
        document.body.appendChild(panel);
        this._panel = panel;
        this._removeFocusScope = UI.allowModalFocus(panel);
        this._focusShortcut = event => {
            if (event.altKey && event.shiftKey && event.code === 'KeyD') {
                event.preventDefault(); event.stopPropagation(); panel.open = true; input.focus();
            }
        };
        document.addEventListener('keydown', this._focusShortcut, true);
        summary.title = 'Open developer command form: Alt+Shift+D';
        panel.setAttribute('aria-label', 'AIGameEngine developer tools');
    },
    unmount() {
        if (this._removeFocusScope) this._removeFocusScope();
        if (this._focusShortcut) document.removeEventListener('keydown', this._focusShortcut, true);
        if (this._panel) this._panel.remove();
        this._panel = this._removeFocusScope = this._focusShortcut = null;
    }
};

// A deliberate public handle for browser automation; app state stays behind allowlisted methods.
window.ArcDev = ArcDev;
