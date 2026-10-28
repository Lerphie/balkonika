// View3D.js — scene ownership, camera, light/shadows and map projections.
// One 3D view: its own Babylon scene, camera, light and shadows.
class View3D {
    // opts: { sky?, groundTint?, shadowColor?, fogDensity?, shadowRadius? } — constant overrides
    constructor(world, opts) {
        this.world = world;
        this.opts = opts;
        this.active = false;
        this.engine = world.engine;

        const scene = new BABYLON.Scene(this.engine);
        this.scene = scene;
        // Right-handed system: X = x, Z = y of the map (y down) viewed from above
        // puts east on the RIGHT; in a left-handed one the same world came out mirrored.
        scene.useRightHandedSystem = true;
        scene.detachControl();
        scene.skipPointerMovePicking = true;
        scene.skipFrustumClipping = false;
        scene.autoClear = true;
        scene.autoClearDepthAndStencil = true;
        // The OVERLAY and ACTOR layers do NOT clear depth (World3D.LAYER): marks on top of
        // the world are let through by their material's ALWAYS test, while ACTOR is still
        // tested against the world depth. Clearing depth instead of ALWAYS has already been
        // tried — ACTOR objects started showing through walls.
        scene.setRenderingAutoClearDepthStencil(World3D.LAYER.OVERLAY, false);
        scene.setRenderingAutoClearDepthStencil(World3D.LAYER.ACTOR, false);
        scene.ambientColor = new BABYLON.Color3(0.35, 0.35, 0.38);
        // Fog hides the ground edge at a low camera angle.
        scene.fogMode = BABYLON.Scene.FOGMODE_EXP2;

        const c = World3D.cfg();

        // --- Camera: TargetCamera without built-in inputs, driven by CameraController ---
        this.camera = new BABYLON.TargetCamera('cam', new BABYLON.Vector3(0, 600, 0), scene);
        this.camera.fov = (ArcConfig.get('CAMERA_FOV_DEG')) * Math.PI / 180;
        this.camera.minZ = 6;
        this.camera.maxZ = 9000;
        this.camera.setTarget(new BABYLON.Vector3(1, 0, 1));
        scene.activeCamera = this.camera;

        // --- Light: sky (hemisphere) + sun; values — applyLighting ---
        this.hemi = new BABYLON.HemisphericLight('hemi', new BABYLON.Vector3(0, 1, 0), scene);
        this.hemi.specular = new BABYLON.Color3(0, 0, 0);

        this.sun = new BABYLON.DirectionalLight('sun', World3D.sunDirection(c), scene);
        this.sun.specular = new BABYLON.Color3(0.25, 0.25, 0.25);
        this.sun.autoUpdateExtends = false;
        // Shadow map depth — from the sun position (LIGHT_DIST from the target):
        // a narrow range = precision, a wide one (1..6000) lost shadows.
        this.sun.shadowMinZ = View3D.LIGHT_DIST - 1200;
        this.sun.shadowMaxZ = View3D.LIGHT_DIST + 1200;
        this._shadowRadius = opts.shadowRadius || (IS_MOBILE ? Math.min(520, c.shadowRadius) : c.shadowRadius);

        const mapSize = IS_MOBILE ? Math.max(512, c.shadowMap / 2) : c.shadowMap;
        this._mapSize = mapSize;
        this.shadow = new BABYLON.ShadowGenerator(mapSize, this.sun);
        this.shadow.transparencyShadow = false;
        this.applyLighting(c);
        this.updateLightFrustum(0, 0, 0);

        this._syncFns = [];   // functions called before every 3D frame
        this.active = true;
        world.view = this;
    }

    // Light, sky, fog and shadows from the render constants (the view's opts override them).
    // Also here — the colored shadow plugin data (scene.metadata.arcSun, arcShadow):
    // shadow density and color are computed by the shader, Babylon's darkness is 0.
    // The light is tuned so that flat ground comes out ≈1.0 (texture paint
    // unchanged), slopes and shadows darken; sums above ~1.2 clamp to white.
    applyLighting(c) {
        c = c || World3D.cfg();
        const o = this.opts || {};
        const scene = this.scene;
        const sky = World3D.hexColor3(o.sky != null ? o.sky : c.sky);
        scene.clearColor = new BABYLON.Color4(sky.r, sky.g, sky.b, 1);
        scene.fogColor = sky;
        scene.fogDensity = Math.max(0, o.fogDensity != null ? o.fogDensity : c.fog);

        this.hemi.intensity = Math.max(0, c.skyIntensity);
        this.hemi.diffuse = World3D.hexColor3(c.skyLight);
        this.hemi.groundColor = World3D.hexColor3(o.groundTint != null ? o.groundTint : c.groundLight);

        this.sun.direction = World3D.sunDirection(c);
        this.sun.intensity = Math.max(0, c.sunIntensity);
        this.sun.diffuse = World3D.hexColor3(c.sunColor);

        const md = scene.metadata || (scene.metadata = {});
        md.arcSun = {
            dir: this.sun.direction.negate().normalize(),
            color: this.sun.diffuse.scale(this.sun.intensity)
        };
        md.arcShadow = {
            color: World3D.hexColor3(o.shadowColor != null ? o.shadowColor : c.shadowColor),
            strength: Math.max(0, Math.min(1, c.shadowStrength))
        };

        const sg = this.shadow;
        const mapSize = IS_MOBILE ? Math.max(512, c.shadowMap / 2) : c.shadowMap;
        // Babylon recreates the target through this setter while retaining its casters.
        // Keep frustum snapping and normal bias in sync with the live texture size.
        if (sg.mapSize !== mapSize) sg.mapSize = mapSize;
        this._mapSize = mapSize;
        sg.setDarkness(0);   // shadow color and strength come from the plugin (ARCSHADOW), Babylon — visibility only
        sg.bias = c.shadowBias;
        // Shadow edge: 0 — hard (one map sample), otherwise PCF (WebGL2) or
        // Poisson (WebGL1); on mobile — no higher than low quality.
        let soft = Math.max(0, Math.min(3, Math.round(c.shadowSoft)));
        if (IS_MOBILE && soft > 1) soft = 1;
        const webgl2 = this.engine.webGLVersion >= 2;
        if (webgl2) {
            sg.usePoissonSampling = false;
            sg.usePercentageCloserFiltering = soft > 0;
            if (soft > 0) {
                sg.filteringQuality = soft >= 3 ? BABYLON.ShadowGenerator.QUALITY_HIGH
                    : (soft === 2 ? BABYLON.ShadowGenerator.QUALITY_MEDIUM : BABYLON.ShadowGenerator.QUALITY_LOW);
            }
        } else {
            sg.usePercentageCloserFiltering = false;
            sg.usePoissonSampling = soft > 0;
        }
        // Normal bias is in map TEXELS: "shadow acne" (stripes and a "sawtooth" on faces
        // at an acute angle to the sun) grows with the texel, and the shadow frustum shrinks
        // and grows (fitShadowFrustum). The edge filter compares depth on neighboring
        // texels too — its radius is added to the constant (PCF 1/3/5 samples —
        // 0.5/1.5/2.5 texels, Poisson — 1), otherwise with a soft edge the "sawtooth"
        // comes back. updateLightFrustum converts it to world px.
        const filter = soft === 0 ? 0 : (webgl2 ? [0, 0.5, 1.5, 2.5][soft] : 1);
        this._normalBiasTexels = Math.max(0, c.shadowNormalBias) + filter;
        // The sun position depends on the direction — recompute the ortho frustum.
        if (this._lightAt) this.updateLightFrustum(this._lightAt.x, this._lightAt.y, this._lightAt.h, this._lightAt.r);
    }

    // The sun's ortho frustum follows the point of interest (usually the camera target):
    // shadows are crisp where the player is looking, not smeared over the whole world.
    // radius — override of the frustum half-size.
    updateLightFrustum(x, y2d, h, radius) {
        const R = radius || this._shadowRadius;
        const d = this.sun.direction;
        const L = View3D.LIGHT_DIST;
        this._lightAt = { x: x, y: y2d, h: h || 0, r: radius };
        this.sun.position = new BABYLON.Vector3(x - d.x * L, (h || 0) - d.y * L, y2d - d.z * L);
        this.sun.orthoLeft = -R;
        this.sun.orthoRight = R;
        this.sun.orthoTop = R;
        this.sun.orthoBottom = -R;
        // Map texel in world px: Babylon expands the frustum by shadowOrthoScale on each side.
        const texel = 2 * R * (1 + 2 * this.sun.shadowOrthoScale) / this._mapSize;
        this.shadow.normalBias = (this._normalBiasTexels || 0) * texel;
    }

    // The sun's ortho frustum fitted to the SHADOW CASTERS the camera has in front of it:
    // the smaller the frustum, the more map texels per world px and the crisper the shadow (a
    // 720 px frustum with a 1024 map gave 0.7 texels per px — the shadow blurred into a blob).
    //   • cam — { x, y, h, dx, dy }: the ground point under the EYE and the unit direction the
    //     camera looks on the map. The box sits three quarters of itself ahead of the camera, so
    //     it covers the ground from just behind the eye out into the frame. It follows the EYE and
    //     not the ground at the frame center, because it is capped by _shadowRadius and cannot
    //     cover the whole frame anyway — so it covers what is CLOSE, where a shadow is large on
    //     screen. Led by the frame center the frame lost its shadows entirely: fly up to a building
    //     and raise your head and that point is a thousand px past the building, toward the
    //     horizon; fly forward and down and it falls BEHIND the camera; from above it sits under
    //     the eye. Pitch is deliberately NOT in this: shortening the reach by cos(pitch) dropped
    //     the shadows of a zoomed-out frame, where the camera is high and everything is far;
    //   • center — the middle of the BOUNDS of the shadow casters (world bounding box) that
    //     fall within maxR (the rest are beyond the screen edge, their shadow is not visible).
    //     By positions the frustum cut off a big model's shadow: a building's position is one point;
    //   • added to the half-size — the height of the shadow casters above the point of
    //     interest as the sun sees it (× cos of the sun elevation: that is how far the top of
    //     an object shifts in the sun's frustum), but no less than PAD;
    //   • the radius is quantized in 32 px steps, the center — to the texel grid: otherwise
    //     the shadow edge "crawls" across texels on every camera shift;
    //   • a shadow caster with thin instances sits at the origin and its bounds would lie —
    //     with it the frustum is taken by maxR.
    fitShadowFrustum(cam, maxR) {
        const R0 = Math.min(maxR || this._shadowRadius, this._shadowRadius);
        const h = cam.h || 0;
        const list = this.shadow ? this.shadow.getShadowMap().renderList : null;
        // The SEED: the caster nearest the eye that is not behind the camera. The box is built
        // around it, so the shadow that is largest on screen is the one that never goes missing —
        // whatever the pitch, the flight height or the zoom. A fixed point ahead of the camera
        // cannot do that: it has to be near enough for a building you stand next to, and far
        // enough for a zoomed-out frame where everything is two thousand px away.
        let seedD = Infinity, sx = 0, sy = 0, wide = false;
        for (let i = 0; list && i < list.length; i++) {
            const m = list[i];
            if (m.hasThinInstances) { wide = true; break; }
            if (!m.isEnabled(false)) continue;
            m.computeWorldMatrix();
            const bb = m.getBoundingInfo().boundingBox, a = bb.minimumWorld, b = bb.maximumWorld;
            const mx = (a.x + b.x) / 2, my = (a.z + b.z) / 2;
            if ((mx - cam.x) * cam.dx + (my - cam.y) * cam.dy < -R0) continue;   // behind the camera
            const d = Math.hypot(mx - cam.x, my - cam.y);
            if (d < seedD) { seedD = d; sx = mx; sy = my; }
        }
        // Nothing to cast (or thin instances, whose bounds would lie): a box ahead of the camera.
        if (wide || seedD === Infinity) {
            const reach = R0 * View3D.SHADOW_AHEAD;
            this.updateLightFrustum(cam.x + cam.dx * reach, cam.y + cam.dy * reach, h, R0);
            return;
        }
        // Everything that fits in a box around the seed. World matrices are already up to date.
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, top = h, bottom = h;
        for (let i = 0; list && i < list.length; i++) {
            const m = list[i];
            if (!m.isEnabled(false)) continue;
            const bb = m.getBoundingInfo().boundingBox, a = bb.minimumWorld, b = bb.maximumWorld;
            if (Math.abs((a.x + b.x) / 2 - sx) > R0 || Math.abs((a.z + b.z) / 2 - sy) > R0) continue;
            if (a.x < x0) x0 = a.x;
            if (b.x > x1) x1 = b.x;
            if (a.z < y0) y0 = a.z;
            if (b.z > y1) y1 = b.z;
            if (b.y > top) top = b.y;
            if (a.y < bottom) bottom = a.y;
        }
        const PAD = 64;   // margin: the soft shadow edge and the corners of the bounds in the sun's frustum
        const dy = this.sun.direction.y;
        const rise = Math.max(top - h, h - bottom) * Math.sqrt(Math.max(0, 1 - dy * dy));
        let R = Math.max(View3D.SHADOW_MIN_RADIUS, Math.max(x1 - x0, y1 - y0) / 2 + Math.max(PAD, rise));
        R = Math.min(R0, Math.ceil(R / 32) * 32);
        // Hysteresis: while the previous radius still fits and is not wider than needed by more
        // than a step, keep it — otherwise at a step boundary R would flip between two
        // values every other frame, and the shadow edge would jitter by a texel.
        const prev = this._fitR;
        if (prev != null && prev <= R0 && prev >= R && prev - R <= 32) R = prev;
        this._fitR = R;
        // Casters spread wider than the box: the middle of their bounds can leave the seed out,
        // and the nearest object would be the one without a shadow. Pull the center back to it.
        let cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
        const lim = Math.max(0, R - PAD), off = Math.hypot(cx - sx, cy - sy);
        if (off > lim) {
            const s = lim / off;
            cx = sx + (cx - sx) * s;
            cy = sy + (cy - sy) * s;
        }
        const q = 2 * R / Math.max(64, this._mapSize);
        this.updateLightFrustum(Math.round(cx / q) * q, Math.round(cy / q) * q, h, R);
    }

    addShadowCaster(mesh, includeDescendants) {
        if (this.shadow && mesh) this.shadow.addShadowCaster(mesh, includeDescendants !== false);
    }

    removeShadowCaster(mesh) {
        if (this.shadow && mesh) this.shadow.removeShadowCaster(mesh, true);
    }

    onBeforeFrame(fn) {
        this._syncFns.push(fn);
        return () => { const i = this._syncFns.indexOf(fn); if (i !== -1) this._syncFns.splice(i, 1); };
    }

    beforeRender() {
        for (const fn of [...this._syncFns]) {
            try { fn(); } catch (e) { console.error('World3D sync:', e); }
        }
    }

    // --- Screen <-> world ---------------------------------------------------

    // The camera was moved, the frame has not been drawn yet — update the projection
    // matrices now (zoom to cursor, "follow the pointer" pan).
    refreshMatrices() {
        const cam = this.camera;
        this.scene.setTransformMatrix(cam.getViewMatrix(true), cam.getProjectionMatrix(true));
    }

    _renderScale() {
        const cw = this.world.canvas.clientWidth || 1;
        return this.engine.getRenderWidth() / cw;
    }

    // Screen point (canvas CSS px) -> map point ({x, y}) under the cursor.
    // With terrain — the ray intersection with the TERRAIN, without it — the plane Y = h.
    // null — the ray looks into the sky.
    pointerToGround(px, py, h, terrain) {
        // createPickingRay expects canvas CSS pixels: it accounts for the render scale
        // (hardwareScalingLevel) ITSELF. Multiplying by _renderScale() moved the point
        // away from the cursor the more, the farther it was from the top-left corner.
        const ray = this.scene.createPickingRay(px, py, BABYLON.Matrix.Identity(), this.camera, false);
        const o = ray.origin, d = ray.direction;
        if (Math.abs(d.y) < 1e-6) return null;
        const planeT = (yy) => (yy - o.y) / d.y;
        if (terrain && terrain.hgrid && Number.isFinite(terrain.hMin)) {
            // March along the ray from a level above the terrain maximum to a level below
            // the minimum; the first step under the surface is refined by bisection.
            let t0 = planeT(terrain.hMax + 1), t1 = planeT(terrain.hMin - 1);
            if (t1 > 0) {
                if (t0 < 0) t0 = 0;
                if (t1 > t0) {
                    const steps = Math.min(200, Math.max(48, Math.ceil((t1 - t0) / 4)));
                    const dt = (t1 - t0) / steps;
                    const under = (t) => (o.y + d.y * t) < terrain.heightAt(o.x + d.x * t, o.z + d.z * t);
                    let ta = t0;
                    for (let i = 1; i <= steps; i++) {
                        const t = t0 + dt * i;
                        if (under(t)) {
                            let a = ta, b = t;
                            for (let j = 0; j < 10; j++) {
                                const m = (a + b) / 2;
                                if (under(m)) b = m; else a = m;
                            }
                            const tm = (a + b) / 2;
                            return { x: o.x + d.x * tm, y: o.z + d.z * tm };
                        }
                        ta = t;
                    }
                }
            }
        }
        const t = planeT(h || 0);
        if (t <= 0) return null;
        return { x: o.x + d.x * t, y: o.z + d.z * t };
    }

    // Map point (x, y and height) -> screen CSS pixels of the canvas.
    // visible — the point is inside the viewport and in front of the camera. Vector3.Project
    // returns RENDER pixels — hence the division by _renderScale().
    projectToScreen(x, y2d, h) {
        const k = this._renderScale();
        const w = this.engine.getRenderWidth(), hh = this.engine.getRenderHeight();
        const p = BABYLON.Vector3.Project(
            new BABYLON.Vector3(x, h || 0, y2d),
            BABYLON.Matrix.Identity(),
            this.scene.getTransformMatrix(),
            this.camera.viewport.toGlobal(w, hh));
        const sx = p.x / k, sy = p.y / k;
        const behind = p.z > 1 || p.z < 0;
        return {
            x: sx, y: sy, behind: behind,
            visible: !behind && sx >= 0 && sy >= 0 && sx <= w / k && sy <= hh / k
        };
    }

    // Everything created in the scene (meshes, materials, outline layers) dies with it.
    dispose() {
        this.active = false;
        if (this.world.view === this) this.world.view = null;
        this._syncFns = [];
        try { this.scene.dispose(); } catch (e) { /* already disposed */ }
        this.scene = null;
    }
}

// Distance from the camera target to the "sun" (center of the shadow ortho frustum), px.
View3D.LIGHT_DIST = 2200;
// Minimum half-size of the shadow ortho frustum: one object with its shadow.
View3D.SHADOW_MIN_RADIUS = 140;
// How far ahead of the camera the shadow frustum sits, in its own half-sizes: the quarter left
// behind covers the ground under and just past the eye, the rest reaches into the frame.
View3D.SHADOW_AHEAD = 0.75;
