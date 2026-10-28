// Instances3D.js — many copies of ONE mesh or model in one draw call per part (Babylon thin
// instances). Created through World3D.addInstances(view, source, kind, items, opts).
//
// WHY. Every separate mesh costs the CPU per frame: the active mesh check, the world matrix,
// material and light binding, and a draw call. Each addObject mesh is also drawn for the
// shadow map, the outline mask and the ink edges. Measure frame distributions and draw calls
// on the target scene and device; batching is not a guarantee about worst-frame latency.
// A forest, identical props,
// bullets, grass, fence posts — more than a couple of hundred copies of one thing go here.
//
//     const trees = World3D.addInstances(view, treeMesh, 'prop', [
//         { x: 300, y: 420, h: terrain.heightAt(300, 420), heading: 1.2, scale: 1.4 }, …
//     ]);
//     trees.set(7, { x, y, h, heading });  trees.flush();   // move copies; every frame — opts.dynamic
//     trees.setAll(items);                                   // replace all (the count may change)
//     trees.dispose();
//
// item: { x, y — map px; h — height of the copy's origin, px (the helper does not ask the
// terrain); heading — rad, like everywhere (the nose along +X turns to atan2(vy, vx));
// scale — a number or [x, y, z]; 1 by default }.
// source: a mesh with geometry, or a model root from Model3D.build (every part gets the same
// instances). Its own position, rotation and scale are reset: the copies are placed by items.
// Parts with their own transforms (glTF nodes) are baked into vertices once. A SKINNED model
// is refused: one skeleton is one pose, the copies would all move as one.
// opts: { dynamic — the copies move every frame: no bounds refresh on flush(), the mesh is always
// drawn; castShadow, receiveShadows, ink, outline — as in World3D.addObject }.
//
// The copies share everything the mesh has: material group, toon, shadow, ink edges and
// outline are set once by World3D.addObject. There is no per-copy color, visibility or picking
// (scene.pick sees thin instances only with mesh.thinInstanceEnablePicking).

class Instances3D {
    constructor(view, source, kind, items, opts) {
        const o = opts || {};
        this.view = view;
        this.root = source;
        this.dynamic = !!o.dynamic;
        this.count = 0;
        /** @type {Float32Array} */
        this.matrices = new Float32Array(0);
        /** @type {BABYLON.Mesh[]} */
        this.parts = Instances3D.prepare(source);
        this.ok = this.parts.length > 0;
        if (!this.ok) return;
        World3D.addObject(view, source, kind, o);
        for (const part of this.parts) {
            if (this.dynamic) {
                part.alwaysSelectAsActiveMesh = true;
                part.doNotSyncBoundingInfo = true;
            }
        }
        this.setAll(items || []);
    }

    // Parts that carry geometry, each with an identity world matrix: a thin instance matrix is
    // applied in the mesh's LOCAL space, so the mesh itself has to stand at the origin.
    /** @returns {BABYLON.Mesh[]} */
    static prepare(source) {
        const all = [source].concat(source.getChildMeshes ? source.getChildMeshes(false) : []);
        const parts = all.filter(m => m.getTotalVertices && m.getTotalVertices() > 0);
        if (parts.some(m => m.skeleton)) {
            console.warn('Instances3D: "' + source.name + '" is skinned — one skeleton is one pose, it cannot be instanced');
            return [];
        }
        source.position.setAll(0);
        source.rotationQuaternion = null;
        source.rotation.setAll(0);
        source.scaling.setAll(1);
        source.computeWorldMatrix(true);
        // Capture every matrix before flattening a parent mesh changes its children.
        const transforms = parts.map(part => {
            const world = part.computeWorldMatrix(true).clone();
            // Keep the original part center, not the center of its rotated baked AABB.
            const center = BABYLON.Vector3.TransformCoordinates(part.getBoundingInfo().boundingSphere.center, world);
            return { part, world, center };
        });
        for (const { part, world, center } of transforms) {
            part.metadata = Object.assign({}, part.metadata, { arcInstanceCenter: center.asArray() });
            if (part === source) continue;
            // Nonuniform GLB node scales need inverse-transpose normals. Babylon's
            // bake helper applies the forward matrix, changing the original lighting.
            const originalNormals = part.getVerticesData(BABYLON.VertexBuffer.NormalKind);
            const normals = originalNormals ? Array.from(originalNormals) : null;
            const normalMatrix = BABYLON.Matrix.Transpose(world.clone().invert());
            // Clones (including glTF container copies) share geometry. Baking must not
            // change the template or another model that uses the same vertex buffers.
            part.makeGeometryUnique();
            // setParent() decomposes into TRS, losing shear from nested GLB transforms.
            part.bakeTransformIntoVertices(world);
            if (normals) {
                const normal = BABYLON.Vector3.Zero();
                for (let i = 0; i < normals.length; i += 3) {
                    BABYLON.Vector3.TransformNormalFromFloatsToRef(normals[i], normals[i + 1], normals[i + 2], normalMatrix, normal);
                    normal.normalize().toArray(normals, i);
                }
                part.setVerticesData(BABYLON.VertexBuffer.NormalKind, normals);
            }
            part.parent = source;
            part.resetLocalMatrix(false);
        }
        return parts;
    }

    // One copy -> 16 floats at index i: scale, turn by the heading about the vertical, move to
    // (x, h, y). No Babylon here (tests/instances.test.mjs).
    static fill(out, i, item) {
        const s = item.scale == null ? 1 : item.scale;
        const sx = Array.isArray(s) ? s[0] : s, sy = Array.isArray(s) ? s[1] : s, sz = Array.isArray(s) ? s[2] : s;
        const a = -(Number(item.heading) || 0), c = Math.cos(a), n = Math.sin(a), k = i * 16;
        out[k] = sx * c; out[k + 1] = 0; out[k + 2] = -sx * n; out[k + 3] = 0;
        out[k + 4] = 0; out[k + 5] = sy; out[k + 6] = 0; out[k + 7] = 0;
        out[k + 8] = sz * n; out[k + 9] = 0; out[k + 10] = sz * c; out[k + 11] = 0;
        out[k + 12] = Number(item.x) || 0; out[k + 13] = Number(item.h) || 0; out[k + 14] = Number(item.y) || 0; out[k + 15] = 1;
    }

    // Replace all copies; the count may change. An empty list hides the mesh.
    setAll(items) {
        if (!this.ok) return;
        const n = items.length;
        if (n !== this.count) this.matrices = new Float32Array(n * 16);
        for (let i = 0; i < n; i++) Instances3D.fill(this.matrices, i, items[i]);
        this.count = n;
        for (const part of this.parts) {
            part.thinInstanceSetBuffer('matrix', n ? this.matrices : null, 16, !this.dynamic);
            part.setEnabled(n > 0);
            if (n && !this.dynamic) part.thinInstanceRefreshBoundingInfo(true);
        }
    }

    // One copy; call flush() after the last set() of the frame.
    set(i, item) {
        if (i >= 0 && i < this.count) Instances3D.fill(this.matrices, i, item);
    }

    // Upload what set() has changed. Dynamic copies — an update of the GPU buffer. Static ones
    // live in a non-updatable buffer (Babylon ignores updates of it without a word): the buffer
    // is set again and the bounds are refreshed — frustum culling works on the box around ALL copies.
    flush() {
        if (!this.ok || !this.count) return;
        for (const part of this.parts) {
            if (this.dynamic) {
                if (typeof part.thinInstancePartialBufferUpdate === 'function') {
                    // The numeric public API uploads the complete count-sized matrix view
                    // without dropping Babylon's CPU backing required by Buffer._rebuild().
                    part.thinInstancePartialBufferUpdate('matrix', this.count, 0);
                } else {
                    // Compatibility upload only: old Babylon APIs do not retain that backing.
                    part.thinInstanceBufferUpdated('matrix');
                }
            } else {
                part.thinInstanceSetBuffer('matrix', this.matrices, 16, true);
                part.thinInstanceRefreshBoundingInfo(true);
            }
        }
    }

    // Out of the scene: outline, shadows, meshes. Materials stay with the owner, as with
    // World3D.removeObject (a model from Model3D — Model3D.dispose(view, instances.root)).
    dispose() {
        if (this.root) World3D.removeObject(this.view, this.root);
        this.root = null;
        this.parts = [];
        this.count = 0;
        this.ok = false;
    }
}
