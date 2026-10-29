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
            beige: this.photoMaterialFor('walls-beige', 'assets/balkonika/walls-v3/beige.png', true),
            lightGray: this.photoMaterialFor('walls-lightgray', 'assets/balkonika/walls-v3/light-gray.png', true)
        };
        this.wall = this.layer('wall-finish', this.wallMaterials.white, -0.01, 1);
        this.wall.setEnabled(false);
        this.wallMaterial = this.wallMaterials.white;

        this.floorMaterials = {
            lightWood: this.photoMaterial,
            darkWood: this.photoMaterialFor('floor-dark-wood', 'assets/balkonika/floors-v3/floor-dark-wood.png', true),
            grayTile: this.photoMaterialFor('floor-gray-tile', 'assets/balkonika/floors-v3/floor-gray-tile.png', true),
            herringbone: this.photoMaterialFor('floor-herringbone', 'assets/balkonika/floors-v3/floor-herringbone.png', true),
            warmTile: this.photoMaterialFor('floor-warm-tile', 'assets/balkonika/floors-v3/floor-warm-tile.png', true)
        };
        this.floor = this.layer('balcony-floor', this.floorMaterials.lightWood, -0.02, 1);
        this.floor.setEnabled(false);

        // Photographic details remain independent of the two selectable surfaces.
        this.ceilingMaterial = this.photoMaterialFor('ceiling', 'assets/balkonika/photo-v4/ceiling.png', true);
        this.ceiling = this.layer('photo-ceiling', this.ceilingMaterial, -0.03, 2);
        this.windowsMaterial = this.photoMaterialFor('windows', 'assets/balkonika/walls-v3/windows.png', true);
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
        this.motionImages = [new Image(), new Image(), new Image(), new Image()];
        this.motionImages[0].src = 'assets/balkonika/motion-v1/cloud.png';
        this.motionImages[1].src = 'assets/balkonika/motion-v1/car.png';
        this.motionImages[2].src = 'assets/balkonika/motion-v1/bird.png';
        this.motionImages[3].src = 'assets/balkonika/motion-v1/car-light.png';
        // The drifting sky is cut from the existing photograph, not a flat blue overlay.
        this.skyImage = new Image();
        this.skyImage.src = 'assets/balkonika/photo-v4/reference-photo.jpg';
        this.motionMedia = window.matchMedia('(prefers-reduced-motion: reduce)');
        this.motion = { time: 0, reduced: this.motionMedia.matches, cloudX: 0, birdX: 0, birdY: 0, carX: 0, carY: 0, birdVisible: false, carVisible: false, skyBounds: [688, 7, 1246, 290], roadBounds: [910, 470, 1235, 710], birds: [], cars: [] };
        this.motionCanvas = document.createElement('canvas');
        this.motionCanvas.width = 620;
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
        this.motionMesh = BABYLON.MeshBuilder.CreatePlane('outdoor-motion', {width:620,height:730}, this.scene);
        this.motionMesh.position.set(-300, 54.5, -0.05);
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

    // Reuse a softly feathered piece of the original sky as a seamless moving tile.
    prepareSkyTile() {
        const tile = this.skyTile = document.createElement('canvas');
        tile.width = 430; tile.height = 275;
        const c = tile.getContext('2d');
        c.drawImage(this.skyImage, 879, 8, 353, 115, 0, 0, 430, 275);
        const fade = c.createLinearGradient(0, 0, 430, 0);
        fade.addColorStop(0, 'rgba(255,255,255,0)');
        fade.addColorStop(0.18, 'rgba(255,255,255,1)');
        fade.addColorStop(0.82, 'rgba(255,255,255,1)');
        fade.addColorStop(1, 'rgba(255,255,255,0)');
        c.globalCompositeOperation = 'destination-in'; c.fillStyle = fade; c.fillRect(0, 0, 430, 275);
        // The photo's distant horizon is pale; blend the sky tile into that haze.
        const horizon = c.createLinearGradient(0, 145, 0, 275);
        horizon.addColorStop(0, 'rgba(255,255,255,1)');
        horizon.addColorStop(1, 'rgba(255,255,255,0)');
        c.fillStyle = horizon; c.fillRect(0, 0, 430, 275);
    }

    // Trace the actual glass and the city roofline, keeping profiles and buildings in front.
    clipSky(ctx) {
        ctx.beginPath();
        ctx.moveTo(689, 68); ctx.lineTo(716, 15); ctx.lineTo(716, 241);
        ctx.lineTo(705, 241); ctx.lineTo(689, 245); ctx.closePath();
        ctx.moveTo(745, 8); ctx.lineTo(814, 8); ctx.lineTo(814, 265);
        ctx.lineTo(803, 264); ctx.lineTo(799, 257); ctx.lineTo(796, 259);
        ctx.lineTo(793, 246); ctx.lineTo(782, 244); ctx.lineTo(777, 240);
        ctx.lineTo(766, 242); ctx.lineTo(745, 246); ctx.closePath();
        ctx.moveTo(872, 8); ctx.lineTo(1242, 8); ctx.lineTo(1242, 157);
        ctx.lineTo(1218, 157); ctx.lineTo(1204, 152); ctx.lineTo(1190, 148);
        ctx.lineTo(1171, 149); ctx.lineTo(1160, 155); ctx.lineTo(1126, 156);
        ctx.lineTo(1118, 148); ctx.lineTo(1105, 145); ctx.lineTo(1094, 147);
        ctx.lineTo(1086, 151); ctx.lineTo(1086, 157); ctx.lineTo(1074, 158);
        ctx.lineTo(1060, 163); ctx.lineTo(1055, 162); ctx.lineTo(1053, 166);
        ctx.lineTo(1040, 170); ctx.lineTo(1017, 178); ctx.lineTo(1017, 261);
        ctx.lineTo(1004, 261); ctx.lineTo(993, 258); ctx.lineTo(982, 260);
        ctx.lineTo(974, 261); ctx.lineTo(970, 236); ctx.lineTo(951, 235);
        ctx.lineTo(944, 230); ctx.lineTo(930, 228); ctx.lineTo(923, 233);
        ctx.lineTo(912, 234); ctx.lineTo(900, 234); ctx.lineTo(890, 241);
        ctx.lineTo(886, 265); ctx.lineTo(872, 269); ctx.closePath();
        ctx.clip();
    }

    drawOutdoorMotion() {
        const ctx = this.motionContext, m = this.motion, t = m.time;
        const [cloud, car, bird, lightCar] = this.motionImages;
        ctx.clearRect(0, 0, 620, 730);
        ctx.save(); ctx.translate(-630, 0);
        // All three glass panes share a sky that drifts continuously behind the frames.
        ctx.save(); this.clipSky(ctx);
        const sky = ctx.createLinearGradient(0, 0, 0, 290);
        sky.addColorStop(0, '#b4cde7'); sky.addColorStop(0.5, '#d2e3ef'); sky.addColorStop(0.8, '#e9eeed'); sky.addColorStop(1, '#f1f1e9');
        ctx.fillStyle = sky; ctx.fillRect(685, 7, 561, 285);
        m.cloudX = 690 + (t * 3.1 % 330);
        const offset = (t * 3.1) % 330;
        for (let x = 350 + offset; x < 1500; x += 330) {
            ctx.globalAlpha = 0.85; ctx.drawImage(this.skyTile, x, 7, 430, 275);
        }
        ctx.globalAlpha = 0.28;
        for (let x = 500 + (t * 3.8 % 450); x < 1500; x += 450) {
            ctx.drawImage(cloud, x, 86, 188, 38);
            ctx.drawImage(cloud, x + 205, 190, 136, 28);
        }
        // Pairs use staggered, varied paths so birds do not repeat in lockstep.
        m.birds = [];
        for (const spec of [{cycle:23,delay:0,start:890,speed:34,y:76,size:12}, {cycle:37,delay:11,start:755,speed:23,y:115,size:8}]) {
            const phase = (t + spec.delay) % spec.cycle, visible = phase < 10;
            const x = spec.start + phase * spec.speed, y = spec.y + Math.sin(phase * 0.65) * 6;
            m.birds.push({x, y, visible});
            if (visible) {
                const flap = 0.75 + 0.25 * Math.cos(phase * 6.5);
                ctx.globalAlpha = 0.85 * Math.min(1, phase, 10 - phase);
                ctx.drawImage(bird, x, y, spec.size, spec.size * 0.67 * flap);
            }
        }
        m.birdX = m.birds[0].x; m.birdY = m.birds[0].y; m.birdVisible = m.birds[0].visible;
        ctx.restore();
        // Cars follow the two photographic lanes at different times and speeds.
        ctx.save(); ctx.beginPath();
        ctx.moveTo(906, 462); ctx.lineTo(1240, 690); ctx.lineTo(1240, 714); ctx.lineTo(906, 486); ctx.closePath(); ctx.clip();
        m.cars = [];
        for (const spec of [{cycle:28,delay:0,speed:22,offset:0,reverse:false}, {cycle:47,delay:19,speed:19,offset:-7,reverse:true}]) {
            const phase = (t + spec.delay) % spec.cycle, visible = phase < 14;
            const x = spec.reverse ? 1230 - phase * spec.speed : 920 + phase * spec.speed;
            const y = 475 + (x - 920) * 0.69 + spec.offset;
            m.cars.push({x, y, visible});
            if (visible) {
                const scale = 0.9 + Math.max(0, x - 920) * 0.001;
                ctx.globalAlpha = 0.85 * Math.min(1, phase, 14 - phase);
                if (spec.reverse) { ctx.save(); ctx.translate(x + 17*scale, y + 12*scale); ctx.rotate(Math.PI); ctx.drawImage(lightCar, 0, 0, 17*scale, 12*scale); ctx.restore(); }
                else ctx.drawImage(car, x, y, 17*scale, 12*scale);
            }
        }
        m.carX = m.cars[0].x; m.carY = m.cars[0].y; m.carVisible = m.cars[0].visible;
        ctx.restore(); ctx.restore();
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
                if (textures.some(texture => texture.loadingError) || [...this.motionImages, this.skyImage].some(img => img.complete && !img.naturalWidth)) {
                    finish(new Error('Не удалось загрузить материалы балкона. Проверьте соединение и обновите страницу.'));
                } else if (textures.every(texture => texture.isReady()) && [...this.motionImages, this.skyImage].every(img => img.complete && img.naturalWidth > 0)) {
                    this.motionReady = true;
                    this.prepareSkyTile();
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
        this.skyImage.removeAttribute('src');
        for (const mesh of this.meshes) World3D.removeObject(this.view, mesh);
        for (const material of this.materials) material.dispose(false, false);
        for (const texture of this.textures) texture.dispose();
        this.camera.dispose();
        this.scene.activeCamera = this.view.camera;
    }
}
