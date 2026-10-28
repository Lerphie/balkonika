// CameraControl.js — 3D world camera: target on the map + azimuth + pitch + zoom.
// Zoom is screen px per world px at the look-at point; distance is derived from
// it: dist = H / (2·tan(fov/2)·zoom), H — canvas height in CSS px. The same
// zoom gives the same scale at any FOV and window size.
//
// The target normally sits on the ground; flight lifts it: target.h = ground + lift.
//
// Modes:
//   game (default) — RMB rotation only when CAMERA_ORBIT = 1; LMB is not given to the
//       camera — it is game input; zoom within CAMERA_ZOOM_MIN..MAX. Flight is free by
//       default; CAMERA_LIMITS = 1 turns the limits on: pitch stays within
//       CAMERA_ORBIT_PITCH_MIN/MAX_DEG and never such that the ground edge beyond the
//       location gets into the frame, the target stays inside the location, lift — no
//       higher than CAMERA_LIFT_MAX;
//   free (setFree) — editor: LMB is orbit around the target (Shift+LMB — pan),
//       no limits, wider zoom range.
//
// Input (DOM, no engine): WASD and arrows — flight: W/S along the view (looking
// down — descending), A/D — strafe, Q/E — down/up along the world vertical; RMB —
// look around: the camera stays in place, the target swings around it (while
// following an object — orbit around it); wheel — zoom to cursor; middle button —
// pan "following the pointer" (the ground point stays under the cursor); one
// finger — pan, two fingers — pinch (zoom and pan by the midpoint); R — home
// position (home). Keys are not intercepted while focus is in an input field.
//
// Frame: update(dt) from the owner's loop BEFORE World3D.renderFrame().
// follow(obj) — following an object {x, y} (read every frame) with the lerp
// CAMERA_FOLLOW_LERP (lift settles back to 0); manual pan and flight cancel following.

class CameraController {
    // opts: { terrain?, bounds?: { w, h }, free? }
    constructor(view, opts) {
        const o = opts || {};
        this.view = view;
        this.cam = view.camera;
        this._farClipFloor = Number.isFinite(this.cam.maxZ) && this.cam.maxZ > 0 ? this.cam.maxZ : 9000;
        this._managedFarClip = this._farClipFloor;
        this.terrain = o.terrain || null;
        this.bounds = o.bounds || null;
        this.free = !!o.free;
        this.target = { x: 0, y: 0, h: 0 };
        this.lift = 0;                 // px: target height above the ground (flight: W/S along the view, Q/E)
        this.azimuth = 0;
        this.pitch = 1;
        this.zoom = 1;
        this.zoomTarget = 1;
        this.followObj = null;
        this.ignorePointer = null;     // (e) => true — the press is not for the camera (editor: gizmo under the cursor)
        /** @private @type {{wheel:boolean,panButtons:number[],keyboard:boolean,homeKey:string|null}} */
        this._inputProfile = { wheel: true, panButtons: [1], keyboard: true, homeKey: 'KeyR' };
        this.viewVersion = 0;          // grows with every camera move (re-project overlays)
        this._lastCam = null;
        this._pointers = new Map();    // pointerId -> { x, y, mode: 'pan' | 'orbit' | 'look' | 'touch', anchor }
        this._pinch = null;
        this._keys = new Set();
        this._zoomAnchor = null;       // zoom to cursor: { px, py, x, y, h } — ground point under the cursor
        this._shakeUntil = 0;
        this._shakeAmp = 0;
        this._canvas = null;
        this._bound = null;
        this.applyConstants();
        this.home();
    }

    // Camera constants with defaults. In the game they are lexical consts — typeof only.
    static cfg() {
        const U = 'undefined';
        return {
            fov: ArcConfig.get('CAMERA_FOV_DEG'),
            azimuth: ArcConfig.get('CAMERA_AZIMUTH_DEG'),
            pitch: ArcConfig.get('CAMERA_PITCH_DEG'),
            zoom: ArcConfig.get('CAMERA_ZOOM'),
            zoomMobile: ArcConfig.get('CAMERA_ZOOM_MOBILE'),
            zoomMin: ArcConfig.get('CAMERA_ZOOM_MIN'),
            zoomMax: ArcConfig.get('CAMERA_ZOOM_MAX'),
            wheelStep: ArcConfig.get('CAMERA_ZOOM_WHEEL_STEP'),
            zoomLerp: ArcConfig.get('CAMERA_ZOOM_LERP'),
            followLerp: ArcConfig.get('CAMERA_FOLLOW_LERP'),
            flySpeed: ArcConfig.get('CAMERA_FLY_SPEED'),
            limits: ArcConfig.get('CAMERA_LIMITS'),
            liftMax: ArcConfig.get('CAMERA_LIFT_MAX'),
            orbit: ArcConfig.get('CAMERA_ORBIT'),
            orbitDegPerPx: ArcConfig.get('CAMERA_ORBIT_DEG_PER_PX'),
            pitchMin: ArcConfig.get('CAMERA_ORBIT_PITCH_MIN_DEG'),
            pitchMax: ArcConfig.get('CAMERA_ORBIT_PITCH_MAX_DEG')
        };
    }

    // Re-read the constants (editor — live). FOV and limits take effect immediately;
    // orientation and starting zoom — on home().
    applyConstants() {
        this.c = CameraController.cfg();
        this.cam.fov = Math.max(10, Math.min(120, this.c.fov)) * Math.PI / 180;
        this.zoomTarget = this._clampZoom(this.zoomTarget);
        this.zoom = this._clampZoom(this.zoom);
        this._clampTarget();
        this.lift = this._clampLift(this.lift);
        this.pitch = this._clampPitch(this.pitch);
    }

    // Input policy belongs to this camera, not a snapshot. Partial changes are transactional.
    /** @param {ArcCameraInputProfile} profile @returns {this} */
    setInputProfile(profile) {
        const fail = () => { throw new TypeError('CAMERA_INPUT_PROFILE_INVALID'); };
        if (!profile || typeof profile !== 'object' || Array.isArray(profile)) fail();
        const allowed = ['wheel', 'panButtons', 'keyboard', 'homeKey'];
        if (Reflect.ownKeys(profile).some(key => typeof key !== 'string' || !allowed.includes(key))) fail();
        const next = { ...this._inputProfile, panButtons: [...this._inputProfile.panButtons] };
        if (Object.hasOwn(profile, 'wheel')) { if (typeof profile.wheel !== 'boolean') fail(); next.wheel = profile.wheel; }
        if (Object.hasOwn(profile, 'keyboard')) { if (typeof profile.keyboard !== 'boolean') fail(); next.keyboard = profile.keyboard; }
        if (Object.hasOwn(profile, 'homeKey')) {
            if (profile.homeKey !== null && (typeof profile.homeKey !== 'string' || !profile.homeKey || profile.homeKey.trim() !== profile.homeKey)) fail();
            next.homeKey = profile.homeKey;
        }
        if (Object.hasOwn(profile, 'panButtons')) {
            const buttons = profile.panButtons;
            if (!Array.isArray(buttons) || Array.from(buttons).some(button => ![0, 1, 2].includes(button)) || new Set(buttons).size !== buttons.length) fail();
            next.panButtons = [...buttons];
        }
        // Release owned captures before discarding their gesture state.
        for (const pointerId of this._pointers.keys()) {
            try { this._canvas?.releasePointerCapture(pointerId); } catch (_) { /* No capture for synthetic events. */ }
        }
        this._inputProfile = next;
        this._pointers.clear(); this._pinch = null; this._keys.clear(); this._zoomAnchor = null;
        return this;
    }

    // Home position: orientation and zoom from the constants, target — the followed
    // object or the location center, on the ground.
    home() {
        const c = this.c, D = Math.PI / 180;
        const small = IS_MOBILE && Math.max(window.innerWidth || 0, window.innerHeight || 0) < 1024;
        this.zoomTarget = this._clampZoom(small ? c.zoomMobile : c.zoom);
        this.zoom = this.zoomTarget;
        this._zoomAnchor = null;
        this.azimuth = c.azimuth * D;
        const f = this.followObj;
        this.lookAt(f ? f.x : (this.bounds ? this.bounds.w / 2 : 0), f ? f.y : (this.bounds ? this.bounds.h / 2 : 0));
        this.pitch = this._clampPitch(c.pitch * D);
        this._apply();
    }

    // Target onto the ground point (x, y): flight height is dropped.
    lookAt(x, y) {
        this.target.x = x;
        this.target.y = y;
        this.lift = 0;
        this._clampTarget();
        this.target.h = this._groundH(this.target.x, this.target.y);
    }

    follow(obj) { this.followObj = obj || null; }

    setFree(on) {
        this.free = !!on;
        this.zoomTarget = this._clampZoom(this.zoomTarget);
        this.zoom = this._clampZoom(this.zoom);
        this._clampTarget();
        this.lift = this._clampLift(this.lift);
        this.pitch = this._clampPitch(this.pitch);
    }

    // Location rebuilt (editor): new terrain and dimensions.
    setTerrain(terrain, bounds) {
        this.terrain = terrain || null;
        if (bounds) this.bounds = bounds;
        this._clampTarget();
        this.target.h = this._groundH(this.target.x, this.target.y) + this.lift;
    }

    // Ground point at the frame center: { x, y, h, k }. The target lifted off the ground
    // (flight) — the view ray lands farther ahead; k — how many times farther than the
    // target the ground is along the ray (the frame's reach on the ground grows with it).
    groundFocus() {
        const t = this.target, sp = Math.sin(this.pitch), dist = this.distance();
        const k = sp > 0.05 ? Math.max(0.25, Math.min(4, 1 + this.lift / (sp * dist))) : 4;   // toward the horizon — capped
        const run = (k - 1) * dist * Math.cos(this.pitch);
        const x = t.x + Math.cos(this.azimuth) * run, y = t.y + Math.sin(this.azimuth) * run;
        return { x: x, y: y, h: this._groundH(x, y), k: k };
    }

    // --- Screen <-> world ---------------------------------------------------------

    distance() {
        const h = (this.view.world.canvas && this.view.world.canvas.clientHeight) || 600;
        return h / (2 * Math.tan(this.cam.fov / 2) * Math.max(0.02, this.zoom));
    }

    // World px per screen px at the look-at point.
    worldPerScreenPx() {
        return 1 / Math.max(0.02, this.zoom);
    }

    // Screen shift (dx right, dy down) -> shift on the map, accounting for azimuth.
    // Forward along the view = (cos az, sin az); right on screen in a right-handed
    // scene — (−sin az, cos az). At azimuth −90° (north up) this is (dx, dy) / zoom.
    screenDeltaToWorld(dx, dy) {
        const k = this.worldPerScreenPx();
        const ca = Math.cos(this.azimuth), sa = Math.sin(this.azimuth);
        return { x: (-sa * dx - ca * dy) * k, y: (ca * dx - sa * dy) * k };
    }

    // The inverse: shift on the map -> screen px.
    worldDeltaToScreen(wx, wy) {
        const k = this.worldPerScreenPx();
        const ca = Math.cos(this.azimuth), sa = Math.sin(this.azimuth);
        return { x: (-sa * wx + ca * wy) / k, y: -(ca * wx + sa * wy) / k };
    }

    // Shake: intensity — fraction of the frame (0.01 — light), converted to world px.
    shake(ms, intensity) {
        const amp = Math.min(40, (intensity || 0.01) * 600);
        this._shakeAmp = Math.max(this._shakeAmp * (this._shakeUntil > performance.now() ? 1 : 0), amp);
        this._shakeUntil = performance.now() + (ms || 200);
    }

    // --- Limits -------------------------------------------------------------------

    _clampZoom(z) {
        const c = this.c;
        const lo = this.free ? Math.min(c.zoomMin, 0.12) : c.zoomMin;
        const hi = Math.max(lo, this.free ? Math.max(c.zoomMax, 6) : c.zoomMax);
        return Math.max(lo, Math.min(hi, Number.isFinite(z) ? z : 1));
    }

    // Game camera limits (CAMERA_LIMITS = 1): pitch, target inside the location, flight ceiling.
    _limited() {
        return !this.free && this.c.limits > 0;
    }

    _clampTarget() {
        if (!this._limited() || !this.bounds) return;
        this.target.x = Math.max(0, Math.min(this.bounds.w, this.target.x));
        this.target.y = Math.max(0, Math.min(this.bounds.h, this.target.y));
    }

    // With limits: flight no higher than CAMERA_LIFT_MAX (above it the ground edge gets into
    // the frame). From below lift is held by the camera itself — _floorEye.
    _clampLift(v) {
        return this._limited() ? Math.min(Math.max(0, this.c.liftMax), v) : v;
    }

    _clampPitch(p) {
        const D = Math.PI / 180, F = CameraController.FREE_PITCH;
        if (!this._limited()) return Math.max(F.min * D, Math.min(F.max * D, p));   // setTarget degenerates near ±90°
        const top = Math.max(1, Math.min(89, this.c.pitchMax)) * D;
        const floor = Math.min(top, Math.max(1, this.c.pitchMin) * D);
        return Math.max(this._edgePitchMin(floor, top), Math.min(top, p));
    }

    // Lower pitch limit of the game camera: the far (upper) frame corners land on the
    // ground closer than the edge of the ring beyond the location (Terrain3D.outerRing) —
    // the ground cutoff and the sky below it are not visible. The target is inside the
    // location, so the ring edge is at least the ring width away from it in any direction.
    // The frame-corner ray is intersected with the plane of the lowest terrain; the reach
    // falls monotonically as pitch grows — bisection. Zoom changes distance, so the limit is live.
    _edgePitchMin(floor, top) {
        const t = this.terrain;
        if (!t || !(t.outerRing > 0)) return floor;
        const reach = t.outerRing * 0.85;   // margin: the ring is coarse, distant terrain is higher/lower
        const dist = this.distance();
        const drop = Math.max(0, this.target.h - (Number.isFinite(t.hMin) ? t.hMin : 0));
        const tV = Math.tan(this.cam.fov / 2);
        const tH = tV * this.view.engine.getAspectRatio(this.cam);
        const far = (p) => {
            const sp = Math.sin(p), cp = Math.cos(p);
            const fall = sp - tV * cp;          // descent of the upper frame-corner ray
            if (fall <= 1e-4) return Infinity;  // ray toward the horizon — sky in the frame
            const s = (dist * sp + drop) / fall;
            return Math.hypot(s * (cp + tV * sp) - dist * cp, s * tH);
        };
        if (far(floor) <= reach) return floor;
        if (far(top) > reach) return top;
        let lo = floor, hi = top;
        for (let i = 0; i < 16; i++) {
            const mid = (lo + hi) / 2;
            if (far(mid) > reach) lo = mid; else hi = mid;
        }
        return hi;
    }

    _groundH(x, y) {
        return this.terrain ? this.terrain.heightAt(x, y) : 0;
    }

    // --- Flight and look-around -----------------------------------------------------

    // Camera position from target, azimuth, pitch and zoom — without shake and the ground floor.
    _eye() {
        const d = this.distance(), cp = Math.cos(this.pitch);
        return {
            x: this.target.x - Math.cos(this.azimuth) * cp * d,
            y: this.target.y - Math.sin(this.azimuth) * cp * d,
            h: this.target.h + Math.sin(this.pitch) * d
        };
    }

    // Target to a free point in space: its height above the ground becomes lift.
    _setTarget3(x, y, h) {
        this.target.x = x;
        this.target.y = y;
        this._clampTarget();
        const ground = this._groundH(this.target.x, this.target.y);
        this.lift = this._clampLift(h - ground);
        this.target.h = ground + this.lift;
    }

    // Flight does not take the camera below ground + EYE_MIN: the target rises with it,
    // the view direction stays.
    _floorEye() {
        const e = this._eye();
        const low = this._groundH(e.x, e.y) + CameraController.EYE_MIN - e.h;
        if (low > 0) {
            this.lift += low;
            this.target.h += low;
        }
    }

    // Flight by step px: fwd — along the view (pitch included), right — strafe, up — world
    // vertical. The view and the vertical are not perpendicular — the sum is normalized in the world.
    _fly(fwd, right, up, step) {
        const ca = Math.cos(this.azimuth), sa = Math.sin(this.azimuth);
        const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
        const vx = ca * cp * fwd - sa * right, vy = sa * cp * fwd + ca * right, vh = up - sp * fwd;
        const len = Math.hypot(vx, vy, vh);
        if (len < 1e-6) return;
        const k = step / len;
        this._setTarget3(this.target.x + vx * k, this.target.y + vy * k, this.target.h + vh * k);
        this._floorEye();
        this.followObj = null;
        this._zoomAnchor = null;
    }

    // Look around: azimuth and pitch change, the camera stays in place — the target swings around it.
    _look(dAzimuth, dPitch) {
        const e = this._eye();
        this.azimuth += dAzimuth;
        this.pitch = this._clampPitch(this.pitch + dPitch);
        const d = this.distance(), cp = Math.cos(this.pitch);
        this._setTarget3(
            e.x + Math.cos(this.azimuth) * cp * d,
            e.y + Math.sin(this.azimuth) * cp * d,
            e.h - Math.sin(this.pitch) * d);
    }

    // --- Input ----------------------------------------------------------------------

    attach(canvas) {
        this.detach();
        this._canvas = canvas;
        const b = this._bound = {
            down: (e) => this._onDown(e),
            move: (e) => this._onMove(e),
            up: (e) => this._onUp(e),
            wheel: (e) => this._onWheel(e),
            menu: (e) => e.preventDefault(),
            key: (e) => this._onKey(e, true),
            keyUp: (e) => this._onKey(e, false),
            blur: () => this._keys.clear()
        };
        canvas.addEventListener('pointerdown', b.down);
        canvas.addEventListener('pointermove', b.move);
        canvas.addEventListener('pointerup', b.up);
        canvas.addEventListener('pointercancel', b.up);
        canvas.addEventListener('wheel', b.wheel, { passive: false });
        canvas.addEventListener('contextmenu', b.menu);
        window.addEventListener('keydown', b.key);
        window.addEventListener('keyup', b.keyUp);
        window.addEventListener('blur', b.blur);
        canvas.style.touchAction = 'none';
    }

    detach() {
        const c = this._canvas, b = this._bound;
        if (c && b) {
            c.removeEventListener('pointerdown', b.down);
            c.removeEventListener('pointermove', b.move);
            c.removeEventListener('pointerup', b.up);
            c.removeEventListener('pointercancel', b.up);
            c.removeEventListener('wheel', b.wheel);
            c.removeEventListener('contextmenu', b.menu);
            window.removeEventListener('keydown', b.key);
            window.removeEventListener('keyup', b.keyUp);
            window.removeEventListener('blur', b.blur);
        }
        this._canvas = null;
        this._bound = null;
        this._pointers.clear();
        this._pinch = null;
        this._keys.clear();
    }

    isDragging() { return this._pointers.size > 0; }

    _local(e) {
        const r = this._canvas.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    // Ground point under a screen point (following the terrain) — anchor for pan and zoom.
    _pick(px, py) {
        this._syncCamera();
        this.view.refreshMatrices();
        const hit = this.view.pointerToGround(px, py, this.target.h, this.terrain);
        return hit ? { x: hit.x, y: hit.y, h: this._groundH(hit.x, hit.y) } : null;
    }

    // Move the target so that the ground point anchor ends up under the screen point.
    // Intersection — with the plane at the anchor's height: otherwise the point would jump
    // on slopes. Two passes: moving the target changes the ground height under it, and with
    // it the camera — one pass on a jerk of a hundred px left an error of several px.
    _dragTo(anchor, px, py) {
        for (let pass = 0; pass < 2; pass++) {
            this._syncCamera();
            this.view.refreshMatrices();
            const hit = this.view.pointerToGround(px, py, anchor.h, null);
            if (!hit) return;
            this.target.x += anchor.x - hit.x;
            this.target.y += anchor.y - hit.y;
            this._clampTarget();
            this.target.h = this._groundH(this.target.x, this.target.y) + this.lift;
        }
    }

    _onDown(e) {
        if (this.ignorePointer && this.ignorePointer(e)) return;
        let mode = null;
        if (e.pointerType === 'touch') mode = 'touch';
        else if (this._inputProfile.panButtons.includes(e.button) || (e.button === 0 && this.free && e.shiftKey)) mode = 'pan';
        else if (e.button === 2 && (this.free || this.c.orbit > 0)) mode = this.followObj ? 'orbit' : 'look';
        else if (e.button === 0 && this.free) mode = 'orbit';
        if (!mode) return;
        e.preventDefault();
        try { this._canvas.setPointerCapture(e.pointerId); } catch (err) { /* synthetic event */ }
        const p = this._local(e);
        const rec = { x: p.x, y: p.y, mode: mode, anchor: null };
        if (mode === 'pan' || mode === 'touch') {
            rec.anchor = this._pick(p.x, p.y);
            this.followObj = null;
        }
        this._pointers.set(e.pointerId, rec);
        this._zoomAnchor = null;
        if (mode === 'touch' && this._touches().length === 2) this._startPinch();
    }

    _onMove(e) {
        const rec = this._pointers.get(e.pointerId);
        if (!rec) return;
        const p = this._local(e);
        const k = this.c.orbitDegPerPx * Math.PI / 180;
        if (rec.mode === 'look') {
            this._look((p.x - rec.x) * k, (p.y - rec.y) * k);
        } else if (rec.mode === 'orbit') {
            // Orbit without limits does not go under the target: the pitch floor is higher than
            // for look-around (a pitch already below it only rises).
            const floor = this._limited() ? -Infinity : Math.min(this.pitch, CameraController.FREE_PITCH.orbitMin * Math.PI / 180);
            this.azimuth += (p.x - rec.x) * k;
            this.pitch = Math.max(floor, this._clampPitch(this.pitch + (p.y - rec.y) * k));
        } else if (this._pinch && rec.mode === 'touch') {
            rec.x = p.x;
            rec.y = p.y;
            this._applyPinch();
        } else if (rec.anchor) {
            this._dragTo(rec.anchor, p.x, p.y);
        }
        rec.x = p.x;
        rec.y = p.y;
        this._apply();
    }

    _onUp(e) {
        if (!this._pointers.delete(e.pointerId)) return;
        if (this._pinch && this._touches().length < 2) {
            this._pinch = null;
            // The remaining finger continues the pan from its current point.
            for (const rec of this._touches()) rec.anchor = this._pick(rec.x, rec.y);
        }
    }

    _touches() {
        return [...this._pointers.values()].filter(r => r.mode === 'touch');
    }

    _startPinch() {
        const [a, b] = this._touches();
        this._pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), anchor: this._pick((a.x + b.x) / 2, (a.y + b.y) / 2) };
    }

    // Pinch: distance between the fingers — zoom (immediate, no lerp), midpoint — pan.
    _applyPinch() {
        const [a, b] = this._touches();
        if (!a || !b) return;
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (this._pinch.dist > 1 && d > 1) {
            this.zoomTarget = this._clampZoom(this.zoomTarget * d / this._pinch.dist);
            this.zoom = this.zoomTarget;
        }
        this._pinch.dist = d;
        if (this._pinch.anchor) this._dragTo(this._pinch.anchor, (a.x + b.x) / 2, (a.y + b.y) / 2);
    }

    // Wheel: zoom to cursor. The ground point under the cursor is remembered and kept under
    // it while the zoom settles by lerp (update). When following — zoom around the target.
    _onWheel(e) {
        if (!this._inputProfile.wheel) return;
        e.preventDefault();
        if (!e.deltaY) return;
        const notches = Math.max(-1, Math.min(1, e.deltaY / 100));   // mouse ~100 per notch, touchpad — small steps
        this.zoomTarget = this._clampZoom(this.zoomTarget * Math.pow(1 + this.c.wheelStep, -notches));
        if (this.followObj) { this._zoomAnchor = null; return; }
        const p = this._local(e);
        const hit = this._pick(p.x, p.y);
        this._zoomAnchor = hit ? { px: p.x, py: p.y, x: hit.x, y: hit.y, h: hit.h } : null;
    }

    _onKey(e, down) {
        // A captured press may be released over an input or while a modifier is held.
        // Always release it before considering whether a new press belongs to the camera.
        if (!down) {
            this._keys.delete(e.code);
            return;
        }
        if (!this._inputProfile.keyboard) return;
        const t = e.target;
        if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (this._inputProfile.homeKey !== null && e.code === this._inputProfile.homeKey) {
            e.preventDefault();
            if (!e.repeat) this.home();
            return;
        }
        if (CameraController.FLY_KEYS[e.code]) {
            if (down) this._keys.add(e.code); else this._keys.delete(e.code);
            e.preventDefault();
            return;
        }
    }

    // --- Frame ----------------------------------------------------------------------

    update(dt) {
        dt = Math.min(0.1, Math.max(0, dt || 0));
        const c = this.c, f60 = dt * 60;

        if (this._keys.size) {
            const K = CameraController.FLY_KEYS;
            let fwd = 0, right = 0, up = 0;
            for (const code of this._keys) { fwd += K[code][0]; right += K[code][1]; up += K[code][2]; }
            // Speed is set in screen px: farther from the target (zoomed out) — faster over the world.
            if (fwd || right || up) this._fly(fwd, right, up, c.flySpeed * this.worldPerScreenPx() * dt);
        }

        if (Math.abs(this.zoom - this.zoomTarget) > 1e-4) {
            this.zoom += (this.zoomTarget - this.zoom) * (1 - Math.pow(1 - c.zoomLerp, f60));
        } else {
            this.zoom = this.zoomTarget;
        }

        const f = this.followObj;
        if (f) {
            const k = 1 - Math.pow(1 - c.followLerp, f60);
            this.target.x += (f.x - this.target.x) * k;
            this.target.y += (f.y - this.target.y) * k;
            this.lift -= this.lift * k;
            this._clampTarget();
        }
        this.target.h = this._groundH(this.target.x, this.target.y) + this.lift;
        this.pitch = this._clampPitch(this.pitch);   // zoom changes the frame's reach — and the pitch limit

        const a = this._zoomAnchor;
        if (a) {
            this._dragTo(a, a.px, a.py);
            if (this.zoom === this.zoomTarget) this._zoomAnchor = null;
        }
        this._apply();
    }

    // Babylon camera position and target: back from the target along the azimuth by the
    // distance from zoom, at angle pitch to the ground, no lower than ground + EYE_MIN.
    _syncCamera() {
        const e = this._eye();
        const px = e.x, pz = e.y;
        const py = Math.max(e.h, this._groundH(px, pz) + CameraController.EYE_MIN);
        let sx = 0, sy = 0, sh = 0;
        const now = performance.now();
        if (this._shakeUntil > now) {
            const amp = this._shakeAmp * Math.min(1, (this._shakeUntil - now) / 200);
            sx = (Math.random() * 2 - 1) * amp;
            sy = (Math.random() * 2 - 1) * amp;
            sh = (Math.random() * 2 - 1) * amp * 0.5;
        } else {
            this._shakeAmp = 0;
        }
        this.cam.position.set(px + sx, py + sh, pz + sy);
        this.cam.setTarget(new BABYLON.Vector3(this.target.x + sx, this.target.h + sh, this.target.y + sy));
        // An overview may place the camera farther away than its original far plane.
        // Keep the overview target and bounded map in range, returning to the user's floor
        // when zooming in. A later explicit maxZ change becomes the new floor.
        if (Number.isFinite(this.cam.maxZ) && this.cam.maxZ > 0 && this.cam.maxZ !== this._managedFarClip) this._farClipFloor = this.cam.maxZ;
        const cv = this.view.world.canvas;
        const frameReach = Math.hypot((cv && cv.clientWidth) || 800, (cv && cv.clientHeight) || 600) * this.worldPerScreenPx();
        const mapReach = this.bounds ? Math.hypot(this.bounds.w, this.bounds.h) : 0;
        const distance = Math.hypot(px - this.target.x, py - this.target.h, pz - this.target.y);
        this._managedFarClip = Math.max(this._farClipFloor, distance + Math.max(mapReach, frameReach));
        this.cam.maxZ = this._managedFarClip;
    }

    _apply() {
        this._syncCamera();
        // Shadow frustum — fitted to the objects in front of the camera: the tighter, the sharper
        // the shadow. The camera hands over where it STANDS and which way it looks on the map; how
        // far ahead to put the box is View3D's call, it knows its own size. Not groundFocus(): that
        // point is the ground at the frame center, and it is useless as a shadow center — next to a
        // building with the head raised it lands a thousand px past the building, in flight forward
        // and down it falls behind the camera, and from above it sits under the eye.
        // maxR is the frame's own footprint, a request: the box is tightened by the caster bounds.
        const cv = this.view.world.canvas, e = this._eye();
        const halfDiag = 0.5 * Math.hypot((cv && cv.clientWidth) || 800, (cv && cv.clientHeight) || 600) * this.worldPerScreenPx();
        this.view.fitShadowFrustum({
            x: e.x, y: e.y, h: this._groundH(e.x, e.y),
            dx: Math.cos(this.azimuth), dy: Math.sin(this.azimuth),
        }, halfDiag + 80);
        const p = this.cam.position, t = this.target, lc = this._lastCam;
        if (!lc || Math.abs(lc[0] - p.x) > 0.02 || Math.abs(lc[1] - p.y) > 0.02 || Math.abs(lc[2] - p.z) > 0.02 ||
            Math.abs(lc[3] - t.x) > 0.02 || Math.abs(lc[4] - t.y) > 0.02 || Math.abs(lc[5] - t.h) > 0.02) {
            this.viewVersion++;
            this._lastCam = [p.x, p.y, p.z, t.x, t.y, t.h];
        }
    }
}

// Flight keys: key code -> [forward along the view, right, up along the world vertical].
CameraController.FLY_KEYS = {
    KeyW: [1, 0, 0], ArrowUp: [1, 0, 0], KeyS: [-1, 0, 0], ArrowDown: [-1, 0, 0],
    KeyA: [0, -1, 0], ArrowLeft: [0, -1, 0], KeyD: [0, 1, 0], ArrowRight: [0, 1, 0],
    KeyQ: [0, 0, -1], KeyE: [0, 0, 1]
};

CameraController.EYE_MIN = 40;   // px: the camera no lower than this above the ground under it

// Free camera pitch, °: look-around — almost the full sphere, orbit — not under the target.
CameraController.FREE_PITCH = { min: -85, max: 88, orbitMin: 8 };
