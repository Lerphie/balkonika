// InkSkin.js — CPU posing for Babylon edge lines on skinned meshes.
// --- Ink edges of a skinned mesh ------------------------------------------------

// EdgesRenderer builds its lines ONCE, out of the rest pose, and Babylon's "line" shader
// knows nothing about bones: on a character the ink would hang in the rest pose while the
// bones move the mesh (that is why skinned meshes used to be left without ink at all).
// The SET of lines never changes — only where their ends are. So each line end is mapped
// ONCE to the mesh vertex it was copied from, and before every draw the posed ends are
// written into the line buffers. The mesh itself is still skinned on the GPU: the CPU here
// touches only the vertices the lines use (812 of them on the kit's character — ~0.05 ms).
//
// Created by World3D.inkMesh for a mesh with a skeleton, dropped by inkSkinRelease before
// the edges renderer that owns the buffers goes away (mesh.metadata.inkSkin).
class InkSkin {
    constructor(mesh) {
        this.mesh = mesh;
        this.ok = false;
        this._frame = -1;
        const VB = BABYLON.VertexBuffer;
        const er = /** @type {any} */ (mesh.edgesRenderer);
        const scene = mesh.getScene();
        if (!er || !mesh.skeleton || !er.linesPositions.length) return;
        const pos = mesh.getVerticesData(VB.PositionKind);
        const indices = mesh.getIndices();
        const bones = mesh.getVerticesData(VB.MatricesIndicesKind);
        const weights = mesh.getVerticesData(VB.MatricesWeightsKind);
        if (!pos || !indices || !bones || !weights) return;   // a skeleton without skinning data
        this._rest = pos;
        this._bones = bones;
        this._weights = weights;
        this._bonesExtra = mesh.numBoneInfluencers > 4 ? mesh.getVerticesData(VB.MatricesIndicesExtraKind) : null;
        this._weightsExtra = this._bonesExtra ? mesh.getVerticesData(VB.MatricesWeightsExtraKind) : null;
        if (!this._weightsExtra) this._bonesExtra = null;   // 5..8 influences, but no weights for them
        this._map(er, pos, indices);
        this._own(er, scene.getEngine());
        this._observer = mesh.onBeforeRenderObservable.add(() => this.update());
        this.ok = true;
        this.update();
    }

    // Line end -> mesh vertex. The renderer copies vertex coordinates verbatim
    // (createLine: p0, p0, p1, p1 for the positions and the opposite end in the normals), so
    // the position is an exact key. Lowpoly duplicates every vertex per face, so a key
    // usually has several candidates: the pair that shares a TRIANGLE wins — at a seam where
    // two bones meet, the other candidate would fly away with the wrong bone. The four
    // vertices of one line quad are resolved together, or the quad would be stretched
    // between two bones.
    _map(er, pos, indices) {
        const n = pos.length / 3;
        const byPos = new Map();
        for (let v = 0; v < n; v++) {
            const key = pos[3 * v] + '|' + pos[3 * v + 1] + '|' + pos[3 * v + 2];
            const list = byPos.get(key);
            if (list) list.push(v); else byPos.set(key, [v]);
        }
        const pair = new Set();
        for (let t = 0; t + 2 < indices.length; t += 3) {
            const a = indices[t], b = indices[t + 1], c = indices[t + 2];
            pair.add(a * n + b); pair.add(b * n + a);
            pair.add(b * n + c); pair.add(c * n + b);
            pair.add(c * n + a); pair.add(a * n + c);
        }
        const lp = er.linesPositions, ln = er.linesNormals;
        const count = lp.length / 3;
        const from = this._from = new Int32Array(count);     // vertex of the line end itself
        const to = this._to = new Int32Array(count);         // vertex of the other end (normal.xyz)
        const used = new Set();
        for (let i = 0; i < count; i += 4) {
            const A = byPos.get(lp[3 * i] + '|' + lp[3 * i + 1] + '|' + lp[3 * i + 2]) || [0];
            const B = byPos.get(ln[4 * i] + '|' + ln[4 * i + 1] + '|' + ln[4 * i + 2]) || [0];
            let a = A[0], b = B[0];
            if (A.length > 1 || B.length > 1) {
                search: for (const x of A) {
                    for (const y of B) if (pair.has(x * n + y)) { a = x; b = y; break search; }
                }
            }
            from[i] = from[i + 1] = a; from[i + 2] = from[i + 3] = b;
            to[i] = to[i + 1] = b; to[i + 2] = to[i + 3] = a;
            used.add(a); used.add(b);
        }
        this._used = Int32Array.from(used);
        this._posed = new Float32Array(n * 3);
    }

    // The renderer's own line buffers are static (updatable = false) and updateDirectly on
    // them does nothing at all, without a word — the pair is replaced with updatable ones.
    // They belong to the renderer from here on: it disposes and rebuilds them as its own.
    _own(er, engine) {
        const VB = BABYLON.VertexBuffer;
        const line = this._line = new Float32Array(er.linesPositions);
        const next = this._next = new Float32Array(er.linesNormals);
        const bufLine = new VB(engine, line, VB.PositionKind, true, false, 3);
        const bufNext = new VB(engine, next, VB.NormalKind, true, false, 4);
        er._buffers[VB.PositionKind].dispose();
        er._buffers[VB.NormalKind].dispose();
        er._buffers[VB.PositionKind] = bufLine;
        er._buffers[VB.NormalKind] = bufNext;
        er._buffersForInstances[VB.PositionKind] = bufLine;
        er._buffersForInstances[VB.NormalKind] = bufNext;
        this._bufLine = bufLine;
        this._bufNext = bufNext;
    }

    // Pose the lines. Called before the mesh is drawn, when the skeleton's matrices for the
    // frame are ready; the shadow map and the outline mask draw the same mesh again — hence
    // the render id guard.
    update() {
        if (!this._bufLine) return;
        const mesh = this.mesh, scene = mesh.getScene();
        const frame = scene.getRenderId();
        if (frame === this._frame) return;
        this._frame = frame;
        // The same sum the vertex shader does (bonesVertex): the skeleton's matrices are in
        // the mesh's space, the mesh's world matrix is applied by the line shader afterwards.
        const m = mesh.skeleton.getTransformMatrices(mesh);
        const rest = this._rest, out = this._posed;
        for (const v of this._used) {
            const x = rest[3 * v], y = rest[3 * v + 1], z = rest[3 * v + 2];
            let px = 0, py = 0, pz = 0;
            for (let k = 0; k < 8; k++) {
                const extra = k > 3;
                if (extra && !this._bonesExtra) break;
                const idx = extra ? this._bonesExtra : this._bones;
                const wts = extra ? this._weightsExtra : this._weights;
                const at = 4 * v + (k & 3);
                const w = wts[at];
                if (!w) continue;
                const o = (idx[at] | 0) * 16;
                px += w * (m[o] * x + m[o + 4] * y + m[o + 8] * z + m[o + 12]);
                py += w * (m[o + 1] * x + m[o + 5] * y + m[o + 9] * z + m[o + 13]);
                pz += w * (m[o + 2] * x + m[o + 6] * y + m[o + 10] * z + m[o + 14]);
            }
            out[3 * v] = px; out[3 * v + 1] = py; out[3 * v + 2] = pz;
        }
        const line = this._line, next = this._next, from = this._from, to = this._to;
        for (let i = 0; i < from.length; i++) {
            const a = 3 * from[i], b = 3 * to[i];
            line[3 * i] = out[a]; line[3 * i + 1] = out[a + 1]; line[3 * i + 2] = out[a + 2];
            next[4 * i] = out[b]; next[4 * i + 1] = out[b + 1]; next[4 * i + 2] = out[b + 2];
            // next[4 * i + 3] is the side of the line quad — it does not move.
        }
        this._bufLine.updateDirectly(line, 0);
        this._bufNext.updateDirectly(next, 0);
    }

    dispose() {
        if (this._observer) this.mesh.onBeforeRenderObservable.remove(this._observer);
        this._observer = null;
        this._bufLine = null;
        this._bufNext = null;
        this.ok = false;
    }
}
