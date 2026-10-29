// BalconyScene owns the fixed presentation camera and all finish materials.
// The three floor maps are baked locally and loaded once per scene.
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
        this.scene.clearColor = new BABYLON.Color4(0.83, 0.89, 0.90, 1);
        this.view.hemi.intensity = 0.76;
        this.view.hemi.diffuse = new BABYLON.Color3(1, 0.98, 0.95);
        this.view.hemi.groundColor = new BABYLON.Color3(0.90, 0.89, 0.85);
        this.view.sun.intensity = 0.34;
        if (!IS_MOBILE && this.view.shadow.usePercentageCloserFiltering) {
            this.view.shadow.filteringQuality = BABYLON.ShadowGenerator.QUALITY_HIGH;
        }
        this.view.sun.direction = new BABYLON.Vector3(1, -0.50, 0.08).normalize();
        this.scene.metadata.arcSun = {
            dir: this.view.sun.direction.negate().normalize(),
            color: this.view.sun.diffuse.scale(this.view.sun.intensity)
        };
        this.scene.metadata.arcShadow = {
            color: new BABYLON.Color3(0.72, 0.69, 0.64), strength: 0.34
        };
        // CameraController fits its own view; keep this static interior's sunlight
        // centred on the room immediately before each render instead.
        this.stopLightingSync = this.view.onBeforeFrame(() => this.view.updateLightFrustum(0, -20, 110, 430));

        this.camera = new BABYLON.TargetCamera('balcony-fixed-camera', new BABYLON.Vector3(0, 155, -307), this.scene);
        this.camera.minZ = 1;
        this.camera.maxZ = 2000;
        this.camera.fov = 68 * Math.PI / 180;
        this.camera.setTarget(new BABYLON.Vector3(0, 20, 210));
        this.scene.activeCamera = this.camera;

        this.wallMaterial = this.material('walls', '#ecebe7');
        this.wallMaterial.emissiveColor = new BABYLON.Color3(0.11, 0.11, 0.11);
        const plaster = new BABYLON.Texture('assets/balkonika/wall-plaster-photo-v2.webp', this.scene, false, false);
        plaster.anisotropicFilteringLevel = 8;
        plaster.uScale = 3;
        plaster.vScale = 3;
        this.wallMaterial.diffuseTexture = plaster;
        this.textures.push(plaster);
        const white = this.material('window-frame', '#f2f1eb');
        const frameSide = this.material('window-frame-shadow', '#b5b9b6');
        const ceiling = this.material('ceiling', '#f6f5ef');
        ceiling.emissiveColor = new BABYLON.Color3(0.24, 0.24, 0.23);
        const sky = this.material('outside-sky', '#c2dde5', true);
        const city = new BABYLON.Texture('assets/balkonika/city-daylight-v2.webp', this.scene, false, true);
        city.anisotropicFilteringLevel = 8;
        sky.emissiveColor = BABYLON.Color3.Black();
        sky.emissiveTexture = city;
        this.textures.push(city);
        const landscape = this.material('outside-landscape', '#c9d9d1', true);
        const glass = this.material('glass', '#e1eff0');
        glass.alpha = 0.12;
        glass.specularColor = new BABYLON.Color3(0.25, 0.25, 0.25);
        const apartmentGlass = this.material('apartment-window-glass', '#737c78', true);
        const apartmentImage = new BABYLON.Texture('assets/balkonika/interior-reflection-v2.webp', this.scene, false, true);
        apartmentImage.anisotropicFilteringLevel = 8;
        apartmentGlass.emissiveColor = BABYLON.Color3.Black();
        apartmentGlass.emissiveTexture = apartmentImage;
        apartmentGlass.backFaceCulling = false;
        this.textures.push(apartmentImage);
        const contactShadow = this.material('contact-shadow', '#4c4b46', true);
        contactShadow.alpha = 0.10;

        this.floorMaterials = {
            lightWood: this.floorMaterial('light-wood', 'assets/balkonika/light-wood-photo-v2.webp'),
            darkWood: this.floorMaterial('dark-wood', 'assets/balkonika/dark-wood-photo-v2.webp'),
            grayTile: this.floorMaterial('gray-tile', 'assets/balkonika/gray-tile-photo-v2.webp')
        };
        this.floor = BABYLON.MeshBuilder.CreateGround('balcony-floor', { width: 240, height: 680 }, this.scene);
        this.floor.position.set(0, 0, -20);
        this.floor.material = this.floorMaterials.lightWood;
        this.register(this.floor);

        // The near room wall is split around the inset apartment window.
        this.box('left-wall-under-window', [123, 51, -20], [6, 102, 680], this.wallMaterial);
        this.box('left-wall-over-window', [123, 247, -20], [6, 6, 680], this.wallMaterial);
        this.box('left-wall-near-return', [123, 174, -348], [6, 144, 24], this.wallMaterial);
        this.box('left-wall-far-return', [123, 174, 110], [6, 144, 420], this.wallMaterial);
        this.box('end-wall', [0, 125, 323], [240, 250, 6], this.wallMaterial);
        this.box('right-low-wall', [-123, 46, -20], [6, 92, 680], this.wallMaterial);
        this.box('ceiling', [0, 253, -20], [240, 6, 680], ceiling);

        // Thin skirting and softly blended contact shadows clarify floor-wall joins.
        this.box('left-baseboard', [119, 3.5, -20], [2, 7, 680], white);
        this.box('right-baseboard', [-119, 3.5, -20], [2, 7, 680], white);
        this.box('end-baseboard', [0, 3.5, 319], [238, 7, 2], white);
        this.box('left-floor-contact-shadow', [117, 0.15, -20], [4, 0.15, 680], contactShadow);
        this.box('right-floor-contact-shadow', [-117, 0.15, -20], [4, 0.15, 680], contactShadow);
        this.box('end-floor-contact-shadow', [0, 0.15, 317], [234, 0.15, 4], contactShadow);

        // Inset apartment window: recess, sill, frames, and dark interior glazing.
        const apartmentBackdrop = BABYLON.MeshBuilder.CreatePlane('apartment-window-recess', { width: 235, height: 142 }, this.scene);
        apartmentBackdrop.position.set(124, 173, -217.5);
        apartmentBackdrop.rotation.y = Math.PI / 2;
        apartmentBackdrop.material = apartmentGlass;
        this.register(apartmentBackdrop);
        this.box('apartment-window-glass', [122, 173, -217.5], [0.4, 142, 235], glass);
        this.box('apartment-window-sill', [111, 103, -217.5], [28, 6, 240], white);
        this.box('apartment-window-top', [118, 243, -217.5], [10, 7, 240], white);
        this.box('apartment-window-bottom', [118, 109, -217.5], [10, 8, 240], white);
        for (const z of [-334, -164, -101]) {
            this.box('apartment-window-mullion-' + z, [118, 176, z], [10, 134, 6], white);
            this.box('apartment-window-mullion-shadow-' + z, [112, 176, z - 3], [2, 134, 2], frameSide);
        }

        // The outside backdrop is a separately owned vertical plane behind the glass.
        this.outsideBackdrop = BABYLON.MeshBuilder.CreatePlane('daylight', { width: 674, height: 380 }, this.scene);
        this.outsideBackdrop.position.set(-137, 170, -20);
        this.outsideBackdrop.rotation.y = Math.PI / 2;
        sky.backFaceCulling = false;
        this.outsideBackdrop.material = sky;
        this.register(this.outsideBackdrop);
        this.outsideHorizon = this.box('distant-horizon', [-135, 105, -20], [2, 28, 674], landscape);
        this.outsideHorizon.setEnabled(false);
        // The window profiles meet the near face of the plaster return at z=314.
        // Their shared endpoint avoids both intersections and visible gaps.
        const windowNearZ = -360;
        const windowEndZ = 314;
        const windowCenterZ = (windowNearZ + windowEndZ) / 2;
        const windowDepth = windowEndZ - windowNearZ;
        this.box('window-glass', [-123, 171, windowCenterZ], [1, 148, windowDepth], glass);
        this.box('window-sill', [-110, 95, windowCenterZ], [31, 7, windowDepth], white);
        this.box('sill-shadow', [-118, 90, windowCenterZ], [12, 3, windowDepth], frameSide);
        this.box('frame-top', [-121, 245, windowCenterZ], [10, 8, windowDepth], white);
        this.box('frame-bottom', [-121, 105, windowCenterZ], [10, 7, windowDepth], white);
        for (const z of [-356, -222, -88, 46, 180, windowEndZ - 2.25]) {
            this.box('window-mullion-' + z, [-120, 175, z], [8, 144, 4.5], white);
            this.box('mullion-edge-' + z, [-114, 175, z - 3], [1, 144, 1.2], frameSide);
        }
        this.box('window-end-return', [-110, 174, 317], [20, 152, 6], this.wallMaterial);
        this.box('window-midrail', [-121, 164, windowCenterZ], [8, 5, windowDepth], white);
        this.setWall('white');
    }

    // The runtime waits for existing texture objects before the game becomes ready.
    // Polling also observes Babylon's loadingError; all timers are cleared on abort.
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

    /** @param {string} name @param {string} hex @param {boolean} [unlit] */
    material(name, hex, unlit = false) {
        const material = new BABYLON.StandardMaterial('balcony-' + name, this.scene);
        material.diffuseColor = BABYLON.Color3.FromHexString(hex);
        material.specularColor = new BABYLON.Color3(0, 0, 0);
        material.metadata = { toon: false };
        if (unlit) {
            material.disableLighting = true;
            material.emissiveColor = BABYLON.Color3.FromHexString(hex);
        }
        this.materials.push(material);
        return material;
    }

    /** @param {string} name @param {string} path */
    floorMaterial(name, path) {
        const material = this.material(name, '#ffffff');
        material.emissiveColor = new BABYLON.Color3(0.07, 0.07, 0.07);
        const texture = new BABYLON.Texture(path, this.scene, false, false);
        texture.anisotropicFilteringLevel = 8;
        // Preserve the image aspect ratio on the long floor, keeping tiles square.
        texture.uScale = (240 / 680) / (940 / 1672);
        material.diffuseTexture = texture;
        this.textures.push(texture);
        return material;
    }

    /** @param {BABYLON.AbstractMesh} mesh */
    register(mesh) {
        const castsSun = /^(window-mullion-|window-midrail|frame-top|frame-bottom)/.test(mesh.name);
        const receivesSun = /^(balcony-floor|left-wall-|end-wall|right-low-wall)/.test(mesh.name);
        World3D.addObject(this.view, mesh, 'prop', { castShadow: castsSun, receiveShadows: receivesSun, ink: false, outline: false });
        mesh.isPickable = false;
        this.meshes.push(mesh);
    }

    /** @param {string} name @param {number[]} position @param {number[]} dimensions @param {BABYLON.StandardMaterial} material */
    box(name, position, dimensions, material) {
        const mesh = BABYLON.MeshBuilder.CreateBox(name, { width: dimensions[0], height: dimensions[1], depth: dimensions[2] }, this.scene);
        mesh.position.set(position[0], position[1], position[2]);
        mesh.material = material;
        this.register(mesh);
        return mesh;
    }

    /** @param {string} value */
    setWall(value) {
        const colors = { white: '#ecebe7', beige: '#d7c4a9', lightGray: '#b9c1c2' };
        if (Object.hasOwn(colors, value)) this.wallMaterial.diffuseColor = BABYLON.Color3.FromHexString(colors[value]);
    }

    /** @param {string} value */
    setFloor(value) {
        if (Object.hasOwn(this.floorMaterials, value)) this.floor.material = this.floorMaterials[value];
    }

    dispose() {
        this.stopLightingSync();
        for (const mesh of this.meshes) World3D.removeObject(this.view, mesh);
        for (const material of this.materials) material.dispose(false, false);
        for (const texture of this.textures) texture.dispose();
        this.camera.dispose();
        this.scene.activeCamera = this.view.camera;
    }
}

