// Gltf3D.js — glTF/GLB models: skeleton, animation clips, textures. Called through Model3D
// (load / build / dispose pick the loader by the file extension); the clips of a built model —
// Model3D.clips(root). Needs libs/babylonjs.loaders.min.js; without it the model fails to
// load like a missing file, the scene doesn't crash.
//
// UNITS: glTF is meters, the kit's world is px = centimeters — the model is scaled by 100.
// AXES: the glTF front is +Z, the kit's model nose is +X — the model is turned by 90° about Y.
// MATERIALS: glTF gives PBR, the toon shader lives on StandardMaterial — every build gets its
// own StandardMaterial: base color (linear -> gamma, like FBX), base color texture, normal map,
// alpha, culling and sideOrientation (glTF front faces are counter-clockwise — the loader
// sets the flag on the material, losing it turns the model inside out).
// CLIPS: glTF animations by name — Clips3D: play('run') cross-fades from the current clip.

/** @satisfies {Record<string, any>} */
const Gltf3D = {
    UNITS: 100,              // glTF meters -> world px (1 cm = 1 px, like FBX)
    _cache: new Map(),       // scene uid + url -> Promise<model>: the file is loaded once per scene
    _clips: new WeakMap(),   // model root -> Clips3D
    _clocks: new WeakMap(),  // scene -> clock mode and the clips created in that scene

    _clock(scene) {
        let state = this._clocks.get(scene);
        if (!state) {
            state = { manual: false, enabled: scene.animationsEnabled !== false, evaluating: false, clips: new Set() };
            this._clocks.set(scene, state);
        }
        return state;
    },

    // The manual clock owns ALL Babylon animations in this scene, including models loaded later.
    // Ordinary renders can still run while paused without advancing animation time.
    setManualClock(scene, on) {
        const state = this._clock(scene), manual = !!on;
        if (state.manual === manual) return;
        if (manual) state.enabled = scene.animationsEnabled;
        state.manual = manual;
        scene.animationsEnabled = manual ? false : state.enabled;
        // Switching back to automatic time must not consume the wall time spent paused.
        if (!manual) scene._animationTimeLast = 0;
    },

    // Babylon's typed custom-delta hook preserves its interpolation, skinning and weighted
    // binding semantics. Keep this adapter covered against the bundled Babylon version.
    _evaluate(scene, dt) {
        const state = this._clock(scene);
        if (state.evaluating) return;
        const enabled = scene.animationsEnabled;
        state.evaluating = true;
        scene.animationsEnabled = true;
        try { scene._animate(dt * 1000); }
        finally { scene.animationsEnabled = enabled; state.evaluating = false; }
    },

    advance(scene, dt) {
        if (!Number.isFinite(dt) || dt < 0) throw new RangeError('ANIMATION_DT_INVALID');
        const state = this._clock(scene);
        if (!state.manual) throw new Error('ANIMATION_CLOCK_NOT_MANUAL');
        for (const clips of state.clips) if (!clips.paused) clips._tick(dt);
        this._evaluate(scene, dt);
    },

    snapshot(scene) {
        const state = this._clock(scene);
        return { version: 1, manual: state.manual, clips: [...state.clips].map(clips => clips.snapshot()) };
    },

    validateSnapshot(scene, snapshot) {
        const state = this._clock(scene), clips = [...state.clips];
        if (!snapshot || snapshot.version !== 1 || typeof snapshot.manual !== 'boolean' ||
            !Array.isArray(snapshot.clips) || snapshot.clips.length !== clips.length) throw new Error('ANIMATION_SNAPSHOT_INVALID');
        // Validate all models before changing any of them. A snapshot is for the same live
        // model set (in creation order); scene/entity reconstruction belongs to the app.
        clips.forEach((clip, i) => clip.validateSnapshot(snapshot.clips[i]));
        return clips;
    },

    restore(scene, snapshot) {
        const clips = this.validateSnapshot(scene, snapshot);
        this.setManualClock(scene, snapshot.manual);
        clips.forEach((clip, i) => clip._restoreStart(snapshot.clips[i]));
        this._evaluate(scene, 0);
        clips.forEach((clip, i) => clip._restoreFinish(snapshot.clips[i]));
    },

    is(url) {
        return /\.(glb|gltf)(\?|$)/i.test(String(url));
    },

    // url -> Promise<{ gltf: true, container, clips: [names] }>. The container stays out of the
    // scene: build() instantiates it. It dies with the scene.
    load(url, scene) {
        if (scene.isDisposed) return Promise.reject(new Error('GLTF_SCENE_DISPOSED'));
        const key = scene.uid + '|' + url;
        let p = this._cache.get(key);
        if (!p) {
            let disposed = false;
            /** @type {BABYLON.AssetContainer | null} */ let owned = null;
            const evict = () => { if (this._cache.get(key) === p) this._cache.delete(key); };
            // Subscribe before starting the request: Babylon does not replay onDispose to
            // observers registered after disposal. Pending cache entries must die too.
            const observer = scene.onDisposeObservable.addOnce(() => {
                disposed = true;
                evict();
                if (owned) owned.dispose();
            });
            p = Promise.resolve().then(() => {
                if (disposed || scene.isDisposed) throw new Error('GLTF_SCENE_DISPOSED');
                // Every imported node needs its own Mesh for material conversion and
                // thin-instance baking, including nodes that reuse a glTF mesh.
                return BABYLON.LoadAssetContainerAsync(url, scene, { pluginOptions: { gltf: { createInstances: false } } });
            }).then((container) => {
                if (disposed || scene.isDisposed) {
                    container.dispose();
                    throw new Error('GLTF_SCENE_DISPOSED');
                }
                owned = container;
                for (const g of container.animationGroups) g.stop();   // the loader starts the first one
                return { gltf: true, container, clips: container.animationGroups.map(g => g.name) };
            });
            this._cache.set(key, p);
            p.catch(() => {
                evict();   // errors are not cached: the file may be added later
                scene.onDisposeObservable.remove(observer);
            });
        }
        return p;
    },

    // Model -> root mesh without geometry; each call gets its own meshes, skeleton, clips and
    // materials. opts: { name }.
    build(model, scene, opts) {
        const name = (opts && opts.name) || 'model';
        const root = new BABYLON.Mesh(name, scene);
        const fit = new BABYLON.TransformNode(name + '/gltf', scene);
        fit.scaling.setAll(Gltf3D.UNITS);
        fit.rotation.y = Math.PI / 2;
        fit.parent = root;
        const inst = model.container.instantiateModelsToScene((n) => name + '/' + n, false, { doNotInstantiate: true });
        for (const node of inst.rootNodes) node.parent = fit;

        const mats = new Map();
        for (const mesh of root.getChildMeshes(false)) {
            if (!mesh.material) continue;
            if (!mats.has(mesh.material)) mats.set(mesh.material, this._standard(mesh.material, name, scene));
            mesh.material = mats.get(mesh.material);
        }

        const clips = new Clips3D(scene, inst.animationGroups, model.clips);
        this._clips.set(root, clips);
        root.onDisposeObservable.addOnce(() => {
            clips.dispose();
            for (const s of inst.skeletons) s.dispose();
        });
        return root;
    },

    clips(root) {
        return (root && this._clips.get(root)) || null;
    },

    // glTF material (PBR) -> StandardMaterial for the toon shader.
    _standard(src, name, scene) {
        const m = new BABYLON.StandardMaterial(name + '/' + src.name, scene);
        const pbr = /** @type {BABYLON.PBRMaterial} */ (src);
        if (pbr.albedoColor) m.diffuseColor = pbr.albedoColor.toGammaSpace();
        if (pbr.albedoTexture) {
            m.diffuseTexture = pbr.albedoTexture;
            m.useAlphaFromDiffuseTexture = pbr.useAlphaFromAlbedoTexture;
        }
        if (pbr.bumpTexture) {
            m.bumpTexture = pbr.bumpTexture;
            m.invertNormalMapX = pbr.invertNormalMapX;
            m.invertNormalMapY = pbr.invertNormalMapY;
        }
        m.alpha = src.alpha;
        m.transparencyMode = src.transparencyMode;
        m.alphaCutOff = pbr.alphaCutOff != null ? pbr.alphaCutOff : m.alphaCutOff;
        m.backFaceCulling = src.backFaceCulling;
        m.sideOrientation = src.sideOrientation;
        return m;
    }
};

// Animation clips of one built model. play(name) starts the clip and cross-fades to it from
// whatever is playing; the weights move by themselves every frame (before the scene's animations).
class Clips3D {
    // groups — this model's AnimationGroups, names — their clip names in the file.
    constructor(scene, groups, names) {
        this.scene = scene;
        this.current = '';
        /** @type {Map<string, { group: BABYLON.AnimationGroup, weight: number, frame: number }>} */
        this.tracks = new Map();
        groups.forEach((group, i) => this.tracks.set(names[i] || group.name, { group, weight: 0, frame: group.from }));
        this.blend = Clips3D.blendSec();
        this._then = '';
        this.paused = false;
        const clock = Gltf3D._clock(scene);
        clock.clips.add(this);
        for (const [name, t] of this.tracks) {
            // One observer per track: changing loop/then on a playing clip never stacks
            // stale completion handlers. stop() clears current before stopping groups.
            t.group.onAnimationGroupEndObservable.add(() => {
                t.frame = t.group.to;
                if (this.current === name && !t.group.loopAnimation && this._then) this.play(this._then);
            });
        }
        this._observer = scene.onBeforeAnimationsObservable.add(() => {
            if (!clock.manual && !this.paused) this._tick(scene.getEngine().getDeltaTime() / 1000);
        });
    }

    static blendSec() {
        return ArcConfig.get('MODEL_CLIP_BLEND_SEC');
    }

    names() {
        return [...this.tracks.keys()];
    }

    has(name) {
        return this.tracks.has(name);
    }

    // opts: { loop = true, speed = 1, blend = MODEL_CLIP_BLEND_SEC, then — the clip to play after a
    // non-looped one ends }. false — the model has no such clip.
    play(name, opts) {
        const t = this.tracks.get(name), o = opts || {};
        if (!t) return false;
        const loop = o.loop !== false, speed = o.speed > 0 ? o.speed : 1;
        this.blend = o.blend >= 0 ? o.blend : Clips3D.blendSec();
        this._then = loop ? '' : String(o.then || '');
        const starting = this.current !== name || !(t.group.isStarted || t.group.isPlaying);
        if (starting) {
            const first = ![...this.tracks.values()].some(x => x.weight > 0);
            t.group.start(loop, speed, t.group.from, t.group.to, false);
            t.frame = t.group.from;
            t.weight = first ? 1 : t.weight;
            t.group.setWeightForAllAnimatables(t.weight);
        } else {
            t.group.speedRatio = speed;
            t.group.loopAnimation = loop;
        }
        this.current = name;
        if (starting && Gltf3D._clock(this.scene).manual) Gltf3D._evaluate(this.scene, 0);
        if (this.paused) t.group.pause();
        return true;
    }

    // Stop everything: the model returns to its rest pose.
    stop() {
        this.current = '';
        this._then = '';
        for (const t of this.tracks.values()) {
            t.weight = 0;
            t.group.stop(true);
            t.group.reset();
            t.frame = t.group.from;
        }
    }

    pause() {
        this.paused = true;
        for (const t of this.tracks.values()) if (t.group.isPlaying) t.group.pause();
    }

    resume() {
        this.paused = false;
        for (const t of this.tracks.values()) if (t.group.isStarted && !t.group.isPlaying) t.group.restart();
        if (Gltf3D._clock(this.scene).manual) Gltf3D._evaluate(this.scene, 0);
    }

    snapshot() {
        return {
            current: this.current, then: this._then, blend: this.blend, paused: this.paused,
            // Inactive clips do not define the bind/rest pose. Capture the channels too,
            // so restoring a never-played or stopped model does not keep a later pose.
            pose: this._poseBindings().map(b => ({ key: b.key, value: typeof b.owner[b.property] === 'number' ?
                b.owner[b.property] : Array.from(b.owner[b.property].asArray()) })),
            tracks: [...this.tracks].map(([name, t]) => ({
                name, frame: t.group.isStarted ? t.group.getCurrentFrame() : t.frame,
                active: !!t.group.isStarted, paused: !!t.group.isStarted && !t.group.isPlaying,
                loop: !!t.group.loopAnimation, speed: t.group.speedRatio, weight: t.weight
            }))
        };
    }

    _poseBindings() {
        const seen = new Map(), bindings = [];
        for (const [name, t] of this.tracks) (t.group.targetedAnimations || []).forEach((targeted, i) => {
            const path = targeted.animation.targetPropertyPath, target = targeted.target;
            let paths = seen.get(target);
            if (!paths) seen.set(target, (paths = new Set()));
            const propertyPath = path.join('.');
            if (paths.has(propertyPath)) return;
            paths.add(propertyPath);
            let owner = target;
            for (const key of path.slice(0, -1)) owner = owner[key];
            const property = path[path.length - 1], value = owner[property];
            if (typeof value !== 'number' && !(value && value.asArray && (value.copyFromArray || value.copyFromFloats))) {
                throw new Error('CLIP_SNAPSHOT_CHANNEL_UNSUPPORTED: ' + propertyPath);
            }
            bindings.push({ key: JSON.stringify([name, i]), owner, property });
        });
        return bindings;
    }

    validateSnapshot(state) {
        if (!state || typeof state.current !== 'string' || (state.current && !this.has(state.current)) ||
            typeof state.then !== 'string' || (state.then && !this.has(state.then)) ||
            !Number.isFinite(state.blend) || state.blend < 0 || typeof state.paused !== 'boolean' ||
            !Array.isArray(state.tracks) || state.tracks.length !== this.tracks.size) throw new Error('CLIP_SNAPSHOT_INVALID');
        const seen = new Set();
        for (const s of state.tracks) {
            const t = this.tracks.get(s.name);
            if (!t || seen.has(s.name) || !Number.isFinite(s.frame) || s.frame < t.group.from || s.frame > t.group.to ||
                !Number.isFinite(s.weight) || s.weight < 0 || s.weight > 1 || !Number.isFinite(s.speed) || s.speed <= 0 ||
                typeof s.active !== 'boolean' || typeof s.paused !== 'boolean' || typeof s.loop !== 'boolean') throw new Error('CLIP_SNAPSHOT_INVALID');
            seen.add(s.name);
        }
        const bindings = this._poseBindings();
        if (!Array.isArray(state.pose) || state.pose.length !== bindings.length) throw new Error('CLIP_SNAPSHOT_POSE_INVALID');
        state.pose.forEach((p, i) => {
            const b = bindings[i], value = b.owner[b.property];
            if (p.key !== b.key || (typeof value === 'number' ? !Number.isFinite(p.value) :
                !Array.isArray(p.value) || p.value.length !== value.asArray().length || !p.value.every(Number.isFinite))) throw new Error('CLIP_SNAPSHOT_POSE_INVALID');
        });
    }

    _restoreStart(state) {
        this.current = '';
        this._then = '';
        let sum = 0;
        for (const s of state.tracks) sum += s.weight;
        for (const s of state.tracks) {
            const t = this.tracks.get(s.name), g = t.group;
            g.stop(true);
            t.weight = s.weight; t.frame = s.frame;
            g.start(s.loop, s.speed, g.from, g.to, false);
            g.setWeightForAllAnimatables(sum > 0 ? s.weight / sum : 0);
            g.goToFrame(s.frame, true);
        }
    }

    _restoreFinish(state) {
        for (const s of state.tracks) {
            const g = this.tracks.get(s.name).group;
            if (!s.active) g.stop(true);
            else if (s.paused || state.paused) g.pause();
        }
        this.current = state.current; this._then = state.then;
        this.blend = state.blend; this.paused = state.paused;
        this._poseBindings().forEach((b, i) => {
            const value = state.pose[i].value, current = b.owner[b.property];
            if (typeof current === 'number') b.owner[b.property] = value;
            else if (current.copyFromArray) current.copyFromArray(value);
            else current.copyFromFloats(...value);
        });
    }

    // Weights: the current clip rises to 1, the rest fall to 0 over blend seconds; the sum is kept at 1.
    _tick(dt) {
        if (!this.current) return;
        const step = this.blend > 0 ? Math.max(0, dt) / this.blend : 1;
        let sum = 0;
        for (const [name, t] of this.tracks) {
            t.weight = Math.max(0, Math.min(1, t.weight + (name === this.current ? step : -step)));
            sum += t.weight;
        }
        for (const [name, t] of this.tracks) {
            if (t.weight <= 0) {
                if (name !== this.current && t.group.isPlaying) t.group.stop();
                continue;
            }
            t.group.setWeightForAllAnimatables(t.weight / sum);
        }
    }

    dispose() {
        Gltf3D._clock(this.scene).clips.delete(this);
        this.scene.onBeforeAnimationsObservable.remove(this._observer);
        for (const t of this.tracks.values()) t.group.dispose();
        this.tracks.clear();
        this.current = '';
    }
}
