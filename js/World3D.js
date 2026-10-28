// World3D.js — stable engine facade: one Babylon engine and the active view.
// Visual policies live in WorldRender3D, InkSkin and Toon3D; View3D owns each scene.
// Classic-script order: WorldRender3D -> World3D -> InkSkin -> Toon3D -> View3D.

/** @satisfies {Record<string, any>} */
const World3D = {
    /** @type {BABYLON.Engine | null} */
    engine: null,
    /** @type {HTMLCanvasElement | null} */
    canvas: null,
    /** @type {View3D | null} */
    view: null,             // the active View3D (drawn by renderFrame)
    /** @type {BABYLON.Color4 | null} */
    _bg: null,
    /** @type {typeof ArcToon} */
    toon: null,             // assigned by Toon3D.js before init

    // Render layers (Babylon renderingGroupId), the depth buffer is SHARED (see View3D):
    //   WORLD   — the ground and everything standing on it;
    //   OVERLAY — marks on top of the world (selection, paths): their materials get
    //             depthFunction = ALWAYS and disableDepthWrite — the terrain does not cut
    //             them, and the world depth stays intact;
    //   ACTOR   — objects that go last: OVERLAY paint does not land on top of
    //             them, but they hide behind walls honestly.
    LAYER: { WORLD: 0, OVERLAY: 1, ACTOR: 2 },

    available() {
        return typeof BABYLON !== 'undefined' && !!this.engine;
    },

    // Brings up the engine on the canvas (one per page). false — no Babylon or WebGL.
    init(canvas) {
        if (typeof BABYLON === 'undefined') {
            console.warn('World3D: libs/babylon.js не загружен — 3D-мир недоступен.');
            return false;
        }
        if (this.engine) return true;
        this.canvas = canvas;
        try {
            this.engine = new BABYLON.Engine(canvas, true, {
                preserveDrawingBuffer: false,
                stencil: true,     // needed by the silhouette outline HighlightLayer (needStencil)
                antialias: true,
                adaptToDeviceRatio: false,
                powerPreference: 'high-performance',
                doNotHandleContextLost: false
            }, false);
        } catch (e) {
            console.error('World3D: WebGL недоступен', e);
            this.engine = null;
            return false;
        }
        // Sharpness on HiDPI: render in physical pixels (on mobile —
        // no more than 1.5x, otherwise fill rate eats the frame).
        const dpr = window.devicePixelRatio || 1;
        const cap = IS_MOBILE ? 1.5 : 2;
        this.engine.setHardwareScalingLevel(1 / Math.min(dpr, cap));
        this._bg = new BABYLON.Color4(0.133, 0.133, 0.133, 1);
        // The toon plugin attaches to materials at their CREATION — register it
        // before the first scene.
        this.toon.register();
        this.resize();
        return true;
    },

    resize() {
        if (this.engine) this.engine.resize();
    },

    renderFrame() {
        const e = this.engine;
        if (!e) return;
        const v = this.view;
        if (v && v.active && v.scene && v.scene.activeCamera) {
            v.beforeRender();
            this.outlineFog(v);
            v.scene.render();
        } else {
            e.clear(this._bg, true, true, true);
        }
    },

    createView(opts) {
        if (!this.available()) return null;
        return new View3D(this, opts || {});
    },

    // Preserve the public method names and their receiver without wrapper allocation.
    cfg: WorldRender3D.cfg,
    applyRenderConstants: WorldRender3D.applyRenderConstants,
    applyMaterialConstants: WorldRender3D.applyMaterialConstants,
    addObject: WorldRender3D.addObject,
    addInstances: WorldRender3D.addInstances,
    removeObject: WorldRender3D.removeObject,
    inkMesh: WorldRender3D.inkMesh,
    inkSkin: WorldRender3D.inkSkin,
    inkSkinRelease: WorldRender3D.inkSkinRelease,
    applyInk: WorldRender3D.applyInk,
    outlineKind: WorldRender3D.outlineKind,
    outlineWidthOf: WorldRender3D.outlineWidthOf,
    outlineRatios: WorldRender3D.outlineRatios,
    outlineKernel: WorldRender3D.outlineKernel,
    outlineLayer: WorldRender3D.outlineLayer,
    outlineAdd: WorldRender3D.outlineAdd,
    outlineRemove: WorldRender3D.outlineRemove,
    applyOutlines: WorldRender3D.applyOutlines,
    outlineFog: WorldRender3D.outlineFog,
    fogFactor: WorldRender3D.fogFactor,
    sunDirection: WorldRender3D.sunDirection,
    hexColor3: WorldRender3D.hexColor3
};
