// Application state is independent of the scene and the interface.
const BalkonikaSelection = {
    walls: { white: 'белые', beige: 'бежевые', lightGray: 'светло-серые' },
    floors: { lightWood: 'светлое дерево', darkWood: 'тёмное дерево', grayTile: 'серая плитка', herringbone: 'дерево ёлочкой', warmTile: 'светлая плитка' },
    initial() { return { wallColor: 'white', floorMaterial: 'lightWood' }; },
    change(state, name, value) {
        if (name === 'reset') return this.initial();
        if (name === 'wallColor' && Object.hasOwn(this.walls, value)) return { ...state, wallColor: value };
        if (name === 'floorMaterial' && Object.hasOwn(this.floors, value)) return { ...state, floorMaterial: value };
        throw new Error('SELECTION_INVALID');
    },
    label(state) { return 'Стены: ' + this.walls[state.wallColor] + '. Пол: ' + this.floors[state.floorMaterial]; }
};

class Game {
    /** @param {ArcApp} app */
    constructor(app) {
        this.app = app;
        this.state = BalkonikaSelection.initial();
        this.controlIds = [...Object.keys(BalkonikaSelection.walls).map(x => 'wall_' + x), ...Object.keys(BalkonikaSelection.floors).map(x => 'floor_' + x), 'reset'];
        this.scene = new BalconyScene(app);
        // The responsive grid may resize the canvas after the window resize event.
        // Keep the drawing buffer in sync with the actual CSS box.
        this.disposed = false;
        this.resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => { if (!this.disposed) World3D.resize(); });
        if (this.resizeObserver) this.resizeObserver.observe(app.canvas);
        for (const [id, level] of [['heading', '1'], ['walls_label', '2'], ['floor_label', '2']]) {
            const heading = UI.get(id);
            if (heading) {
                heading.el.setAttribute('role', 'heading');
                heading.el.setAttribute('aria-level', level);
            }
        }
        for (const wall of Object.keys(BalkonikaSelection.walls)) {
            const button = UI.get('wall_' + wall);
            if (button) button.onClick(() => this.action('wallColor', wall));
        }
        for (const floor of Object.keys(BalkonikaSelection.floors)) {
            const button = UI.get('floor_' + floor);
            if (button) button.onClick(() => this.action('floorMaterial', floor));
        }
        const reset = UI.get('reset');
        if (reset) reset.onClick(() => this.action('reset'));
        const selection = UI.get('selection');
        if (selection) selection.el.setAttribute('aria-live', 'polite');
        this.renderSelection();
        for (const id of this.controlIds) { const button = UI.get(id); if (button) button.setEnabled(false); }
    }
    /** @param {{signal: AbortSignal}} context */
    async prepare({ signal }) {
        signal.throwIfAborted();
        await this.scene.waitForTextures(signal);
        signal.throwIfAborted();
        for (const id of this.controlIds) { const button = UI.get(id); if (button) button.setEnabled(true); }
    }
    action(name, value) {
        this.state = BalkonikaSelection.change(this.state, name, value);
        this.renderSelection();
        return this.snapshot();
    }
    renderSelection() {
        this.scene.setWall(this.state.wallColor);
        this.scene.setFloor(this.state.floorMaterial);
        for (const wall of Object.keys(BalkonikaSelection.walls)) {
            const button = UI.get('wall_' + wall);
            if (button) button.el.setAttribute('aria-pressed', String(wall === this.state.wallColor));
        }
        for (const floor of Object.keys(BalkonikaSelection.floors)) {
            const button = UI.get('floor_' + floor);
            if (button) button.el.setAttribute('aria-pressed', String(floor === this.state.floorMaterial));
        }
        const selection = UI.get('selection');
        if (selection) selection.setText(BalkonikaSelection.label(this.state));
    }
    snapshot() { return { ...this.state }; }
    validateSnapshot(state) {
        if (!state || !Object.hasOwn(BalkonikaSelection.walls, state.wallColor) || !Object.hasOwn(BalkonikaSelection.floors, state.floorMaterial)) throw new Error('SELECTION_INVALID');
    }
    restore(state) { this.validateSnapshot(state); this.state = { ...state }; this.renderSelection(); }
    validate() { return ArcBindings.validateRuntime(this.app.location, UI, ArcBindings.balkonikaContract); }
    /** @param {number} dt */
    update(dt) { this.scene.update(dt); }
    dispose() {
        this.disposed = true;
        if (this.resizeObserver) this.resizeObserver.disconnect();
        for (const id of this.controlIds) {
            const button = UI.get(id); if (button) button.onClick(null);
        }
        this.scene.dispose();
    }
}
