// Photo-based balcony: separately owned, pre-baked image layers and a fixed camera.
// The reference photograph supplies lighting and shadows; no dynamic shadows are used.
class BalconyScene {
    /** @param {ArcApp} app */
    constructor(app) {
        this.view = app.location.view;
        this.scene = this.view.scene;
        this.meshes = [];
        this.materials = [];
        this.textures = [];
        for (const mesh of app.location.terrain.meshes) mesh.setEnabled(false);
        this.scene.fogMode = BABYLON.Scene.FOGMODE_NONE;
        this.scene.shadowsEnabled = false;
        this.scene.clearColor = new BABYLON.Color4(0.956, 0.965, 0.957, 1);

        // Image-space geometry keeps the reference composition intact as the viewport changes.
        this.photoWidth = 1280;
        this.photoHeight = 839;
        this.camera = new BABYLON.FreeCamera('balcony-fixed-camera', new BABYLON.Vector3(0, 0, -10), this.scene);
        this.camera.setTarget(BABYLON.Vector3.Zero());
        this.camera.mode = BABYLON.Camera.ORTHOGRAPHIC_CAMERA;
        this.camera.minZ = 0.1;
        this.camera.maxZ = 100;
        this.scene.activeCamera = this.camera;
        this.fitCamera();
        this.stopCameraSync = this.view.onBeforeFrame(() => this.fitCamera());

        this.photoMaterial = this.photoMaterialFor('reference', 'assets/balkonika/photo-v3/reference-photo.jpg', false);
        this.base = this.layer('photo-base', this.photoMaterial, 0, 0);

        this.wallMaterials = {
            white: this.photoMaterial,
            beige: this.photoMaterialFor('walls-beige', 'assets/balkonika/photo-v3/walls-beige.png', true),
            lightGray: this.photoMaterialFor('walls-lightgray', 'assets/balkonika/photo-v3/walls-lightgray.png', true)
        };
        this.wall = this.layer('wall-finish', this.wallMaterials.white, -0.01, 1);
        this.wall.setEnabled(false);
        this.wallMaterial = this.wallMaterials.white;

        this.floorMaterials = {
            lightWood: this.photoMaterial,
            darkWood: this.photoMaterialFor('floor-dark-wood', 'assets/balkonika/photo-v3/floor-dark-wood.png', true),
            grayTile: this.photoMaterialFor('floor-gray-tile', 'assets/balkonika/photo-v3/floor-gray-tile.png', true)
        };
        this.floor = this.layer('balcony-floor', this.floorMaterials.lightWood, -0.02, 2);
        this.floor.setEnabled(false);

        // Photographic details remain independent of the two selectable surfaces.
        this.ceilingMaterial = this.photoMaterialFor('ceiling', 'assets/balkonika/photo-v3/ceiling.png', true);
        this.ceiling = this.layer('photo-ceiling', this.ceilingMaterial, -0.03, 3);
        this.windowsMaterial = this.photoMaterialFor('windows', 'assets/balkonika/photo-v3/windows.png', true);
        this.windows = this.layer('photo-windows', this.windowsMaterial, -0.04, 3);
    }

    fitCamera() {
        const canvas = this.view.scene.getEngine().getRenderingCanvas();
        if (!canvas || !canvas.clientWidth || !canvas.clientHeight) return;
        const ratio = canvas.clientWidth / canvas.clientHeight;
        const imageRatio = this.photoWidth / this.photoHeight;
        const halfWidth = ratio >= imageRatio ? this.photoHeight * ratio / 2 : this.photoWidth / 2;
        const halfHeight = ratio >= imageRatio ? this.photoHeight / 2 : this.photoWidth / (2 * ratio);
        this.camera.orthoLeft = -halfWidth;
        this.camera.orthoRight = halfWidth;
        this.camera.orthoBottom = -halfHeight;
        this.camera.orthoTop = halfHeight;
    }

    /** @param {string} name @param {string} path @param {boolean} transparent */
    photoMaterialFor(name, path, transparent) {
        const material = new BABYLON.StandardMaterial('photo-' + name, this.scene);
        const texture = new BABYLON.Texture(path, this.scene, false, true);
        texture.anisotropicFilteringLevel = 4;
        // A right-handed camera viewing this plane reverses U; restore the photo orientation.
        texture.uScale = -1;
        texture.uOffset = 1;
        material.disableLighting = true;
        material.emissiveColor = BABYLON.Color3.Black();
        material.emissiveTexture = texture;
        material.specularColor = BABYLON.Color3.Black();
        material.backFaceCulling = false;
        material.metadata = { toon: false };
        if (transparent) {
            texture.hasAlpha = true;
            material.opacityTexture = texture;
            material.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
        }
        this.textures.push(texture);
        this.materials.push(material);
        return material;
    }

    /** @param {string} name @param {BABYLON.StandardMaterial} material @param {number} z @param {number} group */
    layer(name, material, z, group) {
        const mesh = BABYLON.MeshBuilder.CreatePlane(name, { width: this.photoWidth, height: this.photoHeight }, this.scene);
        mesh.position.z = z;
        mesh.material = material;
        World3D.addObject(this.view, mesh, 'prop', { castShadow: false, receiveShadows: false, ink: false, outline: false });
        mesh.renderingGroupId = group;
        mesh.isPickable = false;
        this.meshes.push(mesh);
        return mesh;
    }

    // Existing texture objects are loaded once before the app is made interactive.
    /** @param {AbortSignal} signal @returns {Promise<void>} */
    waitForTextures(signal) {
        const textures = this.textures;
        return new Promise((resolve, reject) => {
            let settled = false, pollTimer = 0, deadlineTimer = 0;
            const finish = (error) => {
                if (settled) return;
                settled = true;
                window.clearInterval(pollTimer);
                window.clearTimeout(deadlineTimer);
                signal.removeEventListener('abort', onAbort);
                if (error) reject(error); else resolve();
            };
            const onAbort = () => finish(new DOMException('Загрузка отменена', 'AbortError'));
            if (signal.aborted) { onAbort(); return; }
            signal.addEventListener('abort', onAbort, { once: true });
            const check = () => {
                if (signal.aborted) { onAbort(); return; }
                if (textures.some(texture => texture.loadingError)) {
                    finish(new Error('Не удалось загрузить материалы балкона. Проверьте соединение и обновите страницу.'));
                } else if (textures.every(texture => texture.isReady())) finish(null);
            };
            pollTimer = window.setInterval(check, 50);
            deadlineTimer = window.setTimeout(() => finish(new Error('Загрузка материалов заняла слишком много времени. Проверьте соединение и обновите страницу.')), 45000);
            check();
        });
    }

    /** @param {string} value */
    setWall(value) {
        if (!Object.hasOwn(this.wallMaterials, value)) return;
        this.wallMaterial = this.wallMaterials[value];
        this.wall.material = this.wallMaterial;
        this.wall.setEnabled(value !== 'white');
    }

    /** @param {string} value */
    setFloor(value) {
        if (!Object.hasOwn(this.floorMaterials, value)) return;
        this.floor.material = this.floorMaterials[value];
        this.floor.setEnabled(value !== 'lightWood');
    }

    dispose() {
        this.stopCameraSync();
        for (const mesh of this.meshes) World3D.removeObject(this.view, mesh);
        for (const material of this.materials) material.dispose(false, false);
        for (const texture of this.textures) texture.dispose();
        this.camera.dispose();
        this.scene.activeCamera = this.view.camera;
    }
}
