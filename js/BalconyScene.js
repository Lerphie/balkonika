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

        this.photoMaterial = this.photoMaterialFor('reference', 'assets/balkonika/photo-v4/reference-photo.jpg', false);
        this.base = this.layer('photo-base', this.photoMaterial, 0, 0);

        this.wallMaterials = {
            white: this.photoMaterial,
            beige: this.photoMaterialFor('walls-beige', 'assets/balkonika/photo-v4/walls-beige.png', true),
            lightGray: this.photoMaterialFor('walls-lightgray', 'assets/balkonika/photo-v4/walls-lightgray.png', true)
        };
        this.wall = this.layer('wall-finish', this.wallMaterials.white, -0.01, 1);
        this.wall.setEnabled(false);
        this.wallMaterial = this.wallMaterials.white;

        this.floorMaterials = {
            lightWood: this.photoMaterial,
            darkWood: this.photoMaterialFor('floor-dark-wood', 'assets/balkonika/photo-v4/floor-dark-wood.png', true),
            grayTile: this.photoMaterialFor('floor-gray-tile', 'assets/balkonika/photo-v4/floor-gray-tile.png', true)
        };
        this.floor = this.layer('balcony-floor', this.floorMaterials.lightWood, -0.02, 1);
        this.floor.setEnabled(false);

        // Photographic details remain independent of the two selectable surfaces.
        this.ceilingMaterial = this.photoMaterialFor('ceiling', 'assets/balkonika/photo-v4/ceiling.png', true);
        this.ceiling = this.layer('photo-ceiling', this.ceilingMaterial, -0.03, 2);
        this.windowsMaterial = this.photoMaterialFor('windows', 'assets/balkonika/photo-v4/windows.png', true);
        this.windows = this.layer('photo-windows', this.windowsMaterial, -0.04, 2);
        this.createOutdoorMotion();
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

    // One small transparent overlay is reused throughout the session. The
    // painted areas stay inside the photographic sky and road, away from frames.
    createOutdoorMotion() {
        this.motionImages = [new Image(), new Image(), new Image()];
        this.motionImages[0].src = 'assets/balkonika/motion-v1/cloud.png';
        this.motionImages[1].src = 'assets/balkonika/motion-v1/car.png';
        this.motionImages[2].src = 'assets/balkonika/motion-v1/bird.png';
        this.motionMedia = window.matchMedia('(prefers-reduced-motion: reduce)');
        this.motion = { time: 0, reduced: this.motionMedia.matches, cloudX: 0, birdX: 0, birdY: 0, carX: 0, carY: 0, birdVisible: false, carVisible: false, skyBounds: [866, 8, 1240, 145], roadBounds: [910, 470, 1235, 710] };
        this.motionCanvas = document.createElement('canvas');
        this.motionCanvas.width = 400;
        this.motionCanvas.height = 730;
        this.motionContext = this.motionCanvas.getContext('2d');
        this.motionTexture = new BABYLON.DynamicTexture('outdoor-motion', this.motionCanvas, this.scene, false);
        this.motionTexture.hasAlpha = true;
        this.motionTexture.uScale = -1;
        this.motionTexture.uOffset = 1;
        this.motionTexture.vScale = -1;
        this.motionTexture.vOffset = 1;
        // A transparent first upload keeps scene readiness independent of motion preference.
        this.motionTexture.update(false);
        this.motionMaterial = new BABYLON.StandardMaterial('outdoor-motion', this.scene);
        this.motionMaterial.disableLighting = true;
        this.motionMaterial.emissiveColor = BABYLON.Color3.Black();
        this.motionMaterial.emissiveTexture = this.motionTexture;
        this.motionMaterial.opacityTexture = this.motionTexture;
        this.motionMaterial.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
        this.motionMaterial.specularColor = BABYLON.Color3.Black();
        this.motionMaterial.backFaceCulling = false;
        this.motionMaterial.metadata = { toon: false };
        this.motionMesh = BABYLON.MeshBuilder.CreatePlane('outdoor-motion', {width:400,height:730}, this.scene);
        this.motionMesh.position.set(-410, 54.5, -0.05);
        this.motionMesh.material = this.motionMaterial;
        World3D.addObject(this.view, this.motionMesh, 'prop', { castShadow:false, receiveShadows:false, ink:false, outline:false });
        this.motionMesh.renderingGroupId = 3;
        this.motionMesh.isPickable = false;
        this.motionMesh.setEnabled(false);
        this.motionReady = false;
        this.motionFrame = 0;
        this.onMotionPreference = event => {
            this.motion.reduced = event.matches;
            this.motionMesh.setEnabled(this.motionReady && !event.matches);
            if (this.motionReady && !event.matches) this.drawOutdoorMotion();
        };
        this.motionMedia.addEventListener('change', this.onMotionPreference);
    }

    update(dt) {
        if (!this.motionReady || this.motion.reduced) return;
        this.motion.time += Math.max(0, Math.min(dt, 0.1));
        this.motionFrame += dt;
        if (this.motionFrame >= 1 / 12) { this.motionFrame %= 1 / 12; this.drawOutdoorMotion(); }
    }

    drawOutdoorMotion() {
        const ctx = this.motionContext, m = this.motion, t = m.time;
        const [cloud, car, bird] = this.motionImages;
        ctx.clearRect(0, 0, 400, 730);
        // The right-hand upper pane, safely inside the frame and above rooflines.
        ctx.save();
        ctx.beginPath(); ctx.rect(17, 9, 373, 133); ctx.clip();
        m.cloudX = 824 + (t * 3.1 % 520);
        ctx.globalAlpha = 0.38;
        ctx.drawImage(cloud, m.cloudX - 850, 47, 188, 38);
        ctx.drawImage(cloud, m.cloudX - 850 - 285, 98, 136, 28);
        const birdPhase = t % 23;
        m.birdVisible = birdPhase < 10;
        m.birdX = 900 + birdPhase * 34;
        m.birdY = 76 + Math.sin(birdPhase * 0.65) * 6;
        if (m.birdVisible) {
            const flap = 0.75 + 0.25 * Math.cos(birdPhase * 6.5);
            ctx.globalAlpha = 0.88 * Math.min(1, birdPhase, 10 - birdPhase);
            ctx.drawImage(bird, m.birdX - 850, m.birdY, 12, 8 * flap);
        }
        ctx.restore();
        // A single car follows the photographic lane, growing with perspective.
        const carPhase = t % 28;
        m.carVisible = carPhase < 14;
        m.carX = 920 + carPhase * 22;
        m.carY = 475 + (m.carX - 920) * 0.69;
        if (m.carVisible) {
            ctx.save(); ctx.beginPath();
            ctx.moveTo(56, 462); ctx.lineTo(390, 690); ctx.lineTo(390, 714); ctx.lineTo(56, 486); ctx.closePath(); ctx.clip();
            const scale = 0.9 + carPhase * 0.022;
            ctx.globalAlpha = 0.9 * Math.min(1, carPhase, 14 - carPhase);
            ctx.drawImage(car, m.carX - 850, m.carY, 17 * scale, 12 * scale);
            ctx.restore();
        }
        this.motionTexture.update(false);
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
                if (textures.some(texture => texture.loadingError) || this.motionImages.some(img => img.complete && !img.naturalWidth)) {
                    finish(new Error('Не удалось загрузить материалы балкона. Проверьте соединение и обновите страницу.'));
                } else if (textures.every(texture => texture.isReady()) && this.motionImages.every(img => img.complete && img.naturalWidth > 0)) {
                    this.motionReady = true;
                    if (!this.motion.reduced) { this.drawOutdoorMotion(); this.motionMesh.setEnabled(true); }
                    finish(null);
                }
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
        this.motionMedia.removeEventListener('change', this.onMotionPreference);
        this.motionReady = false;
        World3D.removeObject(this.view, this.motionMesh);
        this.motionMaterial.dispose(false, false);
        this.motionTexture.dispose();
        for (const image of this.motionImages) image.removeAttribute('src');
        for (const mesh of this.meshes) World3D.removeObject(this.view, mesh);
        for (const material of this.materials) material.dispose(false, false);
        for (const texture of this.textures) texture.dispose();
        this.camera.dispose();
        this.scene.activeCamera = this.view.camera;
    }
}
