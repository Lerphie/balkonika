// UI.js — the game's UI (HUD): DOM elements over the 3D canvas, laid out by UILayout.js.
//
// RULE: every UI element is a UI_LAYOUT record (js/UILayout.js), placed and styled in the
// editor's UI tab. Game code does not create, position or style HUD DOM itself — it takes an
// element by id and feeds it data:
//     UI.get('score').setText('10');  UI.get('hp').setValue(0.7);
//     UI.get('start').onClick(() => …);  UI.get('hint').show(false);
// Many elements of one kind (inventory slots): a template record in UILayout.js +
//     UI.add(Object.assign({}, UI.def('slot'), { id: 'slot2', x: 140 }));
//
// Record: { id, kind, anchor, x, y, w, h, … } (the full field list — UI.DEFAULTS).
//   kind   — 'text' | 'panel' | 'bar' | 'button'.
//   anchor — one of 9 screen points ('top-left' … 'bottom-right'): x and y go from it to THE
//            SAME point of the element — inward from a screen edge, signed from the center.
//            A 'bottom-right' element at x 20, y 20 keeps its bottom right corner 20 px from
//            the screen corner at any screen size.
//   w, h   — size in px; a text sizes itself by its content.
//   parent — id of the element this one sits in ('' or none — the screen): anchor, x and y then
//            count from the PARENT's box, the parent clips it, and hiding the parent hides it too.
//   stretch — 'h' | 'v' | 'both' (sized kinds): the element fills its container on that axis,
//            x (y) is the inset from BOTH edges, w (h) is ignored. A full-screen dim:
//            { kind: 'panel', stretch: 'both', x: 0, y: 0 }.
//   Colors — '#rrggbb' strings, '' — none. Records go in drawing order: later — on top.
// SCALE: layout numbers are px of a screen UI_REF_HEIGHT tall — the whole UI scales with the
//   real height (a 1440 px screen draws a 720 px layout twice as big). UI_REF_HEIGHT = 0 — CSS px.

/** @satisfies {Record<string, any>} */
const UI = {
    ANCHORS: ArcSchema.anchors,
    KINDS: ArcSchema.kinds,
    FONT: 'system-ui, "Segoe UI", Roboto, sans-serif',

    // Fields of a record by kind and their defaults — a new element in the editor starts from them.
    DEFAULTS: ArcSchema.uiDefaults,

    /** @type {HTMLElement | null} */
    root: null,
    /** @type {HTMLCanvasElement | null} */
    canvas: null,
    /** @type {UIRecord[]} */
    layout: [],
    /** @type {Map<string, UIElement>} */
    elements: new Map(),
    editing: false,          // the editor's UI tab: every element catches the pointer, buttons do not fire
    previewOnly: false,      // the editor must remain operable even when previewing a modal HUD
    /** @type {ResizeObserver | null} */
    _observer: null,
    _modalListeners: new Set(),
    /** @type {UIElement | null} */
    _activeModal: null,
    /** @type {HTMLElement | null} */
    _restoreFocus: null,
    _keyHandler: null,
    _keyUpHandler: null,
    _blurHandler: null,
    _focusHandler: null,
    _rebuilding: false,
    _modalFocusScopes: new Set(),
    _activationKeys: new Set(),
    _gameFocusKeys: new Set(),
    previewMode: 'all',
    previewSelection: '',
    _geometryBatch: null,

    get hasModal() { return !!this._activeModal; },

    onModalChange(fn) {
        this._modalListeners.add(fn);
        return () => this._modalListeners.delete(fn);
    },

    // Deliberately registered developer tools may coexist with a game modal.
    // Ordinary page controls never receive this exception automatically.
    allowModalFocus(element) {
        this._modalFocusScopes.add(element);
        return () => {
            this._modalFocusScopes.delete(element);
            if (this._activeModal && element.contains(document.activeElement)) this.focusModal();
            this.syncModalAria();
        };
    },

    modalFocusAllowed(target) {
        for (const scope of this._modalFocusScopes) {
            if (!scope.isConnected) this._modalFocusScopes.delete(scope);
            else if (scope.contains(target)) return true;
        }
        return false;
    },

    syncModalAria() {
        const outsideScope = this.modalFocusAllowed(document.activeElement);
        for (const e of this.elements.values()) if (e.def.modal) e.el.setAttribute('aria-modal', e === this._activeModal && !outsideScope ? 'true' : 'false');
    },

    // Focus is transferred only by a game action, never by automatic resume/visibility.
    focusGame() {
        const canvas = this.canvas;
        if (!canvas || !canvas.isConnected || this._activeModal || this.editing || this.previewOnly) return false;
        canvas.tabIndex = 0;
        canvas.setAttribute('data-arc-game-focus', '');
        if (!canvas.getAttribute('aria-label')) canvas.setAttribute('aria-label', 'Game area');
        for (const code of this._activationKeys) this._gameFocusKeys.add(code);
        canvas.focus({ preventScroll: true });
        return document.activeElement === canvas;
    },

    // Editor-only visibility filters never alter records, runtime show state or history.
    setPreview(mode = 'all', selectedId = '') {
        if (!['all', 'hide-modals', 'solo'].includes(mode)) throw new Error('UI_PREVIEW_MODE_INVALID');
        this.previewMode = mode; this.previewSelection = selectedId;
        for (const e of this.elements.values()) e.apply();
    },

    previewVisible(def) {
        if (!this.previewOnly || this.previewMode === 'all') return true;
        if (this.previewMode === 'hide-modals') {
            return ![...this.elements.values()].some(e => e.def.modal && (e.def.id === def.id || this.isInside(def, e.def.id)));
        }
        const selected = this.get(this.previewSelection);
        return !!selected && (def.id === selected.def.id || this.isInside(def, selected.def.id) || this.isInside(selected.def, def.id));
    },

    fillColor(color, alpha = 1) {
        if (!color) return 'transparent';
        if (alpha === 1 || !/^#[0-9a-f]{6}$/i.test(color)) return color;
        const rgb = [1, 3, 5].map(at => parseInt(color.slice(at, at + 2), 16));
        return 'rgba(' + rgb.join(',') + ',' + Math.max(0, Math.min(1, alpha)) + ')';
    },

    // canvas — the 3D canvas the UI lies over; layout — records (UI_LAYOUT by default).
    init(canvas, layout) {
        this.dispose();
        this.canvas = canvas;
        const root = this.root = document.createElement('div');
        root.className = 'arc-ui';
        Object.assign(root.style, { position: 'absolute', overflow: 'hidden', pointerEvents: 'none', transformOrigin: '0 0',
            fontFamily: this.FONT, userSelect: 'none', webkitUserSelect: 'none' });
        (canvas.parentElement || document.body).appendChild(root);
        if (!document.getElementById('arc-ui-accessibility')) {
            const style = document.createElement('style');
            style.id = 'arc-ui-accessibility';
            style.textContent = '.arc-ui button:focus-visible,[data-arc-game-focus]:focus-visible{outline:3px solid #fff;outline-offset:-4px;box-shadow:inset 0 0 0 6px #154c83}.arc-ui button:disabled{filter:grayscale(1);cursor:default!important}';
            document.head.appendChild(style);
        }
        this._keyHandler = e => {
            if (this._gameFocusKeys.has(e.code)) { e.preventDefault(); e.stopPropagation(); return; }
            if ((e.code === 'Space' || e.code === 'Enter') && e.target.closest && e.target.closest('button')) this._activationKeys.add(e.code);
            this.trapFocus(e);
        };
        this._keyUpHandler = e => {
            this._activationKeys.delete(e.code);
            if (this._gameFocusKeys.delete(e.code)) { e.preventDefault(); e.stopPropagation(); }
        };
        this._blurHandler = () => { this._activationKeys.clear(); this._gameFocusKeys.clear(); };
        this._focusHandler = e => {
            const modal = this._activeModal;
            if (modal && !modal.el.contains(e.target) && !this.modalFocusAllowed(e.target)) this.focusModal();
            this.syncModalAria();
        };
        document.addEventListener('keydown', this._keyHandler, true);
        document.addEventListener('keyup', this._keyUpHandler, true);
        window.addEventListener('blur', this._blurHandler);
        document.addEventListener('focusin', this._focusHandler, true);
        if (typeof ResizeObserver !== 'undefined') {
            this._observer = new ResizeObserver(() => this.resize());
            this._observer.observe(canvas);
        }
        this.applyLayout(layout || (typeof UI_LAYOUT !== 'undefined' ? UI_LAYOUT : []));
        return this;
    },

    dispose() {
        this.invalidateGeometry();
        if (this._keyHandler) document.removeEventListener('keydown', this._keyHandler, true);
        if (this._keyUpHandler) document.removeEventListener('keyup', this._keyUpHandler, true);
        if (this._blurHandler) window.removeEventListener('blur', this._blurHandler);
        if (this._focusHandler) document.removeEventListener('focusin', this._focusHandler, true);
        this._keyHandler = this._focusHandler = null;
        this._keyUpHandler = this._blurHandler = null;
        this._activationKeys.clear(); this._gameFocusKeys.clear();
        if (this._observer) this._observer.disconnect();
        if (this.root) this.root.remove();
        this._observer = null;
        this.root = null;
        this.canvas = null;
        this.elements.clear();
        this.syncModal();
    },

    get(id) {
        return this.elements.get(id) || null;
    },

    // The record of an element — a template for UI.add.
    def(id) {
        return this.layout.find(d => d.id === id) || null;
    },

    // Rebuild every element from the records (the editor — after an edit). What the game has
    // set — text, value, visibility, click handler — survives by id.
    applyLayout(layout) {
        if (layout) this.layout = layout;
        if (!this.root) return;
        const old = this.elements;
        this.elements = new Map();
        this.root.textContent = '';
        this._rebuilding = true;
        // All elements first, then the nesting: a child may stand before its parent in the file.
        for (const def of this.layout) this.elements.set(def.id, new UIElement(def, old.get(def.id)));
        for (const def of this.layout) this._attach(this.elements.get(def.id));
        for (const def of this.layout) this.elements.get(def.id).apply();
        this._rebuilding = false;
        this.resize();
        this.syncModal();
    },

    // A runtime element from a record that is not in UILayout.js (a copy of a template).
    add(def) {
        if (!this.root || !def || !def.id) return null;
        this.remove(def.id);
        const e = new UIElement(def, null);
        this.elements.set(def.id, e);
        this._attach(e);
        e.apply();
        return e;
    },

    // Removes the element together with everything nested in it.
    remove(id) {
        const e = this.elements.get(id);
        if (!e) return;
        const inside = [...this.elements.values()].filter(c => this.isInside(c.def, id));
        for (const c of inside) this.elements.delete(c.def.id);
        e.el.remove();
        this.elements.delete(id);
        this.syncModal();
    },

    shown(e) {
        if (!e.visible) return false;
        for (let p = this.parentOf(e.def); p; p = this.parentOf(p.def)) if (!p.visible) return false;
        return true;
    },

    modalButtons() {
        const modal = this._activeModal;
        return [...this.elements.values()].filter(e => e.def.kind === 'button' && e.enabled && this.shown(e)
            && modal && modal.el.contains(e.el)).map(e => e.el);
    },

    focusModal() {
        if (this._activeModal) (this.modalButtons()[0] || this._activeModal.el).focus();
    },

    trapFocus(event) {
        if (!this._activeModal || event.key !== 'Tab' || this.modalFocusAllowed(event.target)) return;
        const buttons = this.modalButtons();
        const current = buttons.indexOf(document.activeElement);
        event.preventDefault();
        event.stopPropagation();
        if (!buttons.length) this._activeModal.el.focus();
        else buttons[current < 0 ? (event.shiftKey ? buttons.length - 1 : 0)
            : (current + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus();
    },

    syncModal() {
        if (this._rebuilding) return;
        const modal = this.editing || this.previewOnly ? null : [...this.elements.values()].filter(e => e.def.modal && this.shown(e)).pop() || null;
        const previous = this._activeModal;
        if (modal && !previous) this._restoreFocus = /** @type {HTMLElement} */ (document.activeElement);
        this._activeModal = modal;
        if (this.root) this.root.style.pointerEvents = modal ? 'auto' : 'none';
        for (const e of this.elements.values()) {
            e.el.inert = !!modal && e !== modal && !modal.el.contains(e.el) && !e.el.contains(modal.el);
        }
        if (modal && !this.modalFocusAllowed(document.activeElement) && (modal !== previous || !modal.el.contains(document.activeElement))) this.focusModal();
        if (!modal && previous) {
            if (this._restoreFocus && this._restoreFocus.isConnected) this._restoreFocus.focus();
            this._restoreFocus = null;
        }
        this.syncModalAria();
        if (!!modal !== !!previous) for (const fn of this._modalListeners) fn(!!modal);
    },

    // The element def sits in (def.parent), null — the screen. A missing parent or a cycle in
    // the chain also gives null: a bad record lands on the screen instead of breaking the tree.
    parentOf(def) {
        const seen = new Set([def.id]);
        for (let id = def.parent; id; ) {
            const e = this.elements.get(id);
            if (!e || seen.has(id)) return null;
            seen.add(id);
            id = e.def.parent;
        }
        return def.parent ? this.elements.get(def.parent) : null;
    },

    // Is def nested in the element id — directly or through its ancestors?
    isInside(def, id) {
        for (let e = this.parentOf(def); e; e = this.parentOf(e.def)) if (e.def.id === id) return true;
        return false;
    },

    _attach(e) {
        const parent = this.parentOf(e.def);
        (parent ? parent.el : this.root).appendChild(e.el);
    },

    // Opt-in synchronous geometry snapshot. Setters and DOM/focus effects remain immediate.
    // Call invalidateGeometry after changing canvas CSS/dimensions inside the callback.
    // Public scale/size remain live. An async return is returned normally; it is not held open.
    /**
     * @template T
     * @param {() => T} callback
     * @returns {T}
     */
    batchGeometry(callback) {
        if (typeof callback !== 'function') throw new Error('UI_BATCH_CALLBACK_INVALID');
        if (!this._geometryEligible() || !this._elementsGeometryEligible()) return callback();
        const active = this._geometryBatch;
        if (active) {
            active.depth++;
            try { return callback(); } finally { active.depth--; }
        }
        const batch = { depth: 1, geometry: null };
        this._geometryBatch = batch;
        try { batch.geometry = this._readGeometry(); return callback(); }
        finally { if (this._geometryBatch === batch) this._geometryBatch = null; }
    },

    invalidateGeometry() {
        if (this._geometryBatch) this._geometryBatch.geometry = null;
    },

    _geometryEligible() {
        const p = UI_GEOMETRY_BASE;
        return !!p.configGet && this === UI && !this.editing && !this.previewOnly &&
            this.get === p.get && this.scale === p.scale && this.size === p.size && this.syncModal === p.syncModal &&
            this.parseAnchor === p.parseAnchor && this.stretchOf === p.stretchOf &&
            this.previewVisible === p.previewVisible && this.fillColor === p.fillColor &&
            this.syncModalAria === p.syncModalAria && this.modalFocusAllowed === p.modalFocusAllowed &&
            this.shown === p.shown && this.parentOf === p.parentOf &&
            this.focusModal === p.focusModal && this.modalButtons === p.modalButtons &&
            ArcConfig.get === p.configGet && UIElement.prototype.apply === p.apply &&
            UIElement.prototype.setText === p.setText && UIElement.prototype.setValue === p.setValue &&
            UIElement.prototype.setEnabled === p.setEnabled && UIElement.prototype.show === p.show;
    },

    // Reject installed instance hooks before reading geometry or invoking a setter.
    // Plain record/DOM instances are the snapshot domain; descriptors do not invoke hooks.
    _elementsGeometryEligible() {
        for (const element of this.elements.values()) {
            if (Object.getPrototypeOf(element) !== UIElement.prototype) return false;
            for (const name of ['apply', 'setText', 'setValue', 'setEnabled', 'show', 'visible', 'enabled']) {
                if (Object.getOwnPropertyDescriptor(element, name)) return false;
            }
        }
        return true;
    },

    _readGeometry() {
        const canvas = this.canvas, ref = ArcConfig.get('UI_REF_HEIGHT');
        const width = canvas ? canvas.clientWidth : 0, height = canvas ? canvas.clientHeight : 0;
        return { canvas, ref, width, height, scale: ref > 0 && height > 0 ? height / ref : 1 };
    },

    _batchGeometry() {
        const batch = this._geometryBatch;
        if (!batch || !this._geometryEligible()) return null;
        const geometry = batch.geometry, ref = ArcConfig.get('UI_REF_HEIGHT');
        if (!geometry || geometry.canvas !== this.canvas || geometry.ref !== ref) batch.geometry = this._readGeometry();
        return batch.geometry;
    },

    _elementScale() {
        const geometry = this._batchGeometry();
        return geometry ? geometry.scale : this.scale();
    },

    _geometryWidth(canvas) {
        const geometry = canvas === this.canvas ? this._batchGeometry() : null;
        return geometry ? geometry.width : canvas.clientWidth;
    },

    // UI px per CSS px: screen height / UI_REF_HEIGHT.
    scale() {
        const ref = ArcConfig.get('UI_REF_HEIGHT');
        const h = this.canvas ? this.canvas.clientHeight : 0;
        return ref > 0 && h > 0 ? h / ref : 1;
    },

    // The root covers the canvas; its inner size is the screen in layout px.
    resize() {
        this.invalidateGeometry();
        const c = this.canvas, r = this.root;
        if (!c || !r) return;
        const s = this.scale();
        r.style.left = c.offsetLeft + 'px';
        r.style.top = c.offsetTop + 'px';
        r.style.width = (c.clientWidth / s) + 'px';
        r.style.height = (c.clientHeight / s) + 'px';
        r.style.transform = 'scale(' + s + ')';
        for (const e of this.elements.values()) e.apply();
    },

    // Screen size in layout px.
    size() {
        const s = this.scale(), c = this.canvas;
        return { w: c ? c.clientWidth / s : 0, h: c ? c.clientHeight / s : 0 };
    },

    // --- Anchor math (no DOM — tests/ui.test.mjs) -------------------------------------

    // 'bottom-right' -> { v: 'bottom', h: 'right' }; garbage -> top-left.
    parseAnchor(anchor) {
        const a = this.ANCHORS.includes(anchor) ? anchor : 'top-left', p = a.split('-');
        return { v: p[0], h: p[1] };
    },

    // def.stretch -> the stretched axes; a text has no size of its own to stretch.
    stretchOf(def) {
        const s = def.kind === 'text' ? '' : def.stretch;
        return { h: s === 'h' || s === 'both', v: s === 'v' || s === 'both' };
    },

    // Record -> the top left corner of an element of size w × h in a container W × H (the screen
    // or the parent's inside). On a stretched axis x (y) is the inset, whatever the anchor.
    resolve(def, w, h, W, H) {
        const a = this.parseAnchor(def.anchor), st = this.stretchOf(def), x = Number(def.x) || 0, y = Number(def.y) || 0;
        return {
            left: st.h ? x : a.h === 'right' ? W - x - w : a.h === 'center' ? W / 2 + x - w / 2 : x,
            top: st.v ? y : a.v === 'bottom' ? H - y - h : a.v === 'middle' ? H / 2 + y - h / 2 : y,
        };
    },

    // The inverse: where the element stands -> x, y of the record for the given anchor. The editor
    // changes the anchor through it, so the element stays where it was.
    toStored(anchor, left, top, w, h, W, H) {
        const a = this.parseAnchor(anchor);
        return {
            x: a.h === 'right' ? W - left - w : a.h === 'center' ? left + w / 2 - W / 2 : left,
            y: a.v === 'bottom' ? H - top - h : a.v === 'middle' ? top + h / 2 - H / 2 : top,
        };
    },
};

// One UI element: a record (def) + its DOM + what the game has set at run time.
class UIElement {
    // Per-control lifetime history, separate from layout data and effective DOM visibility.
    #visibilityRevision = 0;
    #visibilityState = true;
    /** @param {UIRecord} def @param {UIElement | null} prev — the same id before a rebuild */
    constructor(def, prev) {
        this.def = def;
        this.el = document.createElement(def.kind === 'button' ? 'button' : 'div');
        if (def.kind === 'button') /** @type {HTMLButtonElement} */ (this.el).type = 'button';
        this.el.dataset.ui = def.id;
        /** @type {HTMLElement | null} */
        this.inner = null;       // bar: the filled part; text and button: the label
        this._text = prev ? prev._text : null;
        this._value = prev ? prev._value : null;
        this._shown = prev ? prev._shown : null;
        this.#visibilityState = this.visible;
        this._enabled = prev ? prev._enabled : null;
        this._click = prev ? prev._click : null;
        this._focusAfterClick = prev ? prev._focusAfterClick : 'preserve';
        this.el.addEventListener('click', (e) => {
            if (UI.editing || !this.enabled || this.def.kind !== 'button' || !this._click) return;
            e.stopPropagation();
            this._click(this);
            if (this._focusAfterClick === 'game') UI.focusGame();
        });
    }

    setText(text) { this._text = String(text); this.apply(); return this; }

    // Bar fill 0..1.
    setValue(v) { this._value = Math.max(0, Math.min(1, Number(v) || 0)); this.apply(); return this; }

    show(on) { this._shown = on !== false; this.apply(); return this; }

    /** @param {((element:UIElement)=>any)|null} fn @param {{focus?:'preserve'|'game'}} [options] */
    onClick(fn, options = {}) {
        if (options.focus && !['preserve', 'game'].includes(options.focus)) throw new Error('UI_FOCUS_POLICY_INVALID');
        this._click = fn || null; this._focusAfterClick = options.focus || 'preserve'; return this;
    }

    setEnabled(on) { this._enabled = on !== false; this.apply(); return this; }

    get enabled() { return this._enabled != null ? this._enabled : this.def.enabled !== false; }

    get visible() {
        return this._shown != null ? this._shown : this.def.visible !== 0;
    }

    // Observation does not render, emit modal events or change records/runtime show state.
    // An unapplied raw record's current visibility can be observed; unobserved intermediate
    // raw writes are not a history API. Replaced controls need a new identity check.
    /** @returns {number} */
    get visibilityRevision() {
        this.#observeVisibility(this.visible);
        return this.#visibilityRevision;
    }

    /** @param {boolean} visible @returns {boolean} */
    #observeVisibility(visible) {
        if (visible !== this.#visibilityState) {
            if (this.#visibilityRevision === Number.MAX_SAFE_INTEGER) throw new Error('UI_VISIBILITY_REVISION_EXHAUSTED');
            this.#visibilityState = visible;
            this.#visibilityRevision++;
        }
        return visible;
    }

    // Record + run-time state -> DOM. Cheap: called on every edit and every setText.
    apply() {
        const d = this.def, s = this.el.style, a = UI.parseAnchor(d.anchor);
        const x = Number(d.x) || 0, y = Number(d.y) || 0, px = (v) => (Number(v) || 0) + 'px';
        const sized = d.kind !== 'text', st = UI.stretchOf(d);
        s.cssText = '';
        s.position = 'absolute';
        s.boxSizing = 'border-box';
        // The container is the parent's box (an absolute element positions its children) or the
        // root. A stretched axis pins both edges with the same inset; w (h) is not used there.
        s.left = st.h || a.h === 'left' ? px(x) : a.h === 'center' ? 'calc(50% + ' + px(x) + ')' : '';
        s.right = st.h || a.h === 'right' ? px(x) : '';
        s.top = st.v || a.v === 'top' ? px(y) : a.v === 'middle' ? 'calc(50% + ' + px(y) + ')' : '';
        s.bottom = st.v || a.v === 'bottom' ? px(y) : '';
        if (d.safeArea !== false && !d.parent) {
            for (const edge of ['left', 'right', 'top', 'bottom']) {
                if (s[edge] && !s[edge].startsWith('calc')) s[edge] = 'calc(' + s[edge] + ' + env(safe-area-inset-' + edge + ', 0px) * ' + (1 / UI._elementScale()) + ')';
            }
        }
        s.transform = 'translate(' + (!st.h && a.h === 'center' ? '-50%' : '0') + ', ' + (!st.v && a.v === 'middle' ? '-50%' : '0') + ')';
        if (sized && !st.h) s.width = px(d.w);
        if (sized && !st.v) s.height = px(d.h);
        s.opacity = String(d.alpha == null ? 1 : Math.max(0, Math.min(1, Number(d.alpha))));
        s.display = (this.#observeVisibility(this.visible) || UI.editing) && UI.previewVisible(d) ? 'block' : 'none';
        if (UI.editing && !this.visible) s.opacity = String(Number(s.opacity) * 0.35);
        s.pointerEvents = UI.editing || d.kind === 'button' || d.interactive || d.modal ? 'auto' : 'none';
        s.cursor = UI.editing ? 'move' : d.kind === 'button' ? 'pointer' : '';
        if (d.ariaLabel) this.el.setAttribute('aria-label', d.ariaLabel); else this.el.removeAttribute('aria-label');
        if (d.modal) { this.el.setAttribute('role', 'dialog'); this.el.tabIndex = -1; }
        if (d.kind === 'button') {
            const button = /** @type {HTMLButtonElement} */ (this.el);
            button.disabled = !UI.editing && !this.enabled;
            button.tabIndex = UI.editing ? -1 : 0;
            s.padding = '0'; s.font = 'inherit'; s.touchAction = 'manipulation';
            if (!UI.editing) { s.minWidth = (44 / UI._elementScale()) + 'px'; s.minHeight = (44 / UI._elementScale()) + 'px'; }
        }

        if (sized) {
            s.background = UI.fillColor(d.fill, d.fillAlpha == null ? 1 : d.fillAlpha);
            s.border = d.border ? '2px solid ' + d.border : 'none';
            s.borderRadius = px(d.radius);
            s.overflow = 'hidden';
        }
        const label = d.kind === 'text' || d.kind === 'button';
        if (label || d.kind === 'bar') {
            if (!this.inner) {
                this.inner = document.createElement(d.kind === 'button' ? 'span' : 'div');
                this.el.appendChild(this.inner);
            }
        } else if (this.inner) {
            this.inner.remove();
            this.inner = null;
        }
        if (label) {
            const t = this.inner.style;
            t.cssText = '';
            this.inner.textContent = this._text != null ? this._text : String(d.text == null ? '' : d.text);
            t.whiteSpace = 'pre';
            t.fontSize = px(d.fontSize || 20);
            t.fontWeight = '600';
            t.lineHeight = '1.2';
            t.color = d.color || '#ffffff';
            t.textAlign = a.h === 'center' ? 'center' : a.h;
            if (d.shadow) t.textShadow = '0 1px 2px ' + d.shadow + ', 0 0 3px ' + d.shadow;
            if (d.kind === 'button') Object.assign(t, { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%' });
        } else if (d.kind === 'bar') {
            const v = this._value != null ? this._value : Math.max(0, Math.min(1, Number(d.value) || 0));
            this.inner.textContent = '';
            this.inner.style.cssText = 'height: 100%; width: ' + (v * 100) + '%; background: ' + (d.color || '#5ad05a') + ';';
            this.el.setAttribute('role', 'progressbar');
            this.el.setAttribute('aria-valuemin', '0');
            this.el.setAttribute('aria-valuemax', '100');
            this.el.setAttribute('aria-valuenow', String(Math.round(v * 100)));
        }
        UI.syncModal();
    }
}

// Default code identities bound only the declared ordinary-element snapshot domain.
const UI_GEOMETRY_BASE = Object.freeze({
    get: UI.get, scale: UI.scale, size: UI.size, syncModal: UI.syncModal, parseAnchor: UI.parseAnchor,
    stretchOf: UI.stretchOf, previewVisible: UI.previewVisible, fillColor: UI.fillColor,
    syncModalAria: UI.syncModalAria, modalFocusAllowed: UI.modalFocusAllowed, shown: UI.shown, parentOf: UI.parentOf,
    focusModal: UI.focusModal, modalButtons: UI.modalButtons,
    configGet: typeof ArcConfig === 'undefined' ? null : ArcConfig.get, apply: UIElement.prototype.apply, setText: UIElement.prototype.setText,
    setValue: UIElement.prototype.setValue, setEnabled: UIElement.prototype.setEnabled, show: UIElement.prototype.show,
});
