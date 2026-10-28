// WorldRender3D.js — internal object/material, ink and outline policy.
// Methods are exposed on World3D and run with that facade as their receiver.
// Load before World3D.js; gameplay continues to call the stable World3D API.
/** @satisfies {Record<string, any>} */
const WorldRender3D = {
    // --- Render constants -----------------------------------------------------

    // All render constants with defaults (Constants.js may be older than the code).
    // In the game the constants are lexical const: they cannot be read by name via
    // window, only by typeof on the identifier.
    cfg() {
        const U = 'undefined';
        return {
            sunAz: ArcConfig.get('WORLD3D_SUN_AZIMUTH_DEG'),
            sunEl: ArcConfig.get('WORLD3D_SUN_ELEVATION_DEG'),
            sunIntensity: ArcConfig.get('WORLD3D_SUN_INTENSITY'),
            sunColor: ArcConfig.get('WORLD3D_SUN_COLOR'),
            skyIntensity: ArcConfig.get('WORLD3D_SKYLIGHT_INTENSITY'),
            skyLight: ArcConfig.get('WORLD3D_SKYLIGHT_COLOR'),
            groundLight: ArcConfig.get('WORLD3D_GROUNDLIGHT_COLOR'),
            sky: ArcConfig.get('WORLD3D_SKY_COLOR'),
            fog: ArcConfig.get('WORLD3D_FOG_DENSITY'),
            shadowMap: ArcConfig.get('WORLD3D_SHADOW_MAP'),
            shadowColor: ArcConfig.get('WORLD3D_SHADOW_COLOR'),
            shadowStrength: ArcConfig.get('WORLD3D_SHADOW_STRENGTH'),
            shadowSoft: ArcConfig.get('WORLD3D_SHADOW_SOFT'),
            shadowRadius: ArcConfig.get('WORLD3D_SHADOW_RADIUS'),
            shadowBias: ArcConfig.get('WORLD3D_SHADOW_BIAS'),
            shadowNormalBias: ArcConfig.get('WORLD3D_SHADOW_NORMAL_BIAS'),
            groundSpecular: ArcConfig.get('WORLD3D_GROUND_SPECULAR'),
            groundSpecPower: ArcConfig.get('WORLD3D_GROUND_SPEC_POWER'),
            outerTint: ArcConfig.get('WORLD3D_OUTER_TINT'),
            propSpecular: ArcConfig.get('WORLD3D_PROP_SPECULAR'),
            propSpecPower: ArcConfig.get('WORLD3D_PROP_SPEC_POWER'),
            actorSpecular: ArcConfig.get('WORLD3D_ACTOR_SPECULAR'),
            actorSpecPower: ArcConfig.get('WORLD3D_ACTOR_SPEC_POWER'),
            toon: ArcConfig.get('WORLD3D_TOON'),
            toonBands: ArcConfig.get('WORLD3D_TOON_BANDS'),
            toonSoft: ArcConfig.get('WORLD3D_TOON_SOFT'),
            toonLow: ArcConfig.get('WORLD3D_TOON_LOW'),
            toonGround: ArcConfig.get('WORLD3D_TOON_GROUND'),
            toonSpec: ArcConfig.get('WORLD3D_TOON_SPEC'),
            toonSpecSize: ArcConfig.get('WORLD3D_TOON_SPEC_SIZE'),
            toonRim: ArcConfig.get('WORLD3D_TOON_RIM'),
            toonRimWidth: ArcConfig.get('WORLD3D_TOON_RIM_WIDTH'),
            outline: ArcConfig.get('WORLD3D_TOON_OUTLINE'),
            outlineActorWidth: ArcConfig.get('WORLD3D_TOON_OUTLINE_ACTOR_WIDTH'),
            outlinePropWidth: ArcConfig.get('WORLD3D_TOON_OUTLINE_PROP_WIDTH'),
            ink: ArcConfig.get('WORLD3D_TOON_INK'),
            inkWidth: ArcConfig.get('WORLD3D_TOON_INK_WIDTH'),
            inkColor: ArcConfig.get('WORLD3D_TOON_INK_COLOR'),
            inkAngle: ArcConfig.get('WORLD3D_TOON_INK_ANGLE')
        };
    },

    // Live application of render constants to the view's scene (editor): light, shadows,
    // sky, materials by group, toon, ink edges and outlines. Rebuilds nothing.
    applyRenderConstants(view) {
        if (!view || !view.scene) return;
        const c = this.cfg();
        view.applyLighting(c);
        this.toon.apply(c);
        for (const m of view.scene.materials) this.applyMaterialConstants(m, c);
        this.applyInk(view.scene, c);
        this.applyOutlines(view, c);
        view.scene.resetCachedMaterial();
    },

    // Material specular highlight by group (metadata.toonGroup): ground, environment, main objects.
    // The ground ring beyond the edge (metadata.outer) — also the WORLD3D_OUTER_TINT brightness.
    applyMaterialConstants(m, c) {
        const g = m && m.metadata && m.metadata.toonGroup;
        if (!g || !(m instanceof BABYLON.StandardMaterial)) return;
        c = c || this.cfg();
        let spec = 0, power = m.specularPower;
        if (g === 'ground') { spec = c.groundSpecular; power = c.groundSpecPower; }
        else if (g === 'prop') { spec = c.propSpecular; power = c.propSpecPower; }
        else if (g === 'actor') { spec = c.actorSpecular; power = c.actorSpecPower; }
        m.specularColor = new BABYLON.Color3(spec, spec, spec);
        m.specularPower = Math.max(1, power);
        if (m.metadata.outer) {
            const t = Math.max(0, c.outerTint);
            m.diffuseColor = new BABYLON.Color3(t, t, t);
        }
    },

    // --- World objects -----------------------------------------------------------

    // Object registration: materials (of child meshes too) — into the kind group (specular
    // highlight from constants, toon), the root — into the shadow map, edges — into the ink
    // edges, the silhouette — into the outline. The root and the children get THEIR OWN
    // metadata: clone() copies it by reference, and the ink edges/outline of clones would
    // write into a shared object.
    // kind: 'actor' | 'prop'. opts: { castShadow, receiveShadows, ink, outline } — all true by default.
    addObject(view, mesh, kind, opts) {
        if (!view || !mesh) return mesh;
        const o = opts || {};
        const k = kind === 'prop' ? 'prop' : 'actor';
        const c = this.cfg();
        const parts = [mesh].concat(mesh.getChildMeshes ? mesh.getChildMeshes(false) : []);
        for (const m of parts) {
            m.metadata = Object.assign({}, m.metadata);
            m.receiveShadows = o.receiveShadows !== false;
            const mat = m.material;
            const mats = mat ? (mat.subMaterials || [mat]) : [];
            for (const sm of mats) {
                if (!sm) continue;
                sm.metadata = Object.assign({ toonGroup: k }, sm.metadata);
                this.applyMaterialConstants(sm, c);
            }
            const solid = m.getTotalVertices && m.getTotalVertices() > 0;
            // Every part gets ink edges, a skinned one too: its lines are built from the rest
            // pose and re-posed with the bones before each draw (InkSkin).
            if (solid && o.ink !== false) this.inkMesh(m, k, c);
            // All parts — into ONE outline layer: the line follows the overall silhouette, not a part.
            if (solid && o.outline !== false) this.outlineAdd(view, m, k, c);
        }
        if (o.castShadow !== false) view.addShadowCaster(mesh, true);
        return mesh;
    },

    // Many copies of ONE mesh or model (a forest, identical props, bullets): thin instances, one
    // draw call per part whatever the count — a separate addObject mesh costs the CPU 10–15 µs
    // per frame (main pass, shadow map, outline mask, ink edges): 2000 of them are a whole frame.
    // items: [{ x, y, h, heading?, scale? }]; returns Instances3D (set / setAll / flush / dispose),
    // .ok is false for a skinned model. Details — Instances3D.js.
    addInstances(view, source, kind, items, opts) {
        return new Instances3D(view, source, kind, items, opts);
    },

    // Remove an object: outline, shadows, the mesh with its children. Materials stay with the owner.
    removeObject(view, mesh) {
        if (!mesh) return;
        const parts = [mesh].concat(mesh.getChildMeshes ? mesh.getChildMeshes(false) : []);
        for (const m of parts) this.outlineRemove(view, m);
        if (view) view.removeShadowCaster(mesh);
        mesh.dispose(false, false);
    },

    // --- Ink edges (EdgesRenderer) ---------------------------------------------

    // Mesh edges creased sharper than WORLD3D_TOON_INK_ANGLE are drawn as lines in the ink
    // color. group: 'actor' (level 1) | 'prop' (level 2). Cost: ~5 ms per
    // mesh of 1300 triangles, once. Ink edges are part of the toon look, like the
    // silhouette outline: at WORLD3D_TOON = 0 they are off. EVERY object of the scene gets
    // them — a skinned one keeps its lines on the bones through InkSkin.
    inkMesh(mesh, group, c) {
        if (!mesh || !mesh.enableEdgesRendering) return;
        c = c || this.cfg();
        const md = mesh.metadata || (mesh.metadata = {});
        md.ink = group;
        const want = c.toon > 0 && c.ink >= (group === 'prop' ? 2 : 1) && c.inkWidth > 0;
        if (!want) {
            this.inkSkinRelease(mesh);
            if (mesh.edgesRenderer) mesh.disableEdgesRendering();
            md.inkEps = null;
            return;
        }
        const eps = Math.cos(Math.max(1, Math.min(89, c.inkAngle)) * Math.PI / 180);
        if (!mesh.edgesRenderer || md.inkEps !== eps) {
            // checkVerticesInsteadOfIndices: in flat-shaded lowpoly the
            // triangles are disconnected, adjacency is found by vertex coordinates.
            this.inkSkinRelease(mesh);   // the new renderer brings its own lines and buffers
            mesh.enableEdgesRendering(eps, true);
            md.inkEps = eps;
        }
        mesh.edgesWidth = c.inkWidth;
        const col = this.hexColor3(c.inkColor);
        mesh.edgesColor = new BABYLON.Color4(col.r, col.g, col.b, 1);
        if (group === 'prop') mesh.edgesShareWithInstances = true;
        if (mesh.skeleton) this.inkSkin(mesh);
    },

    // Lines of a SKINNED mesh follow its bones (InkSkin, below): one helper per mesh, built
    // on the current edges renderer. Returns null when the mesh carries no skinning data.
    inkSkin(mesh) {
        const md = mesh.metadata || (mesh.metadata = {});
        if (md.inkSkin) return md.inkSkin;
        const skin = new InkSkin(mesh);
        md.inkSkin = skin.ok ? skin : null;
        return md.inkSkin;
    },

    // Drop the follow — BEFORE the edges renderer that owns the line buffers goes away.
    inkSkinRelease(mesh) {
        const md = mesh && mesh.metadata;
        if (!md || !md.inkSkin) return;
        md.inkSkin.dispose();
        md.inkSkin = null;
    },

    applyInk(scene, c) {
        c = c || this.cfg();
        for (const m of scene.meshes) {
            if (m.metadata && m.metadata.ink && !m.isAnInstance) this.inkMesh(m, m.metadata.ink, c);
        }
    },

    // --- Silhouette outline: mask-based post effect ------------------------------
    //
    // "Stroke like in Photoshop": objects are drawn into a separate MASK (RTT), it is
    // dilated and laid over the frame in the ink color. The line follows the OUTER
    // boundary of the silhouette, ONE per whole object. The width is in screen pixels
    // and does not depend on the distance to the camera. Static instance masks use
    // ArcOutlineFogPlugin; the stock HighlightLayer uses isStroke (STROKE gives a
    // hard edge instead of a glow). Levels — WORLD3D_TOON_OUTLINE. The outline is
    // part of the toon look: at WORLD3D_TOON = 0 (the editor's "toon shader" checkbox)
    // there is none. Ink edges (inkMesh) do not depend on WORLD3D_TOON.
    //
    // Each object kind ('actor' / 'prop') has its own width, while a layer has one for
    // everything — so different kinds need different layers.
    //
    // Scene fog does not touch the line (it is laid over the finished frame) — the fog
    // tone is given to each mesh by outlineFog once per frame.
    //
    // PITFALL: the layer needs a stencil buffer (needStencil() = true) — the engine
    // is brought up with stencil: true, otherwise the outline creeps onto the object itself.
    // PITFALL: the outline is drawn ON TOP of the frame and knows nothing about depth — an
    // object in front of an outlined one will not occlude it. Viewed from above it is unnoticeable.

    outlineKind(kind) { return kind === 'prop' ? 'prop' : 'actor'; },

    // Outline width of an object kind in screen px (frame pixels).
    outlineWidthOf(kind, c) {
        c = c || this.cfg();
        return this.outlineKind(kind) === 'prop' ? c.outlinePropWidth : c.outlineActorWidth;
    },

    // Layer resolution: the mask is a fraction of the frame, the blur is a fraction of the
    // mask. Do not drop the mask below the frame: a line thinner than a texel cannot be
    // drawn, and a 0.5 × 0.5 texel is 4 frame px. On mobile only the blur is cheaper.
    outlineRatios() {
        return { main: 1, blur: IS_MOBILE ? 0.5 : 1 };
    },

    // Width in frame px -> the layer's blur kernel.
    // PITFALL: HighlightLayer's blurHorizontalSize is in TEXELS of the blur
    // texture (frame × mainTextureRatio × blurTextureSizeRatio), not in frame
    // px. Without the conversion, on mobile (0.5 × 0.5) the same constant gave
    // a line four times thicker than on PC.
    outlineKernel(width) {
        const r = this.outlineRatios();
        return width * r.main * r.blur;
    },

    // Outline layer: a SEPARATE one for each "object kind × mesh rendering group" pair
    // (`view._outlines['actor@2']` etc.). The kind sets the width, the group — the moment
    // of compositing.
    //
    // PITFALL (outline on only some of the objects). A layer gives a line ONLY to the
    // meshes that are drawn in its rendering group. With the default
    // renderingGroupId = −1 the compositing landed between groups: objects of another
    // group were flooded by the mask entirely, and some objects had no line at all.
    // So a layer is created for EVERY group that has an outlined mesh.
    outlineLayer(view, kind, renderGroup, c) {
        if (!view || !view.scene || typeof BABYLON.HighlightLayer !== 'function') return null;
        c = c || this.cfg();
        const k = this.outlineKind(kind);
        const g = renderGroup || 0;
        const key = k + '@' + g;
        const store = view._outlines || (view._outlines = {});
        let rec = store[key];
        const width = this.outlineWidthOf(k, c);
        if (!(c.toon > 0) || !(c.outline >= (k === 'prop' ? 2 : 1)) || !(width > 0)) return rec ? rec.hl : null;
        const kernel = this.outlineKernel(width);
        if (!rec) {
            const r = this.outlineRatios();
            const hl = new BABYLON.HighlightLayer('arcOutline-' + key, view.scene, {
                isStroke: true,
                camera: view.camera,
                mainTextureRatio: r.main,
                blurTextureSizeRatio: r.blur,
                blurHorizontalSize: kernel,
                blurVerticalSize: kernel,
                renderingGroupId: g
            });
            hl.innerGlow = false;     // outward only — this is an outline, not a glow
            hl.outerGlow = true;
            // PITFALL (dark "ghost" of the outline in fog). In STROKE mode the merge
            // shader (glowMapMerge) already multiplies the color by alpha, and the layer's
            // default blending, ALPHA_COMBINE (SRC_ALPHA), multiplies a second time:
            // color·α² + frame·(1−α). On a black line this is invisible, but a fog-colored
            // line (outlineFog) got an edge a quarter darker than the background: the object
            // dissolved in the distance, the outline remained. ALPHA_PREMULTIPLIED
            // (ONE, ONE_MINUS_SRC_ALPHA) is needed — but ONLY for the duration of the compose.
            // The mode lives in the thin layer's private options, and the layer reads those
            // same options when it recreates textures on canvas resize: with PREMULTIPLIED it
            // built a different blur chain (2 passes instead of 3), the blur
            // texture stayed empty, and the outline vanished completely (the ArcTrack
            // editor after a view resize). A constructor option will not do for
            // the same reason. The field is private: check it when upgrading Babylon.
            const thin = /** @type {any} */ (hl)._thinEffectLayer;
            if (thin && thin._options) {
                const C = BABYLON.Constants;
                hl.onBeforeComposeObservable.add(() => { thin._options.alphaBlendingMode = C.ALPHA_PREMULTIPLIED; });
                hl.onAfterComposeObservable.add(() => { thin._options.alphaBlendingMode = C.ALPHA_COMBINE; });
            }
            // PITFALL (dark fringe on a light line). The layer clears the mask with
            // neutralColor — black (0,0,0,0) by default. The blur takes the color of
            // the brightest sample, and a sample at the mask edge is bilinearly mixed with
            // that black: with a fractional kernel (width 1.5 or 0.5 px) and on
            // mobile (blur at half the frame) a fog-colored line got
            // a dark fringe. The mask background is the darkest tone of the layer's meshes
            // with alpha 0 (outlineFog): mixing with it does not darken the color, and it
            // cannot be lighter — the blur would repaint a nearer object's line with it. The
            // object is its own: by default all layers share the static HighlightLayer.NeutralColor.
            hl.neutralColor = new BABYLON.Color4(0, 0, 0, 0);
            // meshes: mesh -> its line color (Color3, the fog tone is adjusted by outlineFog).
            rec = store[key] = { hl: hl, group: g, kind: k, meshes: new Map(), masks: new Map(), ink: null };
            hl.onDisposeObservable.addOnce(() => {
                for (const mesh of [...rec.masks.keys()]) WorldRender3D.releaseOutlineMask(rec, mesh);
            });
        }
        rec.hl.blurHorizontalSize = kernel;
        rec.hl.blurVerticalSize = kernel;
        rec.ink = this.hexColor3(c.inkColor);
        return rec.hl;
    },

    // Put a mesh into the outline. kind: 'actor' (level 1) | 'prop' (level 2).
    // The mesh remembers its kind — applyOutlines rebuilds the set when constants
    // are edited. Instances (thin and regular) are outlined together with the source mesh.
    outlineAdd(view, mesh, kind, c) {
        if (!view || !mesh) return;
        c = c || this.cfg();
        const k = this.outlineKind(kind);
        const md = mesh.metadata || (mesh.metadata = {});
        md.outline = k;
        this.outlineRemove(view, mesh);   // it may have been in another group's layer
        // Toon is off — no outline; applyOutlines brings the removed mesh back when toon is turned on.
        const want = c.toon > 0 && c.outline >= (k === 'prop' ? 2 : 1) && this.outlineWidthOf(k, c) > 0;
        if (!want) return;
        const g = mesh.renderingGroupId || 0;
        const hl = this.outlineLayer(view, k, g, c);
        if (!hl) return;
        const tone = this.hexColor3(c.inkColor);   // each mesh gets its own object: outlineFog edits it in place
        hl.addMesh(mesh, tone);
        const rec = view._outlines[k + '@' + g];
        if (rec) rec.meshes.set(mesh, tone);
    },

    // Remove a mesh from all outline layers; an emptied layer is disposed (an empty mask
    // still costs a render pass).
    outlineRemove(view, mesh) {
        const store = view && view._outlines;
        if (!store || !mesh) return;
        for (const key of Object.keys(store)) {
            const rec = store[key];
            if (!rec || !rec.hl || !rec.meshes.has(mesh)) continue;
            WorldRender3D.releaseOutlineMask(rec, mesh);
            try { rec.hl.removeMesh(mesh); } catch (e) { /* ok */ }
            rec.meshes.delete(mesh);
            if (!rec.meshes.size) {
                try { rec.hl.dispose(); } catch (e) { /* ok */ }
                delete store[key];
            }
        }
    },

    // Constants edit: the width goes onto live layers, levels and color — a rebuild of the set.
    applyOutlines(view, c) {
        if (!view || !view.scene) return;
        c = c || this.cfg();
        for (const m of view.scene.meshes) {
            if (m.metadata && m.metadata.outline && !m.isAnInstance) this.outlineAdd(view, m, m.metadata.outline, c);
        }
    },

    // Outline fog tone — once per frame, before scene.render() (renderFrame).
    // The line is laid over the finished frame, and without the tone a distant object
    // dissolved in the fog while the black outline around it remained. The mesh's line color
    // is mixed with the fog by the SAME formula Babylon applies to the surface
    // (fogFragment: mix(fogColor, color, f)), at the distance from the camera to the mesh
    // center. No constants of its own: the fog is the scene's (WORLD3D_FOG_DENSITY,
    // WORLD3D_SKY_COLOR, the view's opts overrides). Static StandardMaterial instances
    // use one center per instance; unsupported animated/custom masks retain native behavior.
    outlineFog(view) {
        const store = view && view._outlines;
        if (!store || !view.scene || !view.camera) return;
        const scene = view.scene, fog = scene.fogColor, cam = view.camera;
        cam.getViewMatrix();   // globalPosition is recomputed with the view matrix, and the frame render is still ahead
        const eye = cam.globalPosition;
        const focus = BABYLON.Vector3.Distance(eye, cam.getTarget());
        for (const key in store) {
            const rec = store[key], ink = rec.ink;
            if (!ink) continue;
            let darkest = Infinity;
            for (const [m, tone] of rec.meshes) {
                const mask = WorldRender3D.outlineInstanceMask(view, rec, m);
                let d = focus;
                if (!m.hasThinInstances && !(m.instances && m.instances.length)) {
                    m.computeWorldMatrix();   // the object may have been moved since the last frame
                    d = BABYLON.Vector3.Distance(eye, m.getBoundingInfo().boundingSphere.centerWorld);
                }
                const f = m.applyFog === false ? 1 : this.fogFactor(scene, d);
                rec.hl.addMesh(m, tone.set(fog.r + (ink.r - fog.r) * f, fog.g + (ink.g - fog.g) * f, fog.b + (ink.b - fog.b) * f));
                if (mask) {
                    // Blur padding uses the darkest actual instance, not the batch focus.
                    WorldRender3D.forEachOutlineCenter(m, mask.plugin.center, center => {
                        const amount = m.applyFog === false ? 1 : this.fogFactor(scene, BABYLON.Vector3.Distance(eye, center));
                        const r = fog.r + (ink.r - fog.r) * amount, g = fog.g + (ink.g - fog.g) * amount, b = fog.b + (ink.b - fog.b) * amount;
                        const lum = .2126 * r + .7152 * g + .0722 * b;
                        if (lum < darkest) { darkest = lum; rec.hl.neutralColor.set(r, g, b, 0); }
                    });
                    continue;
                }
                // Luminance — same as the sample selection in the blur (glowBlurPostProcess).
                const lum = 0.2126 * tone.r + 0.7152 * tone.g + 0.0722 * tone.b;
                if (lum < darkest) { darkest = lum; rec.hl.neutralColor.set(tone.r, tone.g, tone.b, 0); }
            }
        }
    },

    // Native masks remain the fallback for custom materials and animated geometry.
    outlineInstanceMask(view, rec, mesh) {
        const source = mesh.material;
        const supported = (mesh.hasThinInstances || mesh.instances && mesh.instances.length) &&
            source instanceof BABYLON.StandardMaterial && source.getClassName() === 'StandardMaterial' &&
            !mesh.skeleton && !mesh.morphTargetManager && !mesh.bakedVertexAnimationManager;
        if (!supported) { WorldRender3D.releaseOutlineMask(rec, mesh); return null; }
        let owned = rec.masks.get(mesh);
        if (!owned) {
            const material = new BABYLON.StandardMaterial('arcOutlineMask/' + mesh.name, view.scene);
            material.disableLighting = true;
            material.fogEnabled = false;
            material.metadata = { toon: false };
            const plugin = new ArcOutlineFogPlugin(material, mesh, view, rec);
            const observer = mesh.onDisposeObservable.addOnce(() => WorldRender3D.outlineRemove(view, mesh));
            owned = { material, plugin, observer };
            rec.masks.set(mesh, owned);
            rec.hl.setMaterialForRendering(mesh, material);
        }
        const material = owned.material;
        // Textures remain owned by the original material/cache, never the mask.
        material.diffuseTexture = source.diffuseTexture;
        material.opacityTexture = source.opacityTexture;
        // Native selected masks ignore material alpha. Only an actual alpha-test
        // texture enables rejection; opacity alone must not invent an alpha test.
        const alphaTest = !!source.getAlphaTestTexture() && source.needAlphaTestingForMesh(mesh);
        material.useAlphaFromDiffuseTexture = alphaTest;
        material.transparencyMode = alphaTest ? BABYLON.Material.MATERIAL_ALPHATEST : BABYLON.Material.MATERIAL_OPAQUE;
        material.alpha = 1;
        // Native HighlightLayer masks use 0.4 independently of the main material.
        material.alphaCutOff = .4;
        material.backFaceCulling = source.backFaceCulling;
        material.sideOrientation = source.sideOrientation;
        material.useLogarithmicDepth = source.useLogarithmicDepth;
        for (const key of ['clipPlane', 'clipPlane2', 'clipPlane3', 'clipPlane4', 'clipPlane5', 'clipPlane6']) material[key] = source[key];
        const saved = mesh.hasThinInstances && mesh.metadata && mesh.metadata.arcInstanceCenter;
        const bounds = mesh.hasThinInstances && mesh.rawBoundingInfo || mesh.getBoundingInfo();
        owned.plugin.center.copyFrom(saved ? BABYLON.Vector3.FromArray(saved) : bounds.boundingSphere.center);
        return owned;
    },

    releaseOutlineMask(rec, mesh) {
        const owned = rec.masks && rec.masks.get(mesh);
        if (!owned) return;
        rec.masks.delete(mesh);
        mesh.onDisposeObservable.remove(owned.observer);
        rec.hl.setMaterialForRendering(mesh, undefined);
        owned.material.dispose(false, false);
    },

    // This scan only chooses neutral blur padding; mask colors are computed on the GPU.
    forEachOutlineCenter(mesh, local, visit) {
        const center = BABYLON.Vector3.Zero(), matrix = BABYLON.Matrix.Identity();
        if (mesh.hasThinInstances) {
            const data = mesh._thinInstanceDataStorage.matrixData;
            const world = mesh.computeWorldMatrix(true);
            for (let i = 0; data && i < mesh.thinInstanceCount; i++) {
                BABYLON.Matrix.FromArrayToRef(data, i * 16, matrix);
                BABYLON.Vector3.TransformCoordinatesToRef(local, matrix, center);
                BABYLON.Vector3.TransformCoordinatesToRef(center, world, center);
                visit(center);
            }
        } else {
            BABYLON.Vector3.TransformCoordinatesToRef(local, mesh.computeWorldMatrix(true), center); visit(center);
            for (const instance of mesh.instances || []) {
                if (!instance.isEnabled() || !instance.isVisible) continue;
                BABYLON.Vector3.TransformCoordinatesToRef(local, instance.computeWorldMatrix(true), center); visit(center);
            }
        }
    },

    // The fraction of the surface color that the scene fog leaves at distance d
    // (1 — no fog, 0 — fog only). Formulas — CalcFogFactor from
    // Babylon's fogFragmentDeclaration.
    fogFactor(scene, d) {
        if (!scene.fogEnabled) return 1;
        const S = BABYLON.Scene, rho = scene.fogDensity;
        let f = 1;
        if (scene.fogMode === S.FOGMODE_EXP) f = Math.exp(-d * rho);
        else if (scene.fogMode === S.FOGMODE_EXP2) f = Math.exp(-(d * rho) * (d * rho));
        else if (scene.fogMode === S.FOGMODE_LINEAR) f = (scene.fogEnd - d) / (scene.fogEnd - scene.fogStart);
        return Math.max(0, Math.min(1, f));
    },

    // --- Utilities -------------------------------------------------------------

    // The "where the sun shines" vector (unit, downward): azimuth on the map (0 — right,
    // 90 — down), elevation above the horizon.
    sunDirection(c) {
        c = c || this.cfg();
        const az = c.sunAz * Math.PI / 180;
        const el = c.sunEl * Math.PI / 180;
        const ce = Math.cos(el);
        return new BABYLON.Vector3(Math.cos(az) * ce, -Math.sin(el), Math.sin(az) * ce);
    },

    hexColor3(v) {
        if (typeof v === 'string') return BABYLON.Color3.FromHexString(v);
        const n = (v >>> 0) & 0xffffff;
        return new BABYLON.Color3(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
    }
};

// Mask-only plugin: StandardMaterial retains UV, alpha-test and clipping; final RGB/alpha
// matches HighlightLayer's selected mask, after its standard alpha rejection has run.
class ArcOutlineFogPlugin extends BABYLON.MaterialPluginBase {
    constructor(material, mesh, view, record) {
        super(material, 'ArcOutlineFog', 600, {}, true, true);
        this.mesh = mesh; this.view = view; this.record = record;
        this.center = BABYLON.Vector3.Zero();
    }
    getClassName() { return 'ArcOutlineFogPlugin'; }
    prepareDefines(defines) {
        // Match the bundled HighlightLayer: combine texture/vertex alpha before
        // its fixed cutoff; its opacity path samples alpha, even for RGB textures.
        defines.ALPHATEST_AFTERALLALPHACOMPUTATIONS = true;
        defines.OPACITYRGB = false;
    }
    getUniforms() {
        const names = ['arcOutlineCenter', 'arcOutlineEye', 'arcOutlineFog', 'arcOutlineInk', 'arcOutlineParams'];
        const declarations = names.map(name => 'uniform vec4 ' + name + ';').join('\n');
        return { ubo: names.map(name => ({ name, size: 4, type: 'vec4' })), vertex: declarations, fragment: declarations };
    }
    bindForSubMesh(ubo, scene) {
        const eye = this.view.camera.globalPosition, c = this.center, fog = scene.fogColor, ink = this.record.ink;
        ubo.updateFloat4('arcOutlineCenter', c.x, c.y, c.z, 0);
        ubo.updateFloat4('arcOutlineEye', eye.x, eye.y, eye.z, 0);
        ubo.updateFloat4('arcOutlineFog', fog.r, fog.g, fog.b, 0);
        ubo.updateFloat4('arcOutlineInk', ink.r, ink.g, ink.b, this.record.hl.getEffectIntensity(this.mesh));
        ubo.updateFloat4('arcOutlineParams', scene.fogEnabled && this.mesh.applyFog !== false ? scene.fogMode : 0, scene.fogDensity, scene.fogStart, scene.fogEnd);
    }
    getCustomCode(kind) {
        if (kind === 'vertex') return {
            CUSTOM_VERTEX_DEFINITIONS: 'varying float vArcOutlineDistance;',
            CUSTOM_VERTEX_UPDATE_WORLDPOS: 'vArcOutlineDistance = distance(arcOutlineEye.xyz, (finalWorld * vec4(arcOutlineCenter.xyz, 1.0)).xyz);'
        };
        return {
            CUSTOM_FRAGMENT_DEFINITIONS: 'varying float vArcOutlineDistance;',
            CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: `
float arcOutlineAmount = 1.0;
if (arcOutlineParams.x == 1.0) arcOutlineAmount = exp(-vArcOutlineDistance * arcOutlineParams.y);
else if (arcOutlineParams.x == 2.0) { float d = vArcOutlineDistance * arcOutlineParams.y; arcOutlineAmount = exp(-d * d); }
else if (arcOutlineParams.x == 3.0) arcOutlineAmount = (arcOutlineParams.w - vArcOutlineDistance) / (arcOutlineParams.w - arcOutlineParams.z);
color = vec4(mix(arcOutlineFog.rgb, arcOutlineInk.rgb, clamp(arcOutlineAmount, 0.0, 1.0)) * arcOutlineInk.a, 1.0);
`
        };
    }
}
