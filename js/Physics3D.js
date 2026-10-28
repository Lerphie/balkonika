// Physics3D.js — optional fixed-step Havok world. Rendering remains in centimetres;
// unparented proxy nodes and primitive collision shapes use metres internally.
class ArcPhysicsWorld {
    static _backendPromise = null;

    constructor(scene, options = {}) {
        if (!scene) throw new Error('PHYSICS_SCENE_REQUIRED');
        const gravity = options.gravity ?? -981;
        if (!ArcPhysicsWorld._float(gravity, 0.01)) throw new Error('PHYSICS_GRAVITY_INVALID');
        this.scene = scene;
        this.gravity = gravity;
        this.enabled = false;
        this.prepared = false;
        this.disposed = false;
        /** @type {BABYLON.HavokPlugin | null} */
        this.plugin = null;
        /** @type {Map<string, any>} */
        this.bodies = new Map();
        this.location = null;
        this._pending = null;
        this._enableRequest = 0;
        this._executing = false;
        this._cleanupCallbacks = [];
        this._previousPhysicsEnabled = scene.physicsEnabled;
        this._cancelled = new Promise(resolve => { this._cancel = () => resolve(null); });
    }

    static _loadBackend() {
        if (!this._backendPromise) {
            const factory = /** @type {any} */ (globalThis).HavokPhysics;
            if (typeof factory !== 'function') return Promise.reject(new Error('PHYSICS_BACKEND_MISSING: load libs/havok/HavokPhysics_umd.js'));
            this._backendPromise = Promise.resolve().then(() => factory()).catch(error => {
                this._backendPromise = null;
                throw new Error('PHYSICS_BACKEND_FAILED: ' + (error?.message || error));
            });
        }
        return this._backendPromise;
    }

    prepare() {
        if (this.disposed) return Promise.resolve(null);
        if (this.prepared) return Promise.resolve(this);
        if (this._pending) return this._pending;
        const loading = ArcPhysicsWorld._loadBackend().then(backend => {
            if (this.disposed) return null;
            if (this.scene.getPhysicsEngine()) throw new Error('PHYSICS_WORLD_ALREADY_OWNED');
            const plugin = new BABYLON.HavokPlugin(true, backend);
            if (!this.scene.enablePhysics(new BABYLON.Vector3(0, this.gravity / 100, 0), plugin)) {
                plugin.dispose(); throw new Error('PHYSICS_ENABLE_FAILED');
            }
            this.plugin = plugin;
            this.scene.physicsEnabled = false;
            this.prepared = true;
            try { if (this.location) this.registerLocation(this.location); }
            catch (error) { this._releaseBackend(); throw error; }
            return this;
        });
        this._pending = Promise.race([loading, this._cancelled]).finally(() => { this._pending = null; });
        return this._pending;
    }

    async setEnabled(enabled) {
        if (typeof enabled !== 'boolean') throw new Error('PHYSICS_ENABLED_INVALID');
        const request = ++this._enableRequest;
        if (this.disposed) return null;
        if (!enabled) { this.enabled = false; return this; }
        if (!await this.prepare() || request !== this._enableRequest) return null;
        this.enabled = true;
        return this;
    }

    registerLocation(location) {
        this.location = location;
        if (this.prepared && !this.disposed) for (const record of location.objects) this.syncObject(record);
        return this;
    }

    hasBody(id) { return this.bodies.has(id); }

    syncObject(record, options = {}) {
        if (!this.prepared || this.disposed || !record.mesh) return null;
        const id = record.def.id;
        if (!record.def.physics) { if (this.hasBody(id)) this.removeBody(id); return null; }
        let body = this.bodies.get(id);
        if (!body) {
            this.addBody(id, record.mesh, record.def.physics);
            body = this.bodies.get(id);
        } else if (body.mesh !== record.mesh || JSON.stringify(body.definition) !== JSON.stringify(ArcPhysicsWorld._definition(record.def.physics))) {
            throw new Error('PHYSICS_DEFINITION_CHANGED: remove and add the body explicitly: ' + id);
        }
        body.hidden = !!record.def.hidden;
        if (options.teleport) this._readVisual(body, true);
        this._refreshActive(body);
        return this.getBodyState(id);
    }

    static _definition(definition) {
        if (!ArcSchema.validPhysics(definition)) throw new Error('PHYSICS_DEFINITION_INVALID');
        const value = { enabled: definition.enabled ?? true, motion: definition.motion ?? 'dynamic', shape: definition.shape ?? 'box',
            mass: definition.mass ?? 1, friction: definition.friction ?? 0.5, restitution: definition.restitution ?? 0.1 };
        for (const key of ['size', 'radius', 'height', 'center']) if (definition[key] != null) value[key] = Array.isArray(definition[key]) ? definition[key].slice() : definition[key];
        if (![value.mass, value.friction, value.restitution].every(number => ArcPhysicsWorld._float(number))) throw new Error('PHYSICS_DEFINITION_INVALID');
        if (value.motion === 'dynamic' && (Math.fround(value.mass) <= 0 || !ArcPhysicsWorld._float(1 / value.mass))) throw new Error('PHYSICS_DEFINITION_INVALID');
        return value;
    }

    _assertReady() {
        if (this.disposed) throw new Error('PHYSICS_DISPOSED');
        if (!this.prepared) throw new Error('PHYSICS_NOT_PREPARED: await app.physics.prepare()');
    }

    _record(id) {
        this._assertReady();
        const record = this.bodies.get(id);
        if (!record) throw new Error('PHYSICS_BODY_MISSING: ' + id);
        return record;
    }

    static _pose(mesh) {
        mesh.computeWorldMatrix(true);
        const scale = new BABYLON.Vector3(), rotation = new BABYLON.Quaternion(), position = new BABYLON.Vector3();
        if (!mesh.getWorldMatrix().decompose(scale, rotation, position) || ![...scale.asArray(), ...rotation.asArray(), ...position.asArray()].every(Number.isFinite)
            || scale.asArray().some(value => Math.abs(value) < 1e-6)) throw new Error('PHYSICS_TRANSFORM_INVALID');
        rotation.normalize();
        // A rigid body's orientation cannot represent reflection or hierarchy shear.
        // Uniform positive parent scale allows world rotations to map back exactly.
        if (mesh.getWorldMatrix().determinant() <= 0) throw new Error('PHYSICS_TRANSFORM_UNSUPPORTED: mirrored transform');
        if (mesh.parent) {
            mesh.parent.computeWorldMatrix(true);
            const parentScale = new BABYLON.Vector3();
            mesh.parent.getWorldMatrix().decompose(parentScale);
            if (mesh.parent.getWorldMatrix().determinant() <= 0 || Math.max(...parentScale.asArray()) - Math.min(...parentScale.asArray()) > 1e-6 * Math.max(1, ...parentScale.asArray())) {
                throw new Error('PHYSICS_TRANSFORM_UNSUPPORTED: parent scale must be uniform and positive');
            }
        }
        const composed = BABYLON.Matrix.Compose(scale, rotation, position).asArray(), actual = mesh.getWorldMatrix().asArray();
        if (Array.from(actual).some((value, index) => Math.abs(value - composed[index]) > 1e-5 * Math.max(1, Math.abs(value)))) {
            throw new Error('PHYSICS_TRANSFORM_UNSUPPORTED: sheared transform');
        }
        return { scale, rotation, position };
    }

    static _collider(mesh, definition, pose) {
        const rigid = BABYLON.Matrix.Compose(BABYLON.Vector3.One(), pose.rotation, pose.position).invert();
        const min = new BABYLON.Vector3(Infinity, Infinity, Infinity), max = new BABYLON.Vector3(-Infinity, -Infinity, -Infinity);
        for (const child of [mesh, ...mesh.getChildMeshes()]) {
            if (typeof child.getTotalVertices !== 'function' || child.getTotalVertices() === 0) continue;
            child.computeWorldMatrix(true);
            for (const corner of child.getBoundingInfo().boundingBox.vectorsWorld) {
                const point = BABYLON.Vector3.TransformCoordinates(corner, rigid);
                min.minimizeInPlace(point); max.maximizeInPlace(point);
            }
        }
        const inferred = min.asArray().every(Number.isFinite);
        const size = definition.size ? new BABYLON.Vector3(...definition.size.map((value, index) => Math.abs(value * pose.scale.asArray()[index]))) : inferred ? max.subtract(min) : null;
        const center = definition.center ? BABYLON.Vector3.TransformCoordinates(BABYLON.Vector3.TransformCoordinates(BABYLON.Vector3.FromArray(definition.center), mesh.getWorldMatrix()), rigid)
            : inferred ? min.add(max).scale(0.5) : BABYLON.Vector3.Zero();
        const radius = definition.radius != null ? definition.radius * Math.max(Math.abs(pose.scale.x), Math.abs(pose.scale.z), definition.shape === 'sphere' ? Math.abs(pose.scale.y) : 0)
            : size ? (definition.shape === 'sphere' ? Math.max(size.x, size.y, size.z) : Math.max(size.x, size.z)) / 2 : null;
        const height = definition.height != null ? definition.height * Math.abs(pose.scale.y) : size?.y;
        if (definition.shape === 'box' && (!size || size.asArray().some(v => !Number.isFinite(v) || v <= 0))
            || definition.shape !== 'box' && (!Number.isFinite(radius) || radius <= 0)
            || definition.shape === 'capsule' && (!Number.isFinite(height) || height < radius * 2)) throw new Error('PHYSICS_COLLIDER_DIMENSIONS_INVALID');
        const result = /** @type {any} */ ({ shape: definition.shape, center: center.scale(0.01).asArray(),
            ...(definition.shape === 'box' ? { size: size.scale(0.01).asArray() } : { radius: radius / 100 }),
            ...(definition.shape === 'capsule' ? { height: height / 100 } : {}) });
        if (![...result.center, ...(result.size || []), ...(result.radius != null ? [result.radius] : []), ...(result.height != null ? [result.height] : [])]
            .every(value => ArcPhysicsWorld._float(value))) throw new Error('PHYSICS_COLLIDER_DIMENSIONS_INVALID');
        if ([...(result.size || []), ...(result.radius != null ? [result.radius] : []), ...(result.height != null ? [result.height] : [])]
            .some(value => Math.fround(value) <= 0)) throw new Error('PHYSICS_COLLIDER_DIMENSIONS_INVALID');
        return result;
    }

    addBody(id, mesh, definition) {
        this._assertReady();
        if (!ArcSchema.id(id) || this.bodies.has(id)) throw new Error('PHYSICS_BODY_ID_INVALID: ' + id);
        if (!mesh || mesh.isDisposed() || mesh.getScene() !== this.scene) throw new Error('PHYSICS_BODY_MESH_INVALID');
        if ([...this.bodies.values()].some(record => record.mesh === mesh)) throw new Error('PHYSICS_BODY_MESH_OWNED');
        this._assertSeparateMesh(mesh);
        const def = ArcPhysicsWorld._definition(definition), pose = ArcPhysicsWorld._pose(mesh), collider = ArcPhysicsWorld._collider(mesh, def, pose);
        const proxy = new BABYLON.TransformNode('physics:' + id, this.scene);
        proxy.position.copyFrom(pose.position).scaleInPlace(0.01); proxy.rotationQuaternion = pose.rotation.clone();
        const center = BABYLON.Vector3.FromArray(collider.center);
        let shape;
        try {
            if (def.shape === 'box') shape = new BABYLON.PhysicsShapeBox(center, BABYLON.Quaternion.Identity(), BABYLON.Vector3.FromArray(collider.size), this.scene);
            else if (def.shape === 'sphere') shape = new BABYLON.PhysicsShapeSphere(center, collider.radius, this.scene);
            else {
                const half = (collider.height - 2 * collider.radius) / 2;
                shape = new BABYLON.PhysicsShapeCapsule(center.add(new BABYLON.Vector3(0, -half, 0)), center.add(new BABYLON.Vector3(0, half, 0)), collider.radius, this.scene);
            }
            shape.material = { friction: def.friction, restitution: def.restitution };
            const record = { id, mesh, proxy, shape, definition: def, collider, initialScale: pose.scale.asArray(), enabled: def.enabled, hidden: false, body: null,
                linear: BABYLON.Vector3.Zero(), angular: BABYLON.Vector3.Zero() };
            this.bodies.set(id, record);
            try { this._refreshActive(record); }
            catch (error) { this.bodies.delete(id); throw error; }
            return this.getBodyState(id);
        } catch (error) { if (shape) shape.dispose(); proxy.dispose(); throw error; }
    }

    _refreshActive(record) {
        const active = record.enabled && !record.hidden && !record.mesh.isDisposed() && record.mesh.isEnabled();
        if (active && !record.body) {
            this._bodyPose(record);
            const motion = { static: BABYLON.PhysicsMotionType.STATIC, dynamic: BABYLON.PhysicsMotionType.DYNAMIC, kinematic: BABYLON.PhysicsMotionType.ANIMATED }[record.definition.motion];
            // Body initialization reads the absolute pose, including inactive teleports.
            record.proxy.computeWorldMatrix(true);
            const body = new BABYLON.PhysicsBody(record.proxy, motion, false, this.scene);
            try {
                body.shape = record.shape;
                body.setMassProperties({ mass: record.definition.motion === 'dynamic' ? record.definition.mass : 0 });
                body.setLinearVelocity(record.linear); body.setAngularVelocity(record.angular);
                record.body = body;
            } catch (error) { body.dispose(); throw error; }
        } else if (!active && record.body) {
            record.linear.copyFrom(record.body.getLinearVelocity()); record.angular.copyFrom(record.body.getAngularVelocity());
            record.body.dispose(); record.body = null;
        }
    }

    removeBody(id) {
        const record = this.bodies.get(id);
        if (!record) return false;
        if (record.body) record.body.dispose();
        record.shape.dispose(); record.proxy.dispose(); this.bodies.delete(id);
        return true;
    }

    setBodyEnabled(id, enabled) {
        if (typeof enabled !== 'boolean') throw new Error('PHYSICS_BODY_ENABLED_INVALID');
        const record = this._record(id); record.enabled = enabled; this._refreshActive(record);
        return this.getBodyState(id);
    }

    setBodyHidden(id, hidden) {
        if (typeof hidden !== 'boolean') throw new Error('PHYSICS_BODY_HIDDEN_INVALID');
        const record = this._record(id); record.hidden = hidden; this._refreshActive(record);
        return this.getBodyState(id);
    }

    static _mapVector(value, scale = 0.01) {
        if (!value || ![value.x, value.y, value.h].every(number => ArcPhysicsWorld._float(number, scale))) throw new Error('PHYSICS_VECTOR_INVALID');
        return new BABYLON.Vector3(value.x * scale, value.h * scale, value.y * scale);
    }

    // Havok stores float32 values. Finite JavaScript doubles can still overflow at
    // this boundary, including otherwise well-formed persisted snapshots.
    static _float(value, scale = 1) { return Number.isFinite(value) && Number.isFinite(Math.fround(value * scale)); }

    setVelocity(id, velocity) {
        const value = ArcPhysicsWorld._mapVector(velocity), record = this._record(id);
        record.linear.copyFrom(value); if (record.body) record.body.setLinearVelocity(value);
        return this.getBodyState(id);
    }

    setAngularVelocity(id, velocity) {
        if (!velocity || ![velocity.x, velocity.y, velocity.z].every(value => ArcPhysicsWorld._float(value))) throw new Error('PHYSICS_VECTOR_INVALID');
        const record = this._record(id), value = new BABYLON.Vector3(velocity.x, velocity.y, velocity.z);
        record.angular.copyFrom(value); if (record.body) record.body.setAngularVelocity(value);
        return this.getBodyState(id);
    }

    applyImpulse(id, impulse, point) {
        const force = ArcPhysicsWorld._mapVector(impulse), record = this._record(id);
        const location = point == null ? record.proxy.position.clone() : ArcPhysicsWorld._mapVector(point);
        if (!record.body || record.definition.motion !== 'dynamic') throw new Error('PHYSICS_BODY_NOT_DYNAMIC_ACTIVE');
        record.body.applyImpulse(force, location);
        return this.getBodyState(id);
    }

    _teleportProxy(record) {
        if (!record.body) return;
        const previous = record.body.getPrestepType();
        record.body.setPrestepType(BABYLON.PhysicsPrestepType.TELEPORT);
        try { this.plugin.setPhysicsBodyTransformation(record.body, record.proxy); }
        finally { record.body.setPrestepType(previous); }
    }

    teleport(id, position, quaternion) {
        const value = ArcPhysicsWorld._mapVector(position);
        if (quaternion != null && !ArcPhysicsWorld._quaternion(quaternion)) throw new Error('PHYSICS_ROTATION_INVALID');
        const record = this._record(id);
        this._bodyPose(record);
        record.proxy.position.copyFrom(value);
        if (quaternion) record.proxy.rotationQuaternion.copyFrom(BABYLON.Quaternion.FromArray(quaternion).normalize());
        this._teleportProxy(record); this._writeVisual(record);
        return this.getBodyState(id);
    }

    _readVisual(record, teleport = false) {
        const pose = this._bodyPose(record);
        record.proxy.position.copyFrom(pose.position).scaleInPlace(0.01); record.proxy.rotationQuaternion.copyFrom(pose.rotation);
        if (teleport) this._teleportProxy(record);
    }

    _writeVisual(record) {
        this._bodyPose(record);
        const mesh = record.mesh, rotation = record.proxy.rotationQuaternion.clone();
        if (mesh.parent) {
            mesh.parent.computeWorldMatrix(true);
            const parentRotation = BABYLON.Quaternion.Identity();
            mesh.parent.getWorldMatrix().decompose(undefined, parentRotation);
            parentRotation.conjugate().multiplyToRef(rotation, rotation);
        }
        if (!mesh.rotationQuaternion) mesh.rotationQuaternion = BABYLON.Quaternion.Identity();
        mesh.rotationQuaternion.copyFrom(rotation).normalize();
        mesh.setAbsolutePosition(record.proxy.position.scale(100));
        mesh.computeWorldMatrix(true);
    }

    _bodyPose(record) {
        this._assertSeparateMesh(record.mesh);
        const pose = ArcPhysicsWorld._pose(record.mesh);
        if (pose.scale.asArray().some((value, index) => Math.abs(value - record.initialScale[index]) > 1e-5 * Math.max(1, Math.abs(record.initialScale[index])))) {
            throw new Error('PHYSICS_COLLIDER_CHANGED: remove and add the body after changing its scale: ' + record.id);
        }
        return pose;
    }

    _assertSeparateMesh(mesh) {
        // Two rigid bodies cannot also inherit one another's visual transforms.
        // Check current ancestry so reparenting cannot reintroduce order-dependent sync.
        for (const record of this.bodies.values()) {
            if (record.mesh !== mesh && !record.mesh.isDisposed()
                && (mesh.isDescendantOf(record.mesh) || record.mesh.isDescendantOf(mesh))) {
                throw new Error('PHYSICS_NESTED_BODY_UNSUPPORTED: detach body meshes from one another');
            }
        }
    }

    step(dt) {
        if (!this.enabled || !this.prepared || this.disposed) return;
        if (!Number.isFinite(dt) || dt <= 0 || dt > 1) throw new Error('PHYSICS_STEP_INVALID');
        // ArcClock supports 1..240 Hz. Preserve the entire tick while bounding each
        // solver step; kinematic targets cover the whole tick, not its first substep.
        const steps = Math.ceil(dt * 60), delta = dt / steps, targets = new Map();
        for (const record of this.bodies.values()) if (!record.mesh.isDisposed() && record.definition.motion === 'kinematic') {
            const target = this._bodyPose(record);
            targets.set(record.id, { start: record.proxy.position.clone(), rotation: record.proxy.rotationQuaternion.clone(),
                end: target.position.scale(0.01), endRotation: target.rotation });
        }
        for (let index = 0; index < steps; index++) {
            this.scene.onBeforePhysicsObservable.notifyObservers(this.scene);
            if (this.disposed || !this.prepared || !this.enabled) return;
            for (const record of [...this.bodies.values()]) {
                if (record.mesh.isDisposed()) { this.removeBody(record.id); continue; }
                this._bodyPose(record);
                this._refreshActive(record);
                const target = targets.get(record.id);
                if (record.body && target) record.body.setTargetTransform(BABYLON.Vector3.Lerp(target.start, target.end, (index + 1) / steps),
                    BABYLON.Quaternion.Slerp(target.rotation, target.endRotation, (index + 1) / steps));
            }
            this._executing = true;
            try { this.plugin.executeStep(delta, /** @type {BABYLON.PhysicsEngineV2} */ (this.scene.getPhysicsEngine()).getBodies()); }
            finally {
                this._executing = false;
                try { if (this.disposed) this._releaseBackend(); }
                finally {
                    // ArcApp must also defer disposal of the owning scene: Babylon's
                    // scene disposal would otherwise free Havok from inside its callback.
                    const callbacks = this._cleanupCallbacks.splice(0);
                    for (const cleanup of callbacks) cleanup();
                }
            }
            if (this.disposed || !this.prepared || !this.enabled) return;
            for (const record of this.bodies.values()) if (record.body && record.definition.motion !== 'static') this._writeVisual(record);
            this.scene.onAfterPhysicsObservable.notifyObservers(this.scene);
            if (this.disposed || !this.prepared || !this.enabled) return;
        }
    }

    getBodyState(id) {
        const record = this.bodies.get(id);
        if (!record) return null;
        const position = record.proxy.position, linear = record.body ? record.body.getLinearVelocity() : record.linear;
        const angular = record.body ? record.body.getAngularVelocity() : record.angular;
        return { id, motion: record.definition.motion, enabled: record.enabled, hidden: record.hidden, active: !!record.body,
            position: { x: position.x * 100, y: position.z * 100, h: position.y * 100 }, rotation: record.proxy.rotationQuaternion.asArray(),
            linearVelocity: { x: linear.x * 100, y: linear.z * 100, h: linear.y * 100 }, angularVelocity: { x: angular.x, y: angular.y, z: angular.z } };
    }

    snapshot() {
        if (this.disposed) throw new Error('PHYSICS_DISPOSED');
        return { version: 1, prepared: this.prepared, enabled: this.enabled, gravity: this.gravity,
            bodies: [...this.bodies.values()].sort((a, b) => a.id.localeCompare(b.id)).map(record => {
                this._bodyPose(record);
                const state = this.getBodyState(record.id);
                return { id: record.id, definition: JSON.parse(JSON.stringify(record.definition)), collider: JSON.parse(JSON.stringify(record.collider)),
                    position: [state.position.x, state.position.h, state.position.y], rotation: state.rotation,
                    linearVelocity: [state.linearVelocity.x, state.linearVelocity.h, state.linearVelocity.y],
                    angularVelocity: [state.angularVelocity.x, state.angularVelocity.y, state.angularVelocity.z], enabled: record.enabled, hidden: record.hidden };
            }) };
    }

    static _quaternion(value) {
        return Array.isArray(value) && value.length === 4 && value.every(Number.isFinite) && Math.abs(Math.hypot(...value) - 1) < 0.001;
    }

    validateSnapshot(snapshot) {
        if (this.disposed) throw new Error('PHYSICS_DISPOSED');
        if (snapshot == null) {
            if (this.enabled || this.bodies.size) throw new Error('PHYSICS_SNAPSHOT_REQUIRED');
            return null;
        }
        if (!snapshot || snapshot.version !== 1 || typeof snapshot.prepared !== 'boolean' || typeof snapshot.enabled !== 'boolean'
            || !ArcPhysicsWorld._float(snapshot.gravity, 0.01) || !Array.isArray(snapshot.bodies) || snapshot.bodies.length !== this.bodies.size
            || !snapshot.prepared && (snapshot.enabled || snapshot.bodies.length)) throw new Error('PHYSICS_SNAPSHOT_INVALID');
        if (snapshot.prepared && !this.prepared) throw new Error('PHYSICS_NOT_PREPARED: prepare before restoring a physics snapshot');
        const ids = new Set(), vector = (value, scale = 0.01) => Array.isArray(value) && value.length === 3 && value.every(number => ArcPhysicsWorld._float(number, scale));
        for (const entry of snapshot.bodies) {
            const record = entry && this.bodies.get(entry.id);
            if (!record || ids.has(entry.id) || JSON.stringify(entry.definition) !== JSON.stringify(record.definition)
                || JSON.stringify(entry.collider) !== JSON.stringify(record.collider) || !vector(entry.position) || !vector(entry.linearVelocity)
                || !vector(entry.angularVelocity, 1) || !ArcPhysicsWorld._quaternion(entry.rotation)
                || typeof entry.enabled !== 'boolean' || typeof entry.hidden !== 'boolean') throw new Error('PHYSICS_SNAPSHOT_BODY_INVALID');
            if (record.mesh.isDisposed()) throw new Error('PHYSICS_BODY_MESH_INVALID');
            this._bodyPose(record);
            ids.add(entry.id);
        }
        return JSON.parse(JSON.stringify(snapshot));
    }

    restore(snapshot) {
        const state = this.validateSnapshot(snapshot);
        if (!state) return this;
        this.gravity = state.gravity;
        if (this.prepared) /** @type {BABYLON.PhysicsEngineV2} */ (this.scene.getPhysicsEngine()).setGravity(new BABYLON.Vector3(0, this.gravity / 100, 0));
        for (const entry of state.bodies) {
            const record = this.bodies.get(entry.id);
            // Restore explicit pose/velocity, not the old world's contact/sleep cache.
            if (record.body) { record.body.dispose(); record.body = null; }
            record.proxy.position.copyFrom(BABYLON.Vector3.FromArray(entry.position).scale(0.01));
            record.proxy.rotationQuaternion.copyFrom(BABYLON.Quaternion.FromArray(entry.rotation).normalize());
            record.linear.copyFrom(BABYLON.Vector3.FromArray(entry.linearVelocity).scale(0.01));
            record.angular.copyFrom(BABYLON.Vector3.FromArray(entry.angularVelocity));
            record.enabled = entry.enabled; record.hidden = entry.hidden;
            this._refreshActive(record); this._teleportProxy(record);
            if (record.body) { record.body.setLinearVelocity(record.linear); record.body.setAngularVelocity(record.angular); }
            this._writeVisual(record);
        }
        this.enabled = state.enabled;
        return this;
    }

    inspect() {
        return { prepared: this.prepared, enabled: this.enabled, disposed: this.disposed, gravity: this.gravity,
            bodies: this.bodies.size, activeBodies: [...this.bodies.values()].filter(record => record.body).length,
            backend: this.prepared ? 'havok-1.3.14' : null };
    }

    _releaseBackend() {
        for (const id of [...this.bodies.keys()]) this.removeBody(id);
        if (this.plugin) this.scene.disablePhysicsEngine();
        this.plugin = null; this.prepared = false; this.enabled = false;
        this.scene.physicsEnabled = this._previousPhysicsEnabled;
    }

    deferCleanup(callback) {
        if (typeof callback !== 'function') throw new Error('PHYSICS_CLEANUP_INVALID');
        if (this._executing) this._cleanupCallbacks.push(callback);
        else callback();
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true; this._enableRequest++; this._cancel();
        // Collision observers run inside executeStep. Keep its Havok world alive
        // until that call returns, then release it before any further owner work.
        if (!this._executing) this._releaseBackend();
        this.location = null;
    }
}
